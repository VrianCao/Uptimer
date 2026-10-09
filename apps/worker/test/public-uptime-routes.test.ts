import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
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

  return open;
}

async function requestPublic(
  path: string,
  handlers: FakeD1QueryHandler[],
  opts: { adminToken?: string; authorization?: string } = {},
) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: opts.adminToken ?? 'test-admin-token',
  } as unknown as Env;
  const res = await publicRoutes.fetch(
    new Request(`https://status.example.com${path}`, {
      headers: opts.authorization ? { Authorization: opts.authorization } : undefined,
    }),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

describe('public routes uptime regression', () => {
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

  it('keeps monitor uptime window start for existing monitors instead of snapping to first in-range probe', async () => {
    const rangeEnd = 1_728_000_000;
    const rangeStart = rangeEnd - 86_400;
    const firstInRangeCheckAt = rangeStart + 80_000;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 15_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        first: () => ({
          id: 12,
          name: 'Legacy Monitor',
          interval_sec: 60,
          created_at: rangeStart - 5 * 86_400,
          last_checked_at: rangeEnd - 30,
        }),
      },
      {
        match: 'from check_results',
        all: () => [
          { checked_at: rangeStart - 60, status: 'up' },
          { checked_at: firstInRangeCheckAt, status: 'up' },
        ],
      },
      {
        match: 'from outages',
        all: () => [
          {
            started_at: rangeStart + 600,
            ended_at: rangeStart + 900,
          },
        ],
      },
    ];

    const { res, body } = await requestPublic('/monitors/12/uptime?range=24h', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec: 86_400,
      downtime_sec: 300,
    });
  });

  it('keeps partial-day totals for existing monitors in public uptime overview', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;
    const firstInRangeCheckAt = dayStart + 1_800;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            interval_sec: 60,
            created_at: dayStart - 10 * 86_400,
            last_checked_at: rangeEnd - 30,
          },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'from check_results',
        all: () => [
          { checked_at: dayStart - 60, status: 'up' },
          { checked_at: firstInRangeCheckAt, status: 'up' },
        ],
      },
      {
        match: 'from outages',
        all: () => [
          {
            started_at: dayStart + 300,
            ended_at: dayStart + 600,
          },
        ],
      },
    ];

    const { res, body } = await requestPublic('/analytics/uptime?range=30d', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      range_end_at: rangeEnd,
      overall: {
        total_sec: 3_600,
        downtime_sec: 300,
      },
      monitors: [
        {
          id: 21,
          total_sec: 3_600,
          downtime_sec: 300,
        },
      ],
    });
  });

  it('serves hidden monitor uptime to authorized admins with private cache headers', async () => {
    const rangeEnd = 1_728_000_000;
    const rangeStart = rangeEnd - 86_400;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 5_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) => sql.includes('from monitors m') && sql.includes('and 1 = 1'),
        first: () => ({
          id: 77,
          name: 'Private Admin API',
          interval_sec: 60,
          created_at: rangeStart - 10 * 86_400,
          last_checked_at: rangeEnd - 30,
        }),
      },
      {
        match: 'from check_results',
        all: () => [
          { checked_at: rangeStart - 60, status: 'up' },
          { checked_at: rangeEnd - 60, status: 'up' },
        ],
      },
      {
        match: 'from outages',
        all: () => [],
      },
    ];

    const { res, body } = await requestPublic('/monitors/77/uptime?range=24h', handlers, {
      adminToken: 'secret-token',
      authorization: 'Bearer secret-token',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    expect(body).toMatchObject({
      monitor: { id: 77, name: 'Private Admin API' },
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec: 86_400,
      downtime_sec: 0,
    });
  });
});

describe('public incident feed regression', () => {
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

  it('filters anonymous incident feeds in SQL before applying the active limit', async () => {
    const now = 1_728_520_000;
    const activeIncidentSqls: string[] = [];
    const activeIncidentArgs: unknown[][] = [];

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from incidents') && sql.includes("where status != 'resolved'"),
        all: (args, sql) => {
          activeIncidentArgs.push([...args]);
          activeIncidentSqls.push(sql);
          return [
            {
              id: 2,
              title: 'Shared API latency',
              status: 'monitoring',
              impact: 'minor',
              message: 'Customer-visible',
              started_at: now - 300,
              resolved_at: null,
            },
          ];
        },
      },
      {
        match: 'from incident_updates',
        all: () => [],
      },
      {
        match: 'from incident_monitors',
        all: () => [{ incident_id: 2, monitor_id: 11 }],
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: () => [{ id: 11 }],
      },
    ];

    const { res, body } = await requestPublic('/incidents?limit=1', handlers);

    expect(res.status).toBe(200);
    expect(activeIncidentArgs[0]).toEqual([1]);
    expect(activeIncidentSqls[0]).toContain('limit ?1');
    expect(activeIncidentSqls[0]).toContain('not exists');
    expect(activeIncidentSqls[0]).toContain('show_on_status_page = 1');
    expect(body).toMatchObject({
      incidents: [
        {
          id: 2,
          status: 'monitoring',
          monitor_ids: [11],
          updates: [],
        },
      ],
      next_cursor: null,
    });
  });

  it('paginates resolved incidents by resolved_at while keeping cursor ids stable', async () => {
    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from incidents') &&
          sql.includes("where status = 'resolved'") &&
          sql.includes('order by resolved_at desc, id desc'),
        all: (args) => {
          if (args.length === 1) {
            return [
              {
                id: 5,
                title: 'Newest resolved',
                status: 'resolved',
                impact: 'minor',
                message: null,
                started_at: 100,
                resolved_at: 500,
              },
              {
                id: 7,
                title: 'Second resolved',
                status: 'resolved',
                impact: 'minor',
                message: null,
                started_at: 90,
                resolved_at: 400,
              },
              {
                id: 9,
                title: 'Oldest resolved',
                status: 'resolved',
                impact: 'minor',
                message: null,
                started_at: 80,
                resolved_at: 300,
              },
            ];
          }

          expect(args).toEqual([50, 500, 5]);
          return [
            {
              id: 7,
              title: 'Second resolved',
              status: 'resolved',
              impact: 'minor',
              message: null,
              started_at: 90,
              resolved_at: 400,
            },
            {
              id: 9,
              title: 'Oldest resolved',
              status: 'resolved',
              impact: 'minor',
              message: null,
              started_at: 80,
              resolved_at: 300,
            },
          ];
        },
      },
      {
        match: (sql) =>
          sql.includes('select id, resolved_at') &&
          sql.includes('from incidents') &&
          sql.includes("status = 'resolved'"),
        first: () => ({
          id: 5,
          resolved_at: 500,
        }),
      },
      {
        match: 'from incident_updates',
        all: () => [],
      },
      {
        match: 'from incident_monitors',
        all: () => [],
      },
    ];

    const firstPage = await requestPublic('/incidents?resolved_only=1&limit=1', handlers);
    expect(firstPage.res.status).toBe(200);
    expect(firstPage.body).toMatchObject({
      incidents: [{ id: 5 }],
      next_cursor: 5,
    });

    const secondPage = await requestPublic('/incidents?resolved_only=1&limit=1&cursor=5', handlers);
    expect(secondPage.res.status).toBe(200);
    expect(secondPage.body).toMatchObject({
      incidents: [{ id: 7 }],
      next_cursor: 7,
    });
  });

  it('paginates maintenance history by ends_at while keeping cursor ids stable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_728_600_000_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from maintenance_windows') &&
          sql.includes('where ends_at <= ?1') &&
          sql.includes('order by ends_at desc, id desc'),
        all: (args) => {
          if (args.length === 2) {
            return [
              {
                id: 4,
                title: 'Newest maintenance',
                message: null,
                starts_at: 100,
                ends_at: 450,
                created_at: 90,
              },
              {
                id: 8,
                title: 'Older maintenance',
                message: null,
                starts_at: 50,
                ends_at: 250,
                created_at: 40,
              },
            ];
          }

          expect(args).toEqual([1_728_600_000, 50, 450, 4]);
          return [
            {
              id: 8,
              title: 'Older maintenance',
              message: null,
              starts_at: 50,
              ends_at: 250,
              created_at: 40,
            },
          ];
        },
      },
      {
        match: (sql) =>
          sql.includes('select id, ends_at') && sql.includes('from maintenance_windows'),
        first: () => ({
          id: 4,
          ends_at: 450,
        }),
      },
      {
        match: 'from maintenance_window_monitors',
        all: () => [],
      },
    ];

    const firstPage = await requestPublic('/maintenance-windows?limit=1', handlers);
    expect(firstPage.res.status).toBe(200);
    expect(firstPage.body).toMatchObject({
      maintenance_windows: [{ id: 4 }],
      next_cursor: 4,
    });

    const secondPage = await requestPublic('/maintenance-windows?limit=1&cursor=4', handlers);
    expect(secondPage.res.status).toBe(200);
    expect(secondPage.body).toMatchObject({
      maintenance_windows: [{ id: 8 }],
      next_cursor: null,
    });
  });

  it('applies incident visibility rules to resolved cursor lookups for anonymous requests', async () => {
    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select id, resolved_at') &&
          sql.includes("status = 'resolved'") &&
          sql.includes('show_on_status_page = 1'),
        first: () => null,
      },
      {
        match: 'from incident_updates',
        all: () => [],
      },
      {
        match: 'from incident_monitors',
        all: () => [],
      },
    ];

    const page = await requestPublic('/incidents?resolved_only=1&limit=1&cursor=999', handlers);

    expect(page.res.status).toBe(200);
    expect(page.body).toMatchObject({
      incidents: [],
      next_cursor: null,
    });
  });

  it('applies maintenance visibility rules to history cursor lookups for anonymous requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_728_600_000_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select id, ends_at') &&
          sql.includes('from maintenance_windows') &&
          sql.includes('show_on_status_page = 1'),
        first: () => null,
      },
      {
        match: 'from maintenance_window_monitors',
        all: () => [],
      },
    ];

    const page = await requestPublic('/maintenance-windows?limit=1&cursor=999', handlers);

    expect(page.res.status).toBe(200);
    expect(page.body).toMatchObject({
      maintenance_windows: [],
      next_cursor: null,
    });
  });
});

describe('public route cache/auth regression', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;

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

  it('bypasses anonymous cache entries for authorized incident requests', async () => {
    const store = new Map<string, Response>();
    installCacheMock(store);
    const now = 1_728_530_000;

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from incidents') &&
          sql.includes("where status != 'resolved'") &&
          sql.includes('show_on_status_page = 1'),
        all: () => [
          {
            id: 2,
            title: 'Shared API latency',
            status: 'monitoring',
            impact: 'minor',
            message: 'Customer-visible',
            started_at: now - 300,
            resolved_at: null,
          },
        ],
      },
      {
        match: (sql) =>
          sql.includes('from incidents') &&
          sql.includes("where status != 'resolved'") &&
          sql.includes('1 = 1'),
        all: () => [
          {
            id: 1,
            title: 'Private control plane outage',
            status: 'identified',
            impact: 'major',
            message: 'Internal only',
            started_at: now - 120,
            resolved_at: null,
          },
        ],
      },
      {
        match: 'from incident_updates',
        all: () => [],
      },
      {
        match: 'from incident_monitors',
        all: () => [
          { incident_id: 1, monitor_id: 22 },
          { incident_id: 2, monitor_id: 11 },
        ],
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: () => [{ id: 11 }],
      },
    ];

    const anonymous = await requestPublic('/incidents?limit=1', handlers);
    expect(anonymous.res.status).toBe(200);
    expect(anonymous.body).toMatchObject({
      incidents: [
        {
          id: 2,
          monitor_ids: [11],
        },
      ],
    });

    const cachedAnonymous = store.get('https://status.example.com/incidents?limit=1')?.clone();
    expect(cachedAnonymous).toBeDefined();
    expect(await cachedAnonymous?.json()).toMatchObject({
      incidents: [
        {
          id: 2,
        },
      ],
    });

    const admin = await requestPublic('/incidents?limit=1', handlers, {
      adminToken: 'secret-token',
      authorization: 'Bearer secret-token',
    });

    expect(admin.res.status).toBe(200);
    expect(admin.res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(admin.res.headers.get('Vary')).toContain('Authorization');
    expect(admin.body).toMatchObject({
      incidents: [
        {
          id: 1,
          monitor_ids: [22],
        },
      ],
    });

    const cachedAfterAdmin = store.get('https://status.example.com/incidents?limit=1')?.clone();
    expect(await cachedAfterAdmin?.json()).toMatchObject({
      incidents: [
        {
          id: 2,
        },
      ],
    });
  });
});
