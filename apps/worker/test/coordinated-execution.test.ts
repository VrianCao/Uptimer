import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { runCoordinatedInvocation } from '../src/internal/coordinated-execution';

function fixture() {
  const dispatch = vi.fn().mockResolvedValue(new Response('child'));
  const fetch = vi.fn().mockResolvedValue(new Response('local'));
  const service = vi.fn().mockResolvedValue(new Response('service'));
  const background: Promise<unknown>[] = [];
  const env = { ADMIN_TOKEN: 'test', SELF: { fetch: service }, COORDINATOR: {} } as Env;
  return {
    env,
    dispatch,
    fetch,
    service,
    background,
    waitUntil: (task: Promise<unknown>) => {
      background.push(task);
      void task.catch(() => undefined);
    },
  };
}
describe('site coordinator event scopes', () => {
  it('retains bounded child events and keeps cohort bookkeeping local', async () => {
    const f = fixture();
    await runCoordinatedInvocation(
      f,
      async (env, ctx) => {
        expect(env.COORDINATOR).toBeUndefined();
        for (const path of [
          'scheduled/check-batch',
          'continue/sharded-public-snapshot',
          'maintenance',
        ])
          await env.SELF!.fetch(new Request('http://internal/api/v1/internal/' + path));
        const cohort = new Request('http://internal/api/v1/internal/scheduled/check-batches');
        await env.SELF!.fetch(cohort);
        expect(f.fetch).toHaveBeenCalledWith(cohort, env, ctx);
        await env.SELF!.fetch('https://external.example/api/v1/internal/maintenance');
        await env.SELF!.fetch('http://internal/api/v1/internal/legacy-refresh');
      },
      true,
    );
    expect(f.dispatch).toHaveBeenCalledTimes(3);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.service).toHaveBeenCalledTimes(2);
  });
  it('drains dynamically registered stages and reports a background rejection', async () => {
    const f = fixture();
    const finished: string[] = [];
    const work = runCoordinatedInvocation(
      f,
      async (_env, ctx) => {
        ctx.waitUntil(
          Promise.resolve().then(() => {
            finished.push('first');
            ctx.waitUntil(
              Promise.resolve().then(() => {
                finished.push('second');
                throw new Error('stage failed');
              }),
            );
          }),
        );
        return 'response';
      },
      true,
    );
    await expect(work).rejects.toThrow('stage failed');
    expect(finished).toEqual(['first', 'second']);
    expect(f.background).toHaveLength(2);
  });
  it('returns a public response while background work is still pending', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const response = await runCoordinatedInvocation(
      f,
      async (_env, ctx) => {
        ctx.waitUntil(
          gate.then(() => {
            finished = true;
          }),
        );
        return new Response('ready');
      },
      false,
    );
    expect(await response.text()).toBe('ready');
    expect(finished).toBe(false);
    expect(f.background).toHaveLength(1);
    release();
    await Promise.all(f.background);
    expect(finished).toBe(true);
  });
});
