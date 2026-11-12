import type { Env } from '../env';

const COHORT_PATH = '/api/v1/internal/scheduled/check-batches';
const EVENT_PATHS = new Set([
  '/api/v1/internal/scheduled/check-batch',
  '/api/v1/internal/continue/sharded-public-snapshot',
  '/api/v1/internal/maintenance',
]);

type Dependencies = {
  env: Env;
  waitUntil: (task: Promise<unknown>) => void;
  dispatch: (request: Request) => Promise<Response>;
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
};

// Keep each D1-heavy stage in its own event. Combining the whole pipeline in
// one event exceeds Free's 50-query ceiling during bootstrap and at midnight.
// State, leases and idempotency remain in D1; this scope owns only live work.
export async function runCoordinatedInvocation<T>(
  dependencies: Dependencies,
  task: (env: Env, ctx: ExecutionContext) => Promise<T>,
  drain: boolean,
): Promise<T> {
  const { env } = dependencies;
  if (!env.SELF) throw new Error('Coordinator requires the SELF binding');
  const pending: Promise<unknown>[] = [];
  const context: ExecutionContext = {
    props: {},
    passThroughOnException() {
      throw new Error('passThroughOnException is unavailable in the coordinator');
    },
    waitUntil(promise) {
      pending.push(promise);
      dependencies.waitUntil(promise);
    },
  };
  const self = new Proxy(env.SELF, {
    get(target, key) {
      if (key === 'fetch')
        return (input: RequestInfo, init?: RequestInit) => {
          const request = input instanceof Request && !init ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.hostname === 'internal') {
            // Cohorts only dispatch children. A new event for these three
            // bookkeeping calls would consume the invocation budget needlessly.
            if (url.pathname === COHORT_PATH) return dependencies.fetch(request, localEnv, context);
            if (EVENT_PATHS.has(url.pathname)) return dependencies.dispatch(request);
          }
          return target.fetch(input, init);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Prevent scheduled dispatch and public reads from re-entering this same
  // outer coordinator gateway. SELF still starts bounded child events.
  const { COORDINATOR: _coordinator, ...bindings } = env;
  const localEnv: Env = { ...bindings, SELF: self };
  const result = await task(localEnv, context);
  if (drain) {
    let offset = 0;
    const failures: unknown[] = [];
    while (offset < pending.length) {
      const current = pending.slice(offset);
      offset = pending.length;
      for (const settled of await Promise.allSettled(current))
        if (settled.status === 'rejected') failures.push(settled.reason);
    }
    if (failures.length) throw failures[0];
  }
  return result;
}
