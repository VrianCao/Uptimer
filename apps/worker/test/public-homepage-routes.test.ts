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

  return app.fetch(
    new Request('https://status.example.com/api/v1/public/homepage'),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
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

  return app.fetch(
    new Request('https://status.example.com/api/v1/public/homepage-artifact'),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

async function requestHomepageViaApp(
  path: '/api/v1/public/homepage' | '/api/v1/public/homepage-artifact',
  handlers: FakeD1QueryHandler[],
  origin = 'https://status-web.example.com',
) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;

  return worker.fetch(
    new Request(`https://status.example.com${path}`, {
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

  it('serves homepage render artifacts from the artifact snapshot row', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot: payload,
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

  it('falls back to the legacy combined homepage row for artifacts during rollout', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot: payload,
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
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://status-web.example.com',
    );
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('preserves app-level CORS headers for homepage artifact responses', async () => {
    const payload = samplePayload(190);
    const render = {
      generated_at: payload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot: payload,
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
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://status-web.example.com',
    );
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('partitions cached homepage responses by Origin when app-level CORS reflection is enabled', async () => {
    const payload = samplePayload(190);
    const dbReads: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from public_snapshots',
        first: (args) => {
          dbReads.push(String(args[0]));
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
    expect(dbReads).toEqual(['homepage', 'homepage']);
  });

  it('serves a bounded stale homepage snapshot instead of computing in-request', async () => {
    const payload = samplePayload(100);
    vi.spyOn(Date, 'now').mockReturnValue(200_000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          body_json: JSON.stringify(payload),
        }),
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=0, stale-while-revalidate=0, stale-if-error=0',
    );
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

  it('reuses fresh artifact history previews when the full homepage snapshot is missing', async () => {
    const now = 200;
    const homepagePayload = {
      ...samplePayload(190),
      bootstrap_mode: 'partial' as const,
      resolved_incident_preview: {
        id: 9,
        title: 'Old incident',
        status: 'resolved' as const,
        impact: 'minor' as const,
        message: null,
        started_at: 100,
        resolved_at: 120,
      },
      maintenance_history_preview: {
        id: 7,
        title: 'Old maintenance',
        message: null,
        starts_at: 80,
        ends_at: 90,
        monitor_ids: [1],
      },
    };
    const render = {
      generated_at: homepagePayload.generated_at,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot: homepagePayload,
      meta_title: 'Status Hub',
      meta_description: 'Production services',
    };

    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
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

          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: 190,
              body_json: JSON.stringify(render),
            };
          }

          return null;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resolved_incident_preview: homepagePayload.resolved_incident_preview,
      maintenance_history_preview: homepagePayload.maintenance_history_preview,
    });
  });

  it('falls back to live history preview queries when fresh artifact previews are blank', async () => {
    const now = 200;
    const render = {
      generated_at: 190,
      preload_html: '<div id="uptimer-preload">hello</div>',
      snapshot: {
        ...samplePayload(190),
        bootstrap_mode: 'partial' as const,
      },
      meta_title: 'Status Hub',
      meta_description: 'Production services',
    };

    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const res = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
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

          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: 190,
              body_json: JSON.stringify(render),
            };
          }

          return null;
        },
      },
      {
        match: 'from incidents',
        all: () => [
          {
            id: 9,
            title: 'Old incident',
            status: 'resolved',
            impact: 'minor',
            message: null,
            started_at: 100,
            resolved_at: 120,
          },
        ],
      },
      {
        match: 'from incident_monitors',
        all: () => [{ incident_id: 9, monitor_id: 1 }],
      },
      {
        match: 'select id from monitors',
        all: () => [{ id: 1 }],
      },
      {
        match: 'from maintenance_windows',
        all: () => [
          {
            id: 7,
            title: 'Old maintenance',
            message: null,
            starts_at: 80,
            ends_at: 90,
            created_at: 70,
          },
        ],
      },
      {
        match: 'from maintenance_window_monitors',
        all: () => [{ maintenance_window_id: 7, monitor_id: 1 }],
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resolved_incident_preview: {
        id: 9,
        title: 'Old incident',
      },
      maintenance_history_preview: {
        id: 7,
        title: 'Old maintenance',
      },
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
