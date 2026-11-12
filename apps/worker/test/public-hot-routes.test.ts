import { afterEach, describe, expect, it, vi } from 'vitest';

const { computePublicStatusPayload } = vi.hoisted(() => ({
  computePublicStatusPayload: vi.fn(),
}));

vi.mock('../src/public/status', () => ({
  computePublicStatusPayload,
}));

import type { Env } from '../src/env';
import worker from '../src/index';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type WaitUntil = (promise: Promise<unknown>) => void;

function sampleStatusPayload(now = 1_728_000_000) {
  return {
    generated_at: now,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto',
    site_timezone: 'UTC',
    uptime_rating_level: 3,
    overall_status: 'up',
    banner: {
      source: 'monitors',
      status: 'operational',
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: {
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    },
    monitors: [],
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
  };
}

async function requestStatusViaWorker(opts: {
  handlers: FakeD1QueryHandler[];
  origin?: string;
  method?: string;
  path?: string;
  authorization?: string;
  envOverrides?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  waitUntil?: WaitUntil;
}) {
  const env = {
    DB: createFakeD1Database(opts.handlers),
    ADMIN_TOKEN: 'test-admin-token',
    ...opts.envOverrides,
  } as unknown as Env;

  const waitUntil = opts.waitUntil ?? vi.fn();

  const headers: Record<string, string> = {};
  if (opts.origin) {
    headers.Origin = opts.origin;
  }
  if (opts.authorization) {
    headers.Authorization = opts.authorization;
  }
  if (opts.extraHeaders) {
    Object.assign(headers, opts.extraHeaders);
  }

  const res = await worker.fetch(
    new Request(`https://status.example.com${opts.path ?? '/api/v1/public/status'}`, {
      method: opts.method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    }),
    env,
    { waitUntil } as unknown as ExecutionContext,
  );

  return { res, waitUntil };
}

describe('public hot routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    computePublicStatusPayload.mockReset();
  });

  it.each(['no-cache', 'max-age=0', 'no-store'])(
    'revalidates an explicit %s request against the source',
    async (policy) => {
      vi.spyOn(Date, 'now').mockReturnValue(200_000);
      const stale = sampleStatusPayload(190);
      const fresh = sampleStatusPayload(200);
      const match = vi.fn(
        async () =>
          new Response(JSON.stringify(stale), {
            headers: { 'X-Uptimer-Hot-Cached-At': '200', 'Cache-Control': 'public, max-age=15' },
          }),
      );
      const put = vi.fn();
      vi.stubGlobal('caches', { open: async () => ({ match, put }) });
      const { res } = await requestStatusViaWorker({
        extraHeaders: { 'Cache-Control': policy },
        handlers: [
          {
            match: 'from public_snapshots',
            first: () => ({ generated_at: 200, body_json: JSON.stringify(fresh) }),
          },
        ],
      });
      expect(await res.json()).toEqual(fresh);
      expect(match).not.toHaveBeenCalled();
      if (policy === 'no-store') expect(put).not.toHaveBeenCalled();
    },
  );

  it('serves the fresh public status snapshot via the hot router', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      origin: 'https://status-web.example.com',
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('Vary')).toContain('Origin');
    expect(await res.json()).toEqual(payload);
  });

  it('keeps Vary: Origin even when the request has no Origin header', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('computes status on snapshot miss and schedules a snapshot write', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(200);
    computePublicStatusPayload.mockResolvedValue(payload);

    const pending: Promise<unknown>[] = [];
    let writes = 0;

    const { res, waitUntil } = await requestStatusViaWorker({
      waitUntil: (promise) => pending.push(promise),
      handlers: [
        {
          match: 'from public_snapshots',
          first: () => null,
        },
        {
          match: 'insert into public_snapshots',
          run: () => {
            writes += 1;
            return 1;
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(computePublicStatusPayload).toHaveBeenCalledOnce();
    expect(waitUntil).toBeTypeOf('function');
    expect(pending.length).toBe(1);

    await Promise.allSettled(pending);
    expect(writes).toBe(1);
  });

  it('serves a bounded stale status snapshot before trying live compute', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const stale = sampleStatusPayload(100);
    computePublicStatusPayload.mockRejectedValue(new Error('boom'));

    const pending: Promise<unknown>[] = [];

    const { res } = await requestStatusViaWorker({
      waitUntil: (promise) => pending.push(promise),
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: stale.generated_at,
                  body_json: JSON.stringify(stale),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(stale);
    expect(computePublicStatusPayload).not.toHaveBeenCalled();
    expect(pending.length).toBe(0);
  });

  it('does not let an invalid stale status snapshot replace the original compute failure', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    computePublicStatusPayload.mockRejectedValue(new Error('boom'));

    const { res } = await requestStatusViaWorker({
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: 100,
                  body_json: JSON.stringify({ generated_at: 100 }),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'INTERNAL',
      },
    });
  });

  it('treats invalid Authorization on public status as private no-store', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      authorization: 'Bearer wrong-token',
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
  });

  it('treats invalid Authorization errors on public hot routes as private no-store', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    computePublicStatusPayload.mockRejectedValue(new Error('boom'));

    const { res } = await requestStatusViaWorker({
      authorization: 'Bearer wrong-token',
      handlers: [
        {
          match: 'from public_snapshots',
          first: () => null,
        },
      ],
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'INTERNAL',
      },
    });
  });

  it('redirects legacy public api paths to the versioned status route', async () => {
    const { res } = await requestStatusViaWorker({
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://status.example.com/api/v1/public/status');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('treats trace-tokenized preflight responses as private no-store', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      envOverrides: {
        UPTIMER_TRACE_TOKEN: 'expected-token',
      },
      extraHeaders: {
        'X-Uptimer-Trace': '1',
        'X-Uptimer-Trace-Token': 'expected-token',
      },
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('X-Uptimer-Trace-Token');
  });

  it('rejects non-GET methods on legacy GET-only public paths before redirecting', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('Location')).toBeNull();
  });

  it('treats invalid-auth GET-only rejections as private no-store before redirecting', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      authorization: 'Bearer wrong-token',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
  });

  it('rejects percent-encoded legacy GET-only public paths before redirecting them', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/public/%73tatus',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('Location')).toBeNull();
  });

  it('advertises GET-only preflight headers on legacy hot status paths', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('treats invalid-auth legacy redirects as private no-store', async () => {
    const { res } = await requestStatusViaWorker({
      path: '/api/public/status',
      origin: 'https://status-web.example.com',
      authorization: 'Bearer wrong-token',
      handlers: [],
    });

    expect(res.status).toBe(308);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
  });

  it('advertises GET-only preflight headers on percent-encoded public paths', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/v1/public/%68omepage',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('rejects percent-decoded public separators on GET-only hot paths', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/v1/public%2Fstatus',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('answers preflight requests for percent-decoded public separators with GET-only methods', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/v1/public%5Cstatus',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('advertises GET-only preflight headers on the public api root prefix', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/v1/public',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('normalizes repeated slashes on hot status paths without redirecting', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      path: '/api//v1/public//status//',
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });

  it('recognizes a valid Authorization token on public status and includes hidden monitors', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(200);
    computePublicStatusPayload.mockResolvedValue(payload);
    const match = vi.fn(
      async () =>
        new Response(JSON.stringify({ cached: true }), {
          headers: { 'X-Uptimer-Hot-Cached-At': '200', 'Cache-Control': 'public, max-age=15' },
        }),
    );
    vi.stubGlobal('caches', { open: async () => ({ match, put: vi.fn() }) });

    const { res } = await requestStatusViaWorker({
      authorization: 'Bearer test-admin-token',
      handlers: [],
    });

    expect(res.status).toBe(200);
    expect(computePublicStatusPayload).toHaveBeenCalledWith(expect.anything(), 200, {
      includeHiddenMonitors: true,
    });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(match).not.toHaveBeenCalled();
  });

  it('treats trace-tokenized hot-route reads as private no-store', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      envOverrides: {
        UPTIMER_TRACE_TOKEN: 'expected-token',
      },
      extraHeaders: {
        'X-Uptimer-Trace': '1',
        'X-Uptimer-Trace-Token': 'expected-token',
      },
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('X-Uptimer-Trace-Token');
  });

  it('does not emit trace headers when the trace token is missing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const payload = sampleStatusPayload(190);

    const { res } = await requestStatusViaWorker({
      envOverrides: {
        UPTIMER_TRACE_TOKEN: 'expected-token',
      },
      extraHeaders: {
        'X-Uptimer-Trace': '1',
      },
      handlers: [
        {
          match: 'from public_snapshots',
          first: (args) =>
            args[0] === 'status'
              ? {
                  generated_at: payload.generated_at,
                  body_json: JSON.stringify(payload),
                }
              : null,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace')).toBeNull();
    expect(res.headers.get('X-Uptimer-Trace-Id')).toBeNull();
  });

  it('rejects non-GET methods on the hot status endpoint', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
    expect(computePublicStatusPayload).not.toHaveBeenCalled();
  });

  it('keeps GET-only CORS methods aligned on hot status 405 responses', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('treats public health as a GET-only hot path for preflight responses', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/v1/public/health',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('returns the standard JSON error contract for unknown public api paths', async () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        open: vi.fn(async () => ({
          match: vi.fn(async () => undefined),
          put: vi.fn(async () => undefined),
        })),
      },
    });

    try {
      const { res } = await requestStatusViaWorker({
        path: '/api/v1/public/does-not-exist',
        handlers: [],
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: 'NOT_FOUND',
          message: 'Not Found',
        },
      });
    } finally {
      if (originalCaches === undefined) {
        delete (globalThis as { caches?: unknown }).caches;
      } else {
        Object.defineProperty(globalThis, 'caches', {
          configurable: true,
          value: originalCaches,
        });
      }
    }
  });

  it('rejects non-GET methods on the public health endpoint', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/v1/public/health',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('rejects non-GET methods on trailing-slash hot status paths', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'PATCH',
      path: '/api/v1/public/status/',
      handlers: [],
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
    expect(computePublicStatusPayload).not.toHaveBeenCalled();
  });

  it('advertises GET-only preflight headers on hot status paths', async () => {
    const { res } = await requestStatusViaWorker({
      method: 'OPTIONS',
      path: '/api/v1/public/status/',
      origin: 'https://status-web.example.com',
      handlers: [],
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });
});
