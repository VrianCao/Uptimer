import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { computePublicStatusPayload } from '../src/public/status';

function fixture() {
  const data = createSqliteD1();
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response('{"published":true}', {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=0, s-maxage=15, must-revalidate',
        },
      }),
  );
  const getByName = vi.fn().mockReturnValue({ fetch });
  const env = { DB: data.db, ADMIN_TOKEN: 'test', SELF: {}, COORDINATOR: { getByName } } as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as ExecutionContext;
  return { ...data, fetch, getByName, env, ctx, pending };
}
describe('public coordinator gateway', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('forwards management reads and writes through the same authorization path', async () => {
    const f = fixture();
    try {
      const { COORDINATOR: _, ...localEnv } = f.env;
      f.fetch.mockImplementation((request: Request) => worker.fetch(request, localEnv, f.ctx));
      const denied = await worker.fetch(
        new Request('https://uptimer.example/api/v1/admin/monitors'),
        f.env,
        f.ctx,
      );
      expect(denied.status).toBe(401);
      const allowed = await worker.fetch(
        new Request('https://uptimer.example/api/v1/admin/monitors', {
          headers: { Authorization: 'Bearer test' },
        }),
        f.env,
        f.ctx,
      );
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ monitors: [], next_cursor: null });
      const invalid = await worker.fetch(
        new Request('https://uptimer.example/api/v1/admin/monitors', {
          method: 'POST',
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
          body: '{}',
        }),
        f.env,
        f.ctx,
      );
      expect(invalid.status).toBe(400);
      expect(f.fetch).toHaveBeenCalledTimes(3);
    } finally {
      f.sqlite.close();
    }
  });
  it('preserves the edge cache and forwards explicit revalidation', async () => {
    const f = fixture();
    const cache = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (req: Request) => cache.get(req.url)?.clone(),
        put: async (req: Request, response: Response) => {
          cache.set(req.url, response);
        },
      }),
    });
    try {
      const url = 'https://uptimer.example/api/v1/public/homepage';
      const first = await worker.fetch(new Request(url), f.env, f.ctx);
      await Promise.all(f.pending);
      expect(await first.json()).toEqual({ published: true });
      expect(await (await worker.fetch(new Request(url), f.env, f.ctx)).json()).toEqual({
        published: true,
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      const request = new Request(url, { headers: { 'Cache-Control': 'no-cache' } });
      await worker.fetch(request, f.env, f.ctx);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.fetch.mock.calls[1]![0]).toBe(request);
      expect(f.queries).toHaveLength(0);
    } finally {
      f.sqlite.close();
    }
  });
  it('keeps the original method and malformed parameter responses', async () => {
    const f = fixture();
    try {
      const { COORDINATOR: _, ...localEnv } = f.env;
      f.fetch.mockImplementation((request: Request) => worker.fetch(request, localEnv, f.ctx));
      for (const [path, method, status] of [
        ['/api/v1/public/homepage', 'POST', 405],
        ['/api/v1/public/monitors/invalid/latency?format=compact-v1', 'GET', 400],
        ['/api/v1/public/monitors/1/latency?format=wrong', 'GET', 400],
      ] as const) {
        const response = await worker.fetch(
          new Request('https://uptimer.example' + path, {
            method,
            headers: { 'Cache-Control': 'no-store' },
          }),
          f.env,
          f.ctx,
        );
        expect(response.status).toBe(status);
      }
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      f.sqlite.close();
    }
  });
  it('does not retry a mutation after an ambiguous coordinator failure', async () => {
    const f = fixture();
    try {
      f.fetch.mockRejectedValue(new Error('connection closed after write'));
      const response = await worker.fetch(
        new Request('https://uptimer.example/api/v1/admin/monitors', {
          method: 'POST',
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
          body: '{}',
        }),
        f.env,
        f.ctx,
      );
      expect(response.status).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.calls).toHaveLength(0);
    } finally {
      f.sqlite.close();
    }
  });
  it('serves the validated D1 snapshot after a coordinator connection failure', async () => {
    const f = fixture();
    try {
      const now = Math.floor(Date.now() / 1000);
      const payload = await computePublicStatusPayload(f.db, now);
      f.sqlite
        .prepare(
          "INSERT INTO public_snapshots(key,generated_at,body_json,updated_at)VALUES('status',?,?,?)",
        )
        .run(now, JSON.stringify(payload), now);
      f.fetch.mockRejectedValue(new Error('coordinator restarting'));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const response = await worker.fetch(
        new Request('https://uptimer.example/api/v1/public/status', {
          headers: { 'Cache-Control': 'no-store' },
        }),
        f.env,
        f.ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(payload);
      expect(warning).toHaveBeenCalledWith(
        'public coordinator read failed; reading D1',
        expect.any(Error),
      );
    } finally {
      f.sqlite.close();
    }
  });
});
