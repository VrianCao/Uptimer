import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import worker from '../src/index';
import { publicUiRoutes } from '../src/routes/public-ui';
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

async function requestPublicUi(path: string, handlers: FakeD1QueryHandler[]) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;
  const waitUntil = vi.fn();

  const res = await publicUiRoutes.fetch(new Request(`https://status.example.com${path}`), env, {
    waitUntil,
  } as unknown as ExecutionContext);
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body, waitUntil };
}

async function requestPublicUiViaWorker(
  path: string,
  handlers: FakeD1QueryHandler[],
  opts: { authorization?: string } = {},
) {
  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;
  const waitUntil = vi.fn();
  const headers = opts.authorization ? { Authorization: opts.authorization } : undefined;

  const res = await worker.fetch(
    new Request(`https://status.example.com/api/v1/public${path}`, { headers }),
    env,
    { waitUntil } as unknown as ExecutionContext,
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body, waitUntil };
}

describe('public ui routes', () => {
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

  it('keeps monitor uptime totals stable on the fast public-ui route', async () => {
    const rangeEnd = 1_728_000_000;
    const rangeStart = rangeEnd - 86_400;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 15_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from monitors m') &&
          sql.includes('left join monitor_state') &&
          !sql.includes('with input'),
        first: () => ({
          id: 12,
          name: 'Legacy Monitor',
          interval_sec: 60,
          created_at: rangeStart - 5 * 86_400,
          last_checked_at: rangeEnd - 60,
        }),
      },
      {
        match: (sql) =>
          sql.includes('select checked_at') &&
          sql.includes('from check_results') &&
          sql.includes('order by checked_at'),
        first: () => null,
      },
      {
        match: (sql) =>
          sql.includes('with input(monitor_id, interval_sec, created_at, last_checked_at) as (') &&
          sql.includes('unknown_overlap'),
        first: () => ({
          start_at: rangeStart,
          total_sec: 86_400,
          downtime_sec: 300,
          unknown_sec: 0,
        }),
      },
    ];

    const { res, body } = await requestPublicUi('/monitors/12/uptime?range=24h', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      monitor: { id: 12, name: 'Legacy Monitor' },
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec: 86_400,
      downtime_sec: 300,
      unknown_sec: 0,
      uptime_sec: 86_100,
    });
  });

  it('keeps analytics uptime totals stable on the fast public-ui route', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select m.id, m.name, m.type, m.created_at') &&
          sql.includes('from monitors m') &&
          sql.includes('where m.is_active = 1'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            created_at: dayStart - 10 * 86_400,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from public_snapshots') && sql.includes('where key = ?1'),
        first: (args) => {
          const [key] = args as [string];
          if (key === 'analytics-overview') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                full_day_end_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    total_sec_30d: 0,
                    downtime_sec_30d: 0,
                    unknown_sec_30d: 0,
                    uptime_sec_30d: 0,
                    total_sec_90d: 0,
                    downtime_sec_90d: 0,
                    unknown_sec_90d: 0,
                    uptime_sec_90d: 0,
                  },
                ],
              }),
            };
          }

          if (key === 'monitor-runtime:totals') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                day_start_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    interval_sec: 60,
                    range_start_at: dayStart,
                    materialized_at: rangeEnd,
                    last_checked_at: rangeEnd,
                    last_status_code: 'u',
                    last_outage_open: false,
                    total_sec: 3_600,
                    downtime_sec: 300,
                    unknown_sec: 0,
                    uptime_sec: 3_300,
                  },
                ],
              }),
            };
          }

          return null;
        },
      },
    ];

    const { res, body } = await requestPublicUi('/analytics/uptime?range=30d', handlers);

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

  it('accepts trailing slashes on fast public-ui worker routes', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select m.id, m.name, m.type, m.created_at') &&
          sql.includes('from monitors m') &&
          sql.includes('where m.is_active = 1'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            created_at: dayStart - 10 * 86_400,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from public_snapshots') && sql.includes('where key = ?1'),
        first: (args) => {
          if (args[0] === 'analytics-overview') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                full_day_end_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    total_sec_30d: 0,
                    downtime_sec_30d: 0,
                    unknown_sec_30d: 0,
                    uptime_sec_30d: 0,
                    total_sec_90d: 0,
                    downtime_sec_90d: 0,
                    unknown_sec_90d: 0,
                    uptime_sec_90d: 0,
                  },
                ],
              }),
            };
          }
          if (args[0] === 'monitor-runtime:totals') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                day_start_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    interval_sec: 60,
                    range_start_at: dayStart,
                    materialized_at: rangeEnd,
                    last_checked_at: rangeEnd,
                    last_status_code: 'u',
                    last_outage_open: false,
                    total_sec: 3_600,
                    downtime_sec: 300,
                    unknown_sec: 0,
                    uptime_sec: 3_300,
                  },
                ],
              }),
            };
          }
          return null;
        },
      },
    ];

    const { res, body } = await requestPublicUiViaWorker('/analytics/uptime/?range=30d', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      range_end_at: rangeEnd,
      overall: {
        total_sec: 3_600,
        downtime_sec: 300,
      },
    });
  });

  it('treats invalid Authorization on fast public-ui worker routes as private no-store', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select m.id, m.name, m.type, m.created_at') &&
          sql.includes('from monitors m') &&
          sql.includes('where m.is_active = 1'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            created_at: dayStart - 10 * 86_400,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from public_snapshots') && sql.includes('where key = ?1'),
        first: (args) => {
          const [key] = args as [string];
          if (key === 'analytics-overview') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                full_day_end_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    total_sec_30d: 0,
                    downtime_sec_30d: 0,
                    unknown_sec_30d: 0,
                    uptime_sec_30d: 0,
                    total_sec_90d: 0,
                    downtime_sec_90d: 0,
                    unknown_sec_90d: 0,
                    uptime_sec_90d: 0,
                  },
                ],
              }),
            };
          }

          if (key === 'monitor-runtime:totals') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                day_start_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    interval_sec: 60,
                    range_start_at: dayStart,
                    materialized_at: rangeEnd,
                    last_checked_at: rangeEnd,
                    last_status_code: 'u',
                    last_outage_open: false,
                    total_sec: 3_600,
                    downtime_sec: 300,
                    unknown_sec: 0,
                    uptime_sec: 3_300,
                  },
                ],
              }),
            };
          }

          return null;
        },
      },
    ];

    const { res } = await requestPublicUiViaWorker('/analytics/uptime?range=30d', handlers, {
      authorization: 'Bearer wrong-token',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
  });

  it('returns structured json errors for fast-path analytics validation failures', async () => {
    const { res, body } = await requestPublicUiViaWorker('/analytics/uptime?range=bad', []);

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
      },
    });
  });

  it('rejects invalid outages ranges on the fast public-ui worker route', async () => {
    const { res, body } = await requestPublicUiViaWorker('/monitors/21/outages?range=bad', []);

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
      },
    });
  });

  it('rejects unsupported compact latency formats on the fast public-ui worker route', async () => {
    const { res, body } = await requestPublicUiViaWorker(
      '/monitors/21/latency?format=compact-v2',
      [],
    );

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
      },
    });
  });

  it('rejects non-GET methods on the fast analytics worker route with a structured 405', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/public/analytics/uptime?range=30d', {
        method: 'PATCH',
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('advertises GET-only preflight methods on the fast analytics worker route', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/public/analytics/uptime?range=30d', {
        method: 'OPTIONS',
        headers: { Origin: 'https://status-web.example.com' },
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('rejects non-GET methods on latency routes even when no compact format is requested', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/public/monitors/21/latency?range=24h', {
        method: 'PATCH',
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'METHOD_NOT_ALLOWED',
      },
    });
  });

  it('advertises GET-only preflight methods on latency routes without compact format', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/public/monitors/21/latency?range=24h', {
        method: 'OPTIONS',
        headers: { Origin: 'https://status-web.example.com' },
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });

  it('normalizes repeated slashes on fast public-ui worker routes', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select m.id, m.name, m.type, m.created_at') &&
          sql.includes('from monitors m') &&
          sql.includes('where m.is_active = 1'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            created_at: dayStart - 10 * 86_400,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from public_snapshots') && sql.includes('where key = ?1'),
        first: (args) => {
          if (args[0] === 'analytics-overview') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                full_day_end_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    total_sec_30d: 0,
                    downtime_sec_30d: 0,
                    unknown_sec_30d: 0,
                    uptime_sec_30d: 0,
                    total_sec_90d: 0,
                    downtime_sec_90d: 0,
                    unknown_sec_90d: 0,
                    uptime_sec_90d: 0,
                  },
                ],
              }),
            };
          }
          if (args[0] === 'monitor-runtime:totals') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                day_start_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    interval_sec: 60,
                    range_start_at: dayStart,
                    materialized_at: rangeEnd,
                    last_checked_at: rangeEnd,
                    last_status_code: 'u',
                    last_outage_open: false,
                    total_sec: 3_600,
                    downtime_sec: 300,
                    unknown_sec: 0,
                    uptime_sec: 3_300,
                  },
                ],
              }),
            };
          }
          return null;
        },
      },
    ];

    const env = {
      DB: createFakeD1Database(handlers),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const waitUntil = vi.fn();
    const res = await worker.fetch(
      new Request('https://status.example.com//api/v1/public//analytics/uptime//?range=30d'),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      range_end_at: rangeEnd,
      overall: {
        total_sec: 3_600,
        downtime_sec: 300,
      },
    });
  });

  it('falls back to the live route and queues an overview refresh when the historical snapshot is missing', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('select m.id, m.name, m.type, m.created_at') &&
          sql.includes('from monitors m') &&
          sql.includes('where m.is_active = 1'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            created_at: dayStart - 10 * 86_400,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from public_snapshots') && sql.includes('where key = ?1'),
        first: (args) => {
          const [key] = args as [string];
          if (key === 'analytics-overview') {
            return null;
          }
          if (key === 'monitor-runtime:totals') {
            return {
              generated_at: rangeEnd,
              updated_at: rangeEnd,
              body_json: JSON.stringify({
                version: 1,
                generated_at: rangeEnd,
                day_start_at: dayStart,
                monitors: [
                  {
                    monitor_id: 21,
                    interval_sec: 60,
                    range_start_at: dayStart,
                    materialized_at: rangeEnd,
                    last_checked_at: rangeEnd,
                    last_status_code: 'u',
                    last_outage_open: false,
                    total_sec: 3_600,
                    downtime_sec: 300,
                    unknown_sec: 0,
                    uptime_sec: 3_300,
                  },
                ],
              }),
            };
          }
          return null;
        },
      },
      {
        match: (sql) =>
          sql.includes(
            'select m.id, m.name, m.type, m.interval_sec, m.created_at, s.last_checked_at',
          ) && sql.includes('left join monitor_state'),
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            interval_sec: 60,
            created_at: dayStart - 10 * 86_400,
            last_checked_at: rangeEnd,
          },
        ],
      },
      {
        match: (sql) =>
          sql.includes('from monitor_daily_rollups') && sql.includes('group by monitor_id'),
        all: () => [],
      },
      {
        match: (sql) =>
          sql.includes('select checked_at, status') &&
          sql.includes('from check_results') &&
          sql.includes('where monitor_id = ?1'),
        all: () => [],
      },
      {
        match: (sql) =>
          sql.includes('select started_at, ended_at') &&
          sql.includes('from outages') &&
          sql.includes('where monitor_id = ?1'),
        all: () => [],
      },
      {
        match: (sql) =>
          sql.includes('with input(monitor_id, interval_sec, created_at, last_checked_at) as (') &&
          sql.includes('unknown_overlap'),
        first: () => ({
          start_at: dayStart,
          total_sec: 3_600,
          downtime_sec: 300,
          unknown_sec: 0,
        }),
      },
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
      {
        match: (sql) =>
          sql.includes(
            'coalesce(sum(case when r.day_start_at >= ?2 then r.total_sec else 0 end), 0) as total_sec_30d',
          ) && sql.includes('left join monitor_daily_rollups r'),
        all: () => [
          {
            monitor_id: 21,
            total_sec_30d: 0,
            downtime_sec_30d: 0,
            unknown_sec_30d: 0,
            uptime_sec_30d: 0,
            total_sec_90d: 0,
            downtime_sec_90d: 0,
            unknown_sec_90d: 0,
            uptime_sec_90d: 0,
          },
        ],
      },
      {
        match: 'insert into locks',
        run: () => ({ meta: { changes: 1 } }),
      },
    ];

    const { res, body, waitUntil } = await requestPublicUi('/analytics/uptime?range=30d', handlers);

    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
    expect(body).toMatchObject({
      overall: {
        total_sec: 3_600,
        downtime_sec: 0,
      },
      monitors: [
        {
          id: 21,
          total_sec: 3_600,
          downtime_sec: 0,
        },
      ],
    });
  });
});
