import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi.fn(),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));

import type { Env } from '../src/env';
import { handleError, handleNotFound } from '../src/middleware/errors';
import worker from '../src/index';
import { publicRoutes } from '../src/routes/public';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type CacheStore = Map<string, Response>;

function installCacheMock(store: CacheStore) {
  const open = vi.fn(async () => ({
    async match(request: Request) {
      const cached = store.get(request.url);
      return cached ? cached.clone() : undefined;
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response.clone());
    },
  }));

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { open },
  });
}

async function requestHomepage(handlers: FakeD1QueryHandler[]) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.route('/api/v1/public', publicRoutes);

  return app.fetch(new Request('https://status.example.com/api/v1/public/homepage'), env, {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext);
}

async function requestHomepageArtifact(handlers: FakeD1QueryHandler[]) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.route('/api/v1/public', publicRoutes);

  return app.fetch(new Request('https://status.example.com/api/v1/public/homepage-artifact'), env, {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext);
}

async function requestHomepageViaApp(
  path:
    | '/api/v1/public/homepage'
    | '/api/v1/public/homepage/'
    | '/api/v1/public/homepage-artifact'
    | '/api/v1/public/homepage-artifact/',
  handlers: FakeD1QueryHandler[],
  origin = 'https://status-web.example.com',
  method = 'GET',
) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;

  return worker.fetch(
    new Request(`https://status.example.com${path}`, {
      method,
      headers: { Origin: origin },
    }),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

function samplePayload(now = 1_728_000_000) {
  return {
    generated_at: now,
    bootstrap_mode: 'full',
    monitor_count_total: 0,
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
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

describe('public homepage route', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  beforeEach(() => {
    installCacheMock(new Map());
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    }
    vi.restoreAllMocks();
  });

  it('serves a fresh homepage snapshot without live compute', async () => {
    const payload = samplePayload(190);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('serves a bounded stale homepage snapshot before falling back to live compute', async () => {
    const payload = samplePayload(100);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                updated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=0');
    expect(await res.json()).toEqual(payload);
  });

  it('prefers a fresh artifact snapshot over a stale homepage payload row', async () => {
    const stalePayload = samplePayload(100);
    const freshPayload = samplePayload(190);
    const render = {
      generated_at: freshPayload.generated_at,
      preload_html: '<div id="uptimer-preload">fresh</div>',
      snapshot_json: JSON.stringify(freshPayload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage') {
            return {
              generated_at: stalePayload.generated_at,
              updated_at: stalePayload.generated_at,
              body_json: JSON.stringify(stalePayload),
            };
          }
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: freshPayload.generated_at,
              updated_at: freshPayload.generated_at,
              body_json: JSON.stringify(render),
            };
          }
          return null;
        },
        all: () => [
          {
            key: 'homepage',
            generated_at: stalePayload.generated_at,
            updated_at: stalePayload.generated_at,
            body_json: JSON.stringify(stalePayload),
          },
          {
            key: 'homepage:artifact',
            generated_at: freshPayload.generated_at,
            updated_at: freshPayload.generated_at,
            body_json: JSON.stringify(render),
          },
        ],
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(freshPayload);
  });

  it('serves homepage render artifacts from the artifact snapshot row', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageArtifact([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(render);
  });

  it('keeps current artifact rows available when their body generation is old but updated_at is fresh', async () => {
    const payload = samplePayload(100);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    const res = await requestHomepageArtifact([
      {
        match: (sql) =>
          sql.includes('select generated_at, updated_at') &&
          sql.includes('from public_snapshots') &&
          !sql.includes('body_json'),
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                updated_at: 995,
              }
            : null,
      },
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                updated_at: 995,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(render);
  });

  it('falls back to the legacy combined homepage row for artifacts during rollout', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageArtifact([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify({
                  version: 2,
                  data: payload,
                  render,
                }),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(render);
  });

  it('preserves app-level CORS headers for homepage snapshot responses', async () => {
    const payload = samplePayload(190);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('preserves app-level CORS headers for homepage artifact responses', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage-artifact', [
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('falls back to the legacy combined homepage row for artifacts when the artifact row is invalid', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageArtifact([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: payload.generated_at,
              body_json:
                '{"generated_at":190,"preload_html":"<div>bad</div>","snapshot":{"generated_at":190',
            };
          }
          if (args[0] === 'homepage') {
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify({
                version: 2,
                data: payload,
                render,
              }),
            };
          }
          return null;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(render);
  });

  it('reads homepage payloads from artifact snapshots on the direct public route', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('falls back to the homepage payload row when the artifact row is invalid', async () => {
    const payload = samplePayload(190);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: payload.generated_at,
              body_json:
                '{"generated_at":190,"preload_html":"<div>bad</div>","snapshot":{"generated_at":190',
            };
          }
          if (args[0] === 'homepage') {
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            };
          }
          return null;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('caches anonymous homepage responses per reflected Origin', async () => {
    const payload = samplePayload(190);
    let metadataReads = 0;
    const bodyReads: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'select key, generated_at, updated_at from public_snapshots',
        all: () => {
          metadataReads += 1;
          return [
            {
              key: 'homepage',
              generated_at: payload.generated_at,
              updated_at: payload.generated_at,
            },
          ];
        },
      },
      {
        match: 'from public_snapshots',
        first: (args) => {
          bodyReads.push(String(args[0]));
          return args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null;
        },
      },
    ];

    const first = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );
    const second = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://two.example.com',
    );
    const third = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );

    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('https://one.example.com');
    expect(second.headers.get('Access-Control-Allow-Origin')).toBe('https://two.example.com');
    expect(third.headers.get('Access-Control-Allow-Origin')).toBe('https://one.example.com');
    expect(metadataReads).toBe(0);
    expect(bodyReads).toEqual(['homepage', 'homepage']);
  });

  it('stores hot-cache fresh entries longer while restoring client cache headers', async () => {
    const store = new Map<string, Response>();
    installCacheMock(store);
    const payload = samplePayload(190);
    const bodyReads: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(200 * 1000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from public_snapshots',
        first: (args) => {
          bodyReads.push(String(args[0]));
          return args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null;
        },
      },
    ];

    const first = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );
    const originalCacheControl = first.headers.get('Cache-Control');
    expect(first.status).toBe(200);
    expect(originalCacheControl).toContain('max-age=30');

    await Promise.resolve();
    const freshEntry = [...store.entries()].find(
      ([key]) => !key.includes('__uptimer_stale_cache_key'),
    );
    expect(freshEntry).toBeTruthy();
    expect(freshEntry?.[1].headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(freshEntry?.[1].headers.get('X-Uptimer-Hot-Original-Cache-Control')).toBe(
      originalCacheControl,
    );

    const second = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );

    expect(second.headers.get('Cache-Control')).toBe(originalCacheControl);
    expect(second.headers.get('X-Uptimer-Hot-Original-Cache-Control')).toBeNull();
    expect(await second.json()).toEqual(payload);
    expect(bodyReads).toEqual(['homepage']);
  });

  it('serves a bounded stale hot-cache copy when the fresh worker cache entry misses', async () => {
    const store = new Map<string, Response>();
    installCacheMock(store);
    const payload = samplePayload(190);
    const bodyReads: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(200 * 1000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from public_snapshots',
        first: (args) => {
          bodyReads.push(String(args[0]));
          return args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null;
        },
      },
    ];

    const first = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(payload);

    await Promise.resolve();
    const freshKey = [...store.keys()].find((key) => !key.includes('__uptimer_stale_cache_key'));
    const staleKey = [...store.keys()].find((key) => key.includes('__uptimer_stale_cache_key'));
    expect(freshKey).toBeTruthy();
    expect(staleKey).toBeTruthy();
    store.delete(freshKey!);

    const second = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      handlers,
      'https://one.example.com',
    );

    expect(second.status).toBe(200);
    expect(second.headers.get('X-Uptimer-Hot-Cached-At')).toBeNull();
    expect(second.headers.get('Cache-Control')).toContain('max-age=0');
    expect(await second.json()).toEqual(payload);
    expect(bodyReads).toEqual(['homepage']);
  });

  it('serves a fresh homepage snapshot at the max-age boundary via the worker hot path', async () => {
    const payload = samplePayload(140);
    let metadataReads = 0;
    const bodyReads: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(200 * 1000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'select key, generated_at, updated_at from public_snapshots',
        all: () => {
          metadataReads += 1;
          return [
            {
              key: 'homepage',
              generated_at: payload.generated_at,
              updated_at: payload.generated_at,
            },
          ];
        },
      },
      {
        match: 'from public_snapshots',
        first: (args) => {
          bodyReads.push(String(args[0]));
          return args[0] === 'homepage'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(payload),
              }
            : null;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(metadataReads).toBe(0);
    expect(bodyReads).toEqual(['homepage', 'homepage']);
    expect(res.headers.get('Cache-Control')).toContain('max-age=0');
  });

  it('normalizes artifact snapshots to homepage payloads via the worker hot path', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot_json: JSON.stringify(payload),
      meta_title: 'Uptimer',
      meta_description: 'All Systems Operational',
    };
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('falls back to the homepage payload row via the worker hot path when the artifact row is invalid', async () => {
    const payload = samplePayload(190);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepageViaApp('/api/v1/public/homepage', [
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: payload.generated_at,
              body_json:
                '{"generated_at":190,"preload_html":"<div>bad</div>","snapshot":{"generated_at":190',
            };
          }
          if (args[0] === 'homepage') {
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            };
          }
          return null;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('rejects non-GET methods on the worker hot homepage endpoint', async () => {
    const res = await requestHomepageViaApp(
      '/api/v1/public/homepage',
      [],
      'https://status-web.example.com',
      'POST',
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('rejects non-GET methods on trailing-slash worker hot homepage endpoints', async () => {
    const res = await requestHomepageViaApp(
      '/api/v1/public/homepage/',
      [],
      'https://status-web.example.com',
      'POST',
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('rejects non-GET methods on the worker hot homepage artifact endpoint', async () => {
    const res = await requestHomepageViaApp(
      '/api/v1/public/homepage-artifact',
      [],
      'https://status-web.example.com',
      'DELETE',
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('falls back to the fresh public status snapshot when the full homepage snapshot is missing', async () => {
    const now = 200;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'status'
            ? {
                generated_at: 190,
                body_json: JSON.stringify({
                  generated_at: 190,
                  site_title: 'Status Hub',
                  site_description: 'Production services',
                  site_locale: 'en',
                  site_timezone: 'UTC',
                  uptime_rating_level: 4,
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
                  monitors: [
                    {
                      id: 1,
                      name: 'API',
                      type: 'http',
                      group_name: null,
                      group_sort_order: 0,
                      sort_order: 0,
                      uptime_rating_level: 4,
                      status: 'up',
                      is_stale: false,
                      last_checked_at: 180,
                      last_latency_ms: 42,
                      heartbeats: [{ checked_at: 180, status: 'up', latency_ms: 42 }],
                      uptime_30d: {
                        range_start_at: 0,
                        range_end_at: 190,
                        total_sec: 190,
                        downtime_sec: 0,
                        unknown_sec: 0,
                        uptime_sec: 190,
                        uptime_pct: 100,
                      },
                      uptime_days: [
                        {
                          day_start_at: 0,
                          total_sec: 190,
                          downtime_sec: 0,
                          unknown_sec: 0,
                          uptime_sec: 190,
                          uptime_pct: 100,
                        },
                      ],
                    },
                  ],
                  active_incidents: [],
                  maintenance_windows: {
                    active: [],
                    upcoming: [],
                  },
                }),
              }
            : null,
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generated_at: 190,
      monitor_count_total: 1,
      uptime_rating_level: 4,
      monitors: [
        {
          id: 1,
          heartbeat_strip: {
            checked_at: [180],
            status_codes: 'u',
            latency_ms: [42],
          },
        },
      ],
    });
  });

  it('ignores future-dated homepage snapshot rows on the worker route and falls back to status composition', async () => {
    const now = 200;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage') {
            return {
              generated_at: now + 600,
              body_json: JSON.stringify(samplePayload(now + 600)),
            };
          }
          if (args[0] === 'status') {
            return {
              generated_at: 190,
              body_json: JSON.stringify({
                generated_at: 190,
                site_title: 'Status Hub',
                site_description: 'Production services',
                site_locale: 'en',
                site_timezone: 'UTC',
                uptime_rating_level: 4,
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
                monitors: [
                  {
                    id: 1,
                    name: 'API',
                    type: 'http',
                    group_name: null,
                    group_sort_order: 0,
                    sort_order: 0,
                    uptime_rating_level: 4,
                    status: 'up',
                    is_stale: false,
                    last_checked_at: 180,
                    last_latency_ms: 42,
                    heartbeats: [{ checked_at: 180, status: 'up', latency_ms: 42 }],
                    uptime_30d: {
                      range_start_at: 0,
                      range_end_at: 190,
                      total_sec: 190,
                      downtime_sec: 0,
                      unknown_sec: 0,
                      uptime_sec: 190,
                      uptime_pct: 100,
                    },
                    uptime_days: [
                      {
                        day_start_at: 0,
                        total_sec: 190,
                        downtime_sec: 0,
                        unknown_sec: 0,
                        uptime_sec: 190,
                        uptime_pct: 100,
                      },
                    ],
                  },
                ],
                active_incidents: [],
                maintenance_windows: {
                  active: [],
                  upcoming: [],
                },
              }),
            };
          }
          return null;
        },
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
    ]);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      generated_at: 190,
      monitor_count_total: 1,
      site_title: 'Status Hub',
    });
  });

  it('serves trailing-slash homepage requests when the hot snapshot path misses', async () => {
    const now = 200;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'status'
            ? {
                generated_at: 190,
                body_json: JSON.stringify({
                  generated_at: 190,
                  site_title: 'Status Hub',
                  site_description: 'Production services',
                  site_locale: 'en',
                  site_timezone: 'UTC',
                  uptime_rating_level: 4,
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
                  monitors: [
                    {
                      id: 1,
                      name: 'API',
                      type: 'http',
                      group_name: null,
                      group_sort_order: 0,
                      sort_order: 0,
                      uptime_rating_level: 4,
                      status: 'up',
                      is_stale: false,
                      last_checked_at: 180,
                      last_latency_ms: 42,
                      heartbeats: [{ checked_at: 180, status: 'up', latency_ms: 42 }],
                      uptime_30d: {
                        range_start_at: 0,
                        range_end_at: 190,
                        total_sec: 190,
                        downtime_sec: 0,
                        unknown_sec: 0,
                        uptime_sec: 190,
                        uptime_pct: 100,
                      },
                      uptime_days: [
                        {
                          day_start_at: 0,
                          total_sec: 190,
                          downtime_sec: 0,
                          unknown_sec: 0,
                          uptime_sec: 190,
                          uptime_pct: 100,
                        },
                      ],
                    },
                  ],
                  active_incidents: [],
                  maintenance_windows: {
                    active: [],
                    upcoming: [],
                  },
                }),
              }
            : null,
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
    ];

    const res = await requestHomepageViaApp('/api/v1/public/homepage/', handlers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generated_at: 190,
      monitor_count_total: 1,
      monitors: [
        {
          id: 1,
        },
      ],
    });
  });

  it('returns 503 when no homepage snapshot is available', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: () => null,
      },
    ]);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'UNAVAILABLE',
      },
    });
  });
});
