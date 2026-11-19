import { describe, it, vi, expect } from 'vitest';
vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi
    .fn()
    .mockResolvedValue({ status: 'up', latencyMs: 42, httpStatus: 200, error: null, attempts: 1 }),
}));
vi.mock('../src/monitor/tcp', () => ({ runTcpCheck: vi.fn() }));
import worker from '../src/index';
import { runHttpCheck } from '../src/monitor/http';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/env';
import { runCoordinatedInvocation } from '../src/internal/coordinated-execution';
function counted(db: D1Database, counter: { n: number }): D1Database {
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, k) {
        if (k === 'bind') return (...args: unknown[]) => wrap(t.bind(...args));
        const v = Reflect.get(t, k, t);
        if (['all', 'run', 'first', 'raw'].includes(String(k)))
          return (...args: unknown[]) => {
            counter.n++;
            return v.apply(t, args);
          };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      const v = Reflect.get(t, k, t);
      if (k === 'batch')
        return (...args: unknown[]) => {
          counter.n++;
          return v.apply(t, args);
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
describe('isolated coordinator D1 invocation accounting', () => {
  it.each(['free', 'paid'] as const)(
    'measures %s cold, warm, midnight and retention with real production SQL',
    async (runtime) => {
      let inFlight = 0;
      let maxInFlight = 0;
      vi.mocked(runHttpCheck).mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {
          status: 'up',
          latencyMs: 42,
          httpStatus: 200,
          error: null,
          attempts: 1,
        };
      });
      const { db, sqlite } = createSqliteD1();
      const profile = Object.fromEntries(
        [
          ...readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').matchAll(
            /^(UPTIMER_\w+) = "([^"]*)"/gm,
          ),
        ].map((m) => [m[1], m[2]]),
      );
      const start = Date.UTC(2026, 10, 2, 12) / 1000;
      let clock = start;
      vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000);
      vi.stubGlobal('caches', {
        open: async () => ({ match: async () => undefined, put: async () => undefined }),
      });
      for (let id = 1; id <= 30; id++)
        sqlite
          .prepare(
            "INSERT INTO monitors(id,name,type,target,created_at,updated_at)VALUES(?,?,'http','https://example.com',?,?)",
          )
          .run(id, 'Test ' + id, start - 86400 * 90, start - 86400 * 90);
      const allCounters: { n: number }[] = [];
      const invoke = async <T>(
        task: (env: Env, ctx: ExecutionContext) => Promise<T>,
      ): Promise<T> => {
        const counter = { n: 0 };
        allCounters.push(counter);
        const env = {
          DB: counted(db, counter),
          ADMIN_TOKEN: 'test',
          ...profile,
          UPTIMER_RUNTIME_PROFILE: runtime,
          ...(runtime === 'paid'
            ? {
                COORDINATOR: {
                  getByName: () => {
                    throw new Error('Unexpected Paid DO call');
                  },
                },
              }
            : {}),
          UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE: '5',
          UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE: '10',
        } as Env;
        env.SELF = {
          fetch: (input: RequestInfo, init?: RequestInit) =>
            invoke(async (childEnv, childCtx) => {
              const request = input instanceof Request && !init ? input : new Request(input, init);
              const response = await worker.fetch(request, childEnv, childCtx);
              if (!response.ok)
                throw new Error(
                  new URL(request.url).pathname +
                    ' ' +
                    response.status +
                    ' ' +
                    (await response.text()),
                );
              return response;
            }),
        } as Fetcher;
        if (runtime === 'paid') {
          const pending: Promise<unknown>[] = [];
          const ctx = {
            waitUntil: (task: Promise<unknown>) => pending.push(task),
          } as ExecutionContext;
          const result = await task(env, ctx);
          for (let offset = 0; offset < pending.length; ) {
            const work = pending.slice(offset);
            offset = pending.length;
            await Promise.all(work);
          }
          return result;
        }
        return runCoordinatedInvocation(
          {
            env,
            fetch: (request, localEnv, ctx) => worker.fetch(request, localEnv, ctx),
            dispatch: (request) =>
              invoke((childEnv, childCtx) => worker.fetch(request, childEnv, childCtx)),
            waitUntil: (promise) => {
              void promise.catch(() => undefined);
            },
          },
          task,
          true,
        );
      };
      try {
        for (const [label, now] of [
          ['cold', start],
          ['warm', start + 60],
          ['midnight', Date.UTC(2026, 10, 3) / 1000],
          ['retention', Date.UTC(2026, 10, 3, 0, 30) / 1000],
        ] as const) {
          clock = now;
          allCounters.length = 0;
          await invoke((env, ctx) =>
            worker.scheduled(
              { cron: '* * * * *', scheduledTime: now * 1000 } as ScheduledController,
              env,
              ctx,
            ),
          );
          const row = sqlite
            .prepare("SELECT generated_at FROM public_snapshots WHERE key='homepage'")
            .get();
          expect(allCounters.length + 1, label + ' invocation tree').toBeLessThanOrEqual(32);
          expect(Math.max(...allCounters.map((c) => c.n)), label + ' D1 calls').toBeLessThanOrEqual(
            50,
          );
          expect(row?.generated_at, label + ' published source time').toBe(now);
          expect(
            sqlite
              .prepare('SELECT count(*) AS n FROM monitor_state WHERE last_checked_at=?')
              .get(now)?.n,
          ).toBe(30);
          console.log(
            JSON.stringify({
              label,
              invocations: allCounters.length + 1,
              maxQueries: Math.max(...allCounters.map((c) => c.n)),
            }),
          );
        }
        if (runtime === 'paid') {
          const request = (path: string, body?: unknown) =>
            invoke((env, ctx) =>
              worker.fetch(
                new Request('https://synthetic.example/api/v1/' + path, {
                  method: body ? 'POST' : 'GET',
                  headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
                  ...(body ? { body: JSON.stringify(body) } : {}),
                }),
                env,
                ctx,
              ),
            );
          for (const path of [
            'public/homepage',
            'public/status',
            'public/homepage-artifact',
            'public/monitors/1/latency?range=24h',
            'admin/monitors',
          ]) {
            expect((await request(path)).status, path).toBe(200);
          }
          expect(
            (
              await request('admin/incidents', {
                title: 'Paid write',
                status: 'investigating',
                impact: 'minor',
                monitor_ids: [1],
              })
            ).status,
          ).toBe(201);
          expect(
            sqlite.prepare("SELECT count(*) AS n FROM incidents WHERE title='Paid write'").get()?.n,
          ).toBe(1);
        }
      } finally {
        sqlite.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );
});
