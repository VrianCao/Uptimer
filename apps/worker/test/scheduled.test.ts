import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi.fn(),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));
vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  renewLease: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  readSettings: vi.fn(),
}));
vi.mock('../src/notify/webhook', () => ({
  dispatchWebhookToChannels: vi.fn(),
}));
vi.mock('../src/public/homepage', () => ({
  computePublicHomepagePayload: vi.fn(),
}));
vi.mock('../src/public/monitor-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/public/monitor-runtime')>();
  return {
    ...actual,
    refreshPublicMonitorRuntimeSnapshot: vi.fn(),
  };
});
vi.mock('../src/public/monitor-runtime-bootstrap', () => ({
  rebuildPublicMonitorRuntimeSnapshot: vi.fn(),
}));
vi.mock('../src/internal/homepage-refresh-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/homepage-refresh-core')>();
  return {
    ...actual,
    runInternalHomepageRefreshCore: vi.fn(actual.runInternalHomepageRefreshCore),
  };
});
vi.mock('../src/snapshots', () => ({
  refreshPublicHomepageSnapshotIfNeeded: vi.fn(),
}));

import type { Env } from '../src/env';
import { runInternalHomepageRefreshCore } from '../src/internal/homepage-refresh-core';
import { runHttpCheck } from '../src/monitor/http';
import { runTcpCheck } from '../src/monitor/tcp';
import { dispatchWebhookToChannels } from '../src/notify/webhook';
import { computePublicHomepagePayload } from '../src/public/homepage';
import { rebuildPublicMonitorRuntimeSnapshot } from '../src/public/monitor-runtime-bootstrap';
import { refreshPublicMonitorRuntimeSnapshot } from '../src/public/monitor-runtime';
import {
  listMonitorRowsByIds,
  runExclusivePersistedMonitorBatch,
  runScheduledTick,
} from '../src/scheduler/scheduled';
import { LeaseLostError } from '../src/scheduler/lease-guard';
import { acquireLease, releaseLease, renewLease } from '../src/scheduler/lock';
import { refreshPublicHomepageSnapshotIfNeeded } from '../src/snapshots';
import { readSettings } from '../src/settings';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type CreateEnvOptions = {
  dueRows?: unknown[];
  channels?: unknown[];
  suppressedMonitorIds?: number[];
  startedWindows?: unknown[];
  endedWindows?: unknown[];
  windowMonitorLinks?: unknown[];
  schedulableMonitorPresent?: boolean | boolean[];
  onRun?: (normalizedSql: string, args: unknown[]) => void;
};

function createEnv(options: CreateEnvOptions = {}): Env {
  const {
    dueRows = [],
    channels = [],
    suppressedMonitorIds = [],
    startedWindows = [],
    endedWindows = [],
    windowMonitorLinks = [],
    schedulableMonitorPresent = true,
    onRun,
  } = options;
  const schedulableMonitorResults = Array.isArray(schedulableMonitorPresent)
    ? [...schedulableMonitorPresent]
    : null;
  const schedulableMonitorFallback = Array.isArray(schedulableMonitorPresent)
    ? (schedulableMonitorPresent.at(-1) ?? false)
    : schedulableMonitorPresent;
  const readSchedulableMonitorPresent = () =>
    schedulableMonitorResults
      ? (schedulableMonitorResults.shift() ?? schedulableMonitorFallback)
      : schedulableMonitorFallback;

  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'from public_snapshots',
      all: () => [],
      first: () => null,
    },
    {
      match: 'from notification_channels',
      all: () => channels,
    },
    {
      match: (normalizedSql) =>
        normalizedSql.includes('select 1 as present') && normalizedSql.includes('from monitors m'),
      first: () => (readSchedulableMonitorPresent() ? { present: 1 } : null),
    },
    {
      match: 'from monitors m',
      all: () =>
        dueRows.map((row) => {
          if (typeof row === 'object' && row !== null && !('created_at' in row)) {
            Object.assign(row as Record<string, unknown>, { created_at: 0 });
          }
          return row;
        }),
    },
    {
      match: 'select distinct mwm.monitor_id',
      all: () => suppressedMonitorIds.map((monitor_id) => ({ monitor_id })),
    },
    {
      match: 'from maintenance_windows',
      all: (_args, normalizedSql) => {
        if (normalizedSql.includes('starts_at >=') && normalizedSql.includes('starts_at <=')) {
          return startedWindows;
        }
        if (normalizedSql.includes('ends_at >=') && normalizedSql.includes('ends_at <=')) {
          return endedWindows;
        }
        return [];
      },
    },
    {
      match: 'from maintenance_window_monitors',
      all: () => windowMonitorLinks,
    },
    {
      match: 'insert into check_results',
      run: (args, normalizedSql) => {
        onRun?.(normalizedSql, args);
        return { meta: { changes: 1 } };
      },
    },
    {
      match: 'insert into monitor_state',
      run: (args, normalizedSql) => {
        onRun?.(normalizedSql, args);
        return { meta: { changes: 1 } };
      },
    },
    {
      match: 'into outages',
      run: (args, normalizedSql) => {
        onRun?.(normalizedSql, args);
        return { meta: { changes: 1 } };
      },
    },
    {
      match: 'update outages',
      run: (args, normalizedSql) => {
        onRun?.(normalizedSql, args);
        return { meta: { changes: 1 } };
      },
    },
  ];

  return {
    DB: createFakeD1Database(handlers),
  } as unknown as Env;
}

describe('scheduler/scheduled regression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:42.000Z'));

    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(releaseLease).mockResolvedValue(undefined);
    vi.mocked(renewLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: 7,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });
    vi.mocked(dispatchWebhookToChannels).mockResolvedValue(undefined);
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      generated_at: Math.floor(Date.now() / 1000),
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
      summary: { up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 },
      monitors: [],
      active_incidents: [],
      maintenance_windows: { active: [], upcoming: [] },
      resolved_incident_preview: null,
      maintenance_history_preview: null,
    } as never);
    vi.mocked(refreshPublicMonitorRuntimeSnapshot).mockResolvedValue({
      version: 1,
      generated_at: Math.floor(Date.now() / 1000),
      day_start_at: Math.floor(Math.floor(Date.now() / 1000) / 86_400) * 86_400,
      monitors: [],
    });
    vi.mocked(rebuildPublicMonitorRuntimeSnapshot).mockResolvedValue({
      version: 1,
      generated_at: Math.floor(Date.now() / 1000),
      day_start_at: Math.floor(Math.floor(Date.now() / 1000) / 86_400) * 86_400,
      monitors: [],
    });
    vi.mocked(refreshPublicHomepageSnapshotIfNeeded).mockResolvedValue(false);
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'up',
      latencyMs: 21,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });
    vi.mocked(runTcpCheck).mockResolvedValue({
      status: 'up',
      latencyMs: 12,
      httpStatus: null,
      error: null,
      attempts: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns immediately when scheduler lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);

    const env = createEnv();
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(readSettings).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('returns an empty exclusive batch result when no monitor ids remain', async () => {
    const env = createEnv();
    const result = await runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids: [],
      checkedAt: Math.floor(Math.floor(Date.now() / 1000) / 60) * 60,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });

    expect(result).toEqual({
      runtimeUpdates: [],
      stats: {
        processedCount: 0,
        rejectedCount: 0,
        attemptTotal: 0,
        httpCount: 0,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 0,
      persistDurMs: 0,
    });
  });

  it('lists monitor rows by id with invalid ids filtered out', async () => {
    const env = createEnv({
      dueRows: [
        {
          id: 2,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_760_000_060,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    });

    await expect(listMonitorRowsByIds(env.DB, [0, -1, 2, 2])).resolves.toEqual([
      expect.objectContaining({
        id: 2,
        name: 'API',
      }),
    ]);
    await expect(listMonitorRowsByIds(env.DB, [0, -1])).resolves.toEqual([]);
  });

  it('queues homepage refresh when monitors are runnable but none are due', async () => {
    const env = createEnv({ dueRows: [] });
    const waitUntil = vi.fn();
    const expectedNow = Math.floor(Date.now() / 1000);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(acquireLease).toHaveBeenCalledWith(env.DB, 'scheduler:tick', expectedNow, 135);
    expect(readSettings).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
      db: env.DB,
      now: expectedNow,
      compute: expect.any(Function),
      seedDataSnapshot: true,
    });
    const refreshArgs = vi.mocked(refreshPublicHomepageSnapshotIfNeeded).mock.calls[0]?.[0];
    expect(refreshArgs).toBeDefined();
    await refreshArgs?.compute();
    expect(computePublicHomepagePayload).toHaveBeenCalledWith(env.DB, expectedNow, {
      baseSnapshot: null,
      baseSnapshotBodyJson: null,
    });
  });

  it('skips monitor scheduling but keeps idle public refresh and maintenance notifications', async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = createEnv({
      dueRows: [],
      schedulableMonitorPresent: false,
      channels: [
        {
          id: 1,
          name: 'webhook',
          config_json: JSON.stringify({
            url: 'https://hooks.example.com/uptimer',
            method: 'POST',
            payload_type: 'json',
          }),
          created_at: now - 3600,
        },
      ],
      startedWindows: [
        {
          id: 1,
          title: 'Deploy',
          message: null,
          starts_at: now - 60,
          ends_at: now + 60,
          created_at: now - 3600,
        },
      ],
      windowMonitorLinks: [{ maintenance_window_id: 1, monitor_id: 301 }],
    });
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(acquireLease).not.toHaveBeenCalled();
    expect(readSettings).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
      db: env.DB,
      now,
      compute: expect.any(Function),
      seedDataSnapshot: true,
    });
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.started',
        eventKey: `maintenance:1:started:${now - 60}`,
        channels: [expect.objectContaining({ id: 1 })],
      }),
    );
  });

  it('keeps idle public refresh and maintenance notifications after a post-lease pause race', async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = createEnv({
      dueRows: [],
      schedulableMonitorPresent: [true, false],
      channels: [
        {
          id: 1,
          name: 'webhook',
          config_json: JSON.stringify({
            url: 'https://hooks.example.com/uptimer',
            method: 'POST',
            payload_type: 'json',
          }),
          created_at: now - 3600,
        },
      ],
      startedWindows: [
        {
          id: 1,
          title: 'Deploy',
          message: null,
          starts_at: now - 60,
          ends_at: now + 60,
          created_at: now - 3600,
        },
      ],
      windowMonitorLinks: [{ maintenance_window_id: 1, monitor_id: 301 }],
    });
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(readSettings).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
      db: env.DB,
      now,
      compute: expect.any(Function),
      seedDataSnapshot: true,
    });
    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.started',
        eventKey: `maintenance:1:started:${now - 60}`,
        channels: [expect.objectContaining({ id: 1 })],
      }),
    );
  });

  it('self-invokes homepage refresh via service binding when SELF is configured', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    const selfFetch = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(selfFetch).toHaveBeenCalledTimes(1);
    const req = selfFetch.mock.calls[0]?.[0] as Request;
    expect(req).toBeInstanceOf(Request);
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/api/v1/internal/refresh/homepage');
    expect(req.headers.get('Authorization')).toBe('Bearer test-admin-token');
    expect(req.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    await expect(req.text()).resolves.toBe('test-admin-token');
    expect(refreshPublicHomepageSnapshotIfNeeded).not.toHaveBeenCalled();
  });

  it('self-invokes sharded seed and assembler work after homepage refresh when enabled', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED = '1';
    env.UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED = '1';
    env.UPTIMER_PUBLIC_SHARDED_ASSEMBLER = '1';
    env.UPTIMER_SCHEDULED_SHARDED_ASSEMBLER = '1';
    env.UPTIMER_SHARDED_ASSEMBLER_MODE = 'json';
    env.UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE = '2';
    const seedBodies: unknown[] = [];
    const assembleBodies: unknown[] = [];
    const selfFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (path === '/api/v1/internal/seed/sharded-public-snapshot') {
        const body = await request.json();
        seedBodies.push(body);
        return new Response(
          JSON.stringify({
            ok: true,
            seeded: true,
            kind: (body as { kind: string }).kind,
            part: (body as { part: string }).part,
            monitor_count: 3,
            write_count: (body as { part: string }).part === 'envelope' ? 1 : 2,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      if (path === '/api/v1/internal/assemble/sharded-public-snapshot') {
        const body = await request.json();
        assembleBodies.push(body);
        return new Response(
          JSON.stringify({
            ok: true,
            assembled: true,
            kind: (body as { kind: string }).kind,
            monitor_count: 3,
            invalid_count: 0,
            stale_count: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      throw new Error(`unexpected self fetch: ${path}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(selfFetch).toHaveBeenCalledTimes(9);
    expect((selfFetch.mock.calls[0]?.[0] as Request).headers.get('Authorization')).toBe(
      'Bearer test-admin-token',
    );
    expect(selfFetch.mock.calls.map((call) => new URL((call[0] as Request).url).pathname)).toEqual([
      '/api/v1/internal/refresh/homepage',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/seed/sharded-public-snapshot',
      '/api/v1/internal/assemble/sharded-public-snapshot',
      '/api/v1/internal/assemble/sharded-public-snapshot',
    ]);
    expect(seedBodies).toEqual([
      { kind: 'homepage', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
      { kind: 'homepage', part: 'monitors', monitor_offset: 0, monitor_limit: 2 },
      { kind: 'homepage', part: 'monitors', monitor_offset: 2, monitor_limit: 2 },
      { kind: 'status', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
      { kind: 'status', part: 'monitors', monitor_offset: 0, monitor_limit: 2 },
      { kind: 'status', part: 'monitors', monitor_offset: 2, monitor_limit: 2 },
    ]);
    expect(assembleBodies).toEqual([
      { kind: 'homepage', assembly: 'json' },
      { kind: 'status', assembly: 'json' },
    ]);
    logSpy.mockRestore();
  });

  it('skips monolithic homepage refresh in the gated sharded scheduled mode', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED = '1';
    env.UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED = '1';
    env.UPTIMER_PUBLIC_SHARDED_ASSEMBLER = '1';
    env.UPTIMER_SCHEDULED_SHARDED_ASSEMBLER = '1';
    env.UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH = '1';
    env.UPTIMER_SCHEDULED_SHARDED_CONTINUATION = '1';
    env.UPTIMER_SHARDED_ASSEMBLER_MODE = 'json';
    env.UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE = '2';
    const selfFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/internal/refresh/homepage') {
        throw new Error('monolithic homepage refresh should be skipped');
      }
      if (path === '/api/v1/internal/continue/sharded-public-snapshot') {
        return new Response(JSON.stringify({ ok: true, continued: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`unexpected self fetch: ${path}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(selfFetch).toHaveBeenCalledTimes(1);
    expect(new URL((selfFetch.mock.calls[0]?.[0] as Request).url).pathname).toBe(
      '/api/v1/internal/continue/sharded-public-snapshot',
    );
    await expect((selfFetch.mock.calls[0]?.[0] as Request).json()).resolves.toEqual({
      step: 'seed',
      kind: 'homepage',
      part: 'envelope',
      monitor_offset: 0,
      monitor_limit: 2,
    });
    expect(logSpy).toHaveBeenCalledWith(
      'scheduled: homepage_refresh_skip reason=sharded_public_snapshots runtime_updates=0',
    );
    logSpy.mockRestore();
  });

  it('uses runtime fragments as the scheduled post-check pipeline when enabled', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES = '1';
    env.UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH = '1';
    const selfFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/internal/scheduled/check-batch') {
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: [],
            runtime_updates_fragmented: true,
            processed_count: 1,
            rejected_count: 0,
            attempt_total: 1,
            http_count: 1,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 4,
            persist_duration_ms: 2,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      if (path === '/api/v1/internal/refresh/runtime-fragments') {
        return new Response(JSON.stringify({ ok: true, refreshed: true, update_count: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (path === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`unexpected self fetch: ${path}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    const requests = selfFetch.mock.calls.map((call) => call[0] as Request);
    const checkBatchRequests = requests.filter(
      (request) => new URL(request.url).pathname === '/api/v1/internal/scheduled/check-batch',
    );
    expect(checkBatchRequests).toHaveLength(2);
    expect(
      checkBatchRequests.every(
        (request) => request.headers.get('X-Uptimer-Runtime-Fragments-Only') === '1',
      ),
    ).toBe(true);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v1/internal/scheduled/check-batch',
      '/api/v1/internal/scheduled/check-batch',
      '/api/v1/internal/refresh/runtime-fragments',
      '/api/v1/internal/refresh/homepage',
    ]);
    expect(refreshPublicMonitorRuntimeSnapshot).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'scheduled: runtime_fragments_refresh route=internal/refresh/runtime-fragments refreshed=1 update_count=7',
    );
    logSpy.mockRestore();
  });

  it('can split runtime update fragment writes out of check-batch children', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES = '1';
    env.UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH = '1';
    env.UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT = '1';
    const writerBodies: unknown[] = [];
    const selfFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/internal/scheduled/check-batch') {
        expect(request.headers.get('X-Uptimer-Runtime-Fragments-Only')).toBeNull();
        const body = (await request.json()) as { ids: number[]; checked_at: number };
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: body.ids.map((id) => [
              id,
              60,
              1_760_000_000 + id,
              body.checked_at,
              'up',
              'up',
              21,
            ]),
            processed_count: body.ids.length,
            rejected_count: 0,
            attempt_total: body.ids.length,
            http_count: body.ids.length,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 4,
            persist_duration_ms: 2,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      if (path === '/api/v1/internal/write/runtime-update-fragments') {
        writerBodies.push(await request.json());
        return new Response(JSON.stringify({ ok: true, written: true, write_count: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (path === '/api/v1/internal/refresh/runtime-fragments') {
        return new Response(JSON.stringify({ ok: true, refreshed: true, update_count: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (path === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`unexpected self fetch: ${path}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    const requests = selfFetch.mock.calls.map((call) => call[0] as Request);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === '/api/v1/internal/scheduled/check-batch',
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) =>
          new URL(request.url).pathname === '/api/v1/internal/write/runtime-update-fragments',
      ),
    ).toHaveLength(1);
    expect(writerBodies).toEqual([
      {
        runtime_updates: [
          [1, 60, 1_760_000_001, checkedAt, 'up', 'up', 21],
          [2, 60, 1_760_000_002, checkedAt, 'up', 'up', 21],
          [3, 60, 1_760_000_003, checkedAt, 'up', 'up', 21],
          [4, 60, 1_760_000_004, checkedAt, 'up', 'up', 21],
          [5, 60, 1_760_000_005, checkedAt, 'up', 'up', 21],
          [6, 60, 1_760_000_006, checkedAt, 'up', 'up', 21],
          [7, 60, 1_760_000_007, checkedAt, 'up', 'up', 21],
        ],
      },
    ]);
    expect(refreshPublicMonitorRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('uses the equivalent direct homepage refresh core when the direct gate is enabled', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_SCHEDULED_HOMEPAGE_DIRECT = '1';
    const selfFetch = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    vi.mocked(runInternalHomepageRefreshCore).mockResolvedValueOnce({ ok: true, refreshed: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(selfFetch).not.toHaveBeenCalled();
    expect(refreshPublicHomepageSnapshotIfNeeded).not.toHaveBeenCalled();
    expect(runInternalHomepageRefreshCore).toHaveBeenCalledWith({
      env,
      now: Math.floor(Date.now() / 1000),
      scheduledRefreshRequest: true,
      trace: null,
      preferCachedBaseSnapshot: true,
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'scheduled: homepage_refresh_direct route=internal/homepage-refresh mode=scheduled direct=1 ok=1 refreshed=1',
      ),
    );
    logSpy.mockRestore();
  });

  it('passes the freshly written runtime snapshot baseline to the direct homepage core', async () => {
    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_760_000_060,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    }) as unknown as Env;
    env.UPTIMER_SCHEDULED_HOMEPAGE_DIRECT = '1';
    const runtimeSnapshot = {
      version: 1 as const,
      generated_at: Math.floor(Date.now() / 1000),
      day_start_at: Math.floor(Math.floor(Date.now() / 1000) / 86_400) * 86_400,
      monitors: [],
    };
    vi.mocked(refreshPublicMonitorRuntimeSnapshot).mockResolvedValueOnce(runtimeSnapshot);
    vi.mocked(runInternalHomepageRefreshCore).mockResolvedValueOnce({ ok: true, refreshed: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(refreshPublicMonitorRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(runInternalHomepageRefreshCore).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        scheduledRefreshRequest: true,
        trace: null,
        preferCachedBaseSnapshot: true,
        scheduledRuntimeSnapshotBaseline: runtimeSnapshot,
      }),
    );
    logSpy.mockRestore();
  });

  it('emits scheduler trace headers and logs child refresh trace details when tracing is enabled', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_TRACE_SCHEDULED_REFRESH = '1';
    env.UPTIMER_TRACE_TOKEN = 'trace-token';
    const selfFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, refreshed: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace-Id': 'child-trace-id',
          'X-Uptimer-Trace': 'route=internal/homepage-refresh;fast_path=scheduled_runtime',
          'Server-Timing': 'w_homepage_refresh_read_snapshot_base;dur=3.00, w_total;dur=8.00',
        },
      }),
    );
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    const req = selfFetch.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('X-Uptimer-Trace')).toBe('1');
    expect(req.headers.get('X-Uptimer-Trace-Mode')).toBe('scheduled');
    expect(req.headers.get('X-Uptimer-Trace-Token')).toBe('trace-token');
    expect(req.headers.get('X-Uptimer-Trace-Id')).toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('scheduled: homepage_refresh_trace'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('response_trace_id=child-trace-id'));
  });

  it('does not emit scheduler trace headers without a trace token', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_TRACE_SCHEDULED_REFRESH = '1';
    const selfFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, refreshed: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    );
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    const req = selfFetch.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('X-Uptimer-Trace')).toBeNull();
    expect(req.headers.get('X-Uptimer-Trace-Mode')).toBeNull();
    expect(req.headers.get('X-Uptimer-Trace-Token')).toBeNull();
    expect(req.headers.get('X-Uptimer-Trace-Id')).toBeNull();
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('scheduled: homepage_refresh_trace'),
    );
  });

  it('passes scheduler runtime updates to the internal homepage refresh service', async () => {
    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    const selfFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 }),
      );
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(selfFetch).toHaveBeenCalledTimes(1);
    const req = selfFetch.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('Authorization')).toBe('Bearer test-admin-token');
    expect(req.headers.get('Content-Type')).toContain('application/json');
    expect(req.headers.get('X-Uptimer-Internal-Format')).toBe('compact-v1');
    await expect(req.json()).resolves.toMatchObject({
      runtime_updates: [
        [1, 60, 1_760_000_000, Math.floor(Date.now() / 1000 / 60) * 60, 'up', 'up', 21],
      ],
    });
  });

  it('uses internal service batches for large due sets and normalizes returned runtime updates', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    const selfFetch = vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/api/v1/internal/scheduled/check-batch') {
        expect(req.headers.get('X-Uptimer-Internal-Format')).toBe('compact-v1');
        const body = (await req.json()) as {
          ids: number[];
          checked_at: number;
          state_failures_to_down_from_up: number;
          state_successes_to_up_from_down: number;
        };
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: body.ids.map((id, batchIndex) => [
              id,
              60,
              1_760_000_000 + id,
              body.checked_at,
              'up',
              'up',
              batchIndex === 0 ? -3.7 : 21,
            ]),
            processed_count: body.ids.length,
            rejected_count: 0,
            attempt_total: body.ids.length,
            http_count: body.ids.length,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 4,
            persist_duration_ms: 2,
          }),
          { status: 200 },
        );
      }
      if (pathname === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 });
      }
      throw new Error(`unexpected self fetch: ${pathname}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(runHttpCheck).not.toHaveBeenCalled();
    expect(selfFetch).toHaveBeenCalledTimes(3);
    expect(refreshPublicMonitorRuntimeSnapshot).toHaveBeenCalledWith({
      db: env.DB,
      now: Math.floor(Date.now() / 1000),
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 1_760_000_001,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 0,
        },
        {
          monitor_id: 2,
          interval_sec: 60,
          created_at: 1_760_000_002,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
        {
          monitor_id: 3,
          interval_sec: 60,
          created_at: 1_760_000_003,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
        {
          monitor_id: 4,
          interval_sec: 60,
          created_at: 1_760_000_004,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
        {
          monitor_id: 5,
          interval_sec: 60,
          created_at: 1_760_000_005,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
        {
          monitor_id: 6,
          interval_sec: 60,
          created_at: 1_760_000_006,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
        {
          monitor_id: 7,
          interval_sec: 60,
          created_at: 1_760_000_007,
          checked_at: checkedAt,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 0,
        },
      ],
      rebuild: expect.any(Function),
    });
    const runtimeRefreshArgs = vi.mocked(refreshPublicMonitorRuntimeSnapshot).mock.calls[0]?.[0];
    expect(runtimeRefreshArgs).toBeDefined();
    expect(runtimeRefreshArgs).not.toHaveProperty('beforeWrite');
    await expect(runtimeRefreshArgs?.rebuild()).resolves.toEqual({
      version: 1,
      generated_at: Math.floor(Date.now() / 1000),
      day_start_at: Math.floor(Math.floor(Date.now() / 1000) / 86_400) * 86_400,
      monitors: [],
    });
  });

  it('honors a smaller configured internal service batch size', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = '2';
    const checkBatchIds: number[][] = [];
    const selfFetch = vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/api/v1/internal/scheduled/check-batch') {
        const body = (await req.json()) as { ids: number[]; checked_at: number };
        checkBatchIds.push(body.ids);
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: [],
            processed_count: body.ids.length,
            rejected_count: 0,
            attempt_total: body.ids.length,
            http_count: body.ids.length,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 0,
            persist_duration_ms: 0,
          }),
          { status: 200 },
        );
      }
      if (pathname === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 });
      }
      throw new Error(`unexpected self fetch: ${pathname}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(checkBatchIds).toEqual([[1, 2], [3, 4], [5, 6], [7]]);
    expect(selfFetch).toHaveBeenCalledTimes(5);
  });

  it('passes scheduler trace headers to internal check batch services', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.UPTIMER_TRACE_TOKEN = 'trace-token';
    env.UPTIMER_TRACE_SCHEDULED_REFRESH = '1';
    const selfFetch = vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/api/v1/internal/scheduled/check-batch') {
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: [],
            processed_count: 0,
            rejected_count: 0,
            attempt_total: 0,
            http_count: 0,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 0,
            persist_duration_ms: 0,
          }),
          {
            status: 200,
            headers: {
              'X-Uptimer-Trace-Id': 'batch-child-trace-id',
              'X-Uptimer-Trace': 'route=internal/scheduled-check-batch;ok=true',
              'Server-Timing': 'w_check_batch_run;dur=1.00',
            },
          },
        );
      }
      if (pathname === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 });
      }
      throw new Error(`unexpected self fetch: ${pathname}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    const batchReq = selfFetch.mock.calls
      .map((call) => call[0] as Request)
      .find((req) => new URL(req.url).pathname === '/api/v1/internal/scheduled/check-batch');
    expect(batchReq?.headers.get('X-Uptimer-Trace')).toBe('1');
    expect(batchReq?.headers.get('X-Uptimer-Trace-Mode')).toBe('scheduled');
    expect(batchReq?.headers.get('X-Uptimer-Trace-Token')).toBe('trace-token');
    expect(batchReq?.headers.get('X-Uptimer-Trace-Id')).toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('scheduled: check_batch_trace'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('response_trace_id=batch-child-trace-id'),
    );
  });

  it('falls back inline when a service batch returns invalid runtime updates', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 0,
      consecutive_successes: 1,
    }));
    const env = createEnv({ dueRows }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    const selfFetch = vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/api/v1/internal/scheduled/check-batch') {
        return new Response(
          JSON.stringify({
            ok: true,
            runtime_updates: [
              {
                monitor_id: 1,
                interval_sec: 60,
                created_at: 1_760_000_001,
                checked_at: checkedAt,
                check_status: 'degraded',
                next_status: 'up',
                latency_ms: 12,
              },
            ],
            processed_count: 1,
            rejected_count: 0,
            attempt_total: 1,
            http_count: 1,
            tcp_count: 0,
            assertion_count: 0,
            down_count: 0,
            unknown_count: 0,
            checks_duration_ms: 4,
            persist_duration_ms: 2,
          }),
          { status: 200 },
        );
      }
      if (pathname === '/api/v1/internal/refresh/homepage') {
        return new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 });
      }
      throw new Error(`unexpected self fetch: ${pathname}`);
    });
    env.SELF = { fetch: selfFetch } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(runHttpCheck).toHaveBeenCalledTimes(7);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('scheduled: service batch failed, falling back inline'),
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('batch_index=2'),
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`checked_at=${checkedAt}`),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to inline homepage refresh when the internal refresh service fails', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.SELF = {
      fetch: vi.fn().mockRejectedValueOnce(new Error('service refresh failed')),
    } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(warn).toHaveBeenCalledWith(
        'homepage snapshot: service refresh failed',
        expect.any(Error),
      );
      expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
        db: env.DB,
        now: Math.floor(Date.now() / 1000),
        compute: expect.any(Function),
        seedDataSnapshot: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to inline homepage refresh when the internal refresh service reports refreshed=false for runtime updates', async () => {
    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.SELF = {
      fetch: vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, refreshed: false }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
      ),
    } as unknown as Fetcher;
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
      db: env.DB,
      now: Math.floor(Date.now() / 1000),
      compute: expect.any(Function),
      seedDataSnapshot: true,
    });
  });

  it('uses the current time when inline homepage refresh starts after a delayed service failure', async () => {
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    const delayedTime = new Date('2026-02-17T00:02:42.000Z');
    const delayedNow = Math.floor(delayedTime.valueOf() / 1000);
    let rejectServiceFetch: ((reason?: unknown) => void) | null = null;
    env.SELF = {
      fetch: vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectServiceFetch = reject;
          }),
      ),
    } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      vi.setSystemTime(delayedTime);
      rejectServiceFetch?.(new Error('service refresh failed'));
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledWith({
        db: env.DB,
        now: delayedNow,
        compute: expect.any(Function),
        seedDataSnapshot: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the current wall clock when writing runtime snapshots after a delayed monitor batch', async () => {
    let resolveCheck: ((value: unknown) => void) | null = null;

    vi.mocked(runHttpCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }) as never,
    );

    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_759_999_940,
          last_changed_at: 1_759_999_940,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    });
    const delayedTime = new Date('2026-02-17T00:02:42.000Z');
    const delayedNow = Math.floor(delayedTime.valueOf() / 1000);
    const waitUntil = vi.fn();
    const tickPromise = runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    await vi.advanceTimersByTimeAsync(0);
    expect(resolveCheck).toBeTypeOf('function');
    vi.setSystemTime(delayedTime);
    resolveCheck?.({
      status: 'up',
      latencyMs: 21,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });
    await tickPromise;

    expect(refreshPublicMonitorRuntimeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        now: delayedNow,
      }),
    );
  });

  it('logs inline homepage refresh fallback failures after a service refresh error', async () => {
    vi.mocked(refreshPublicHomepageSnapshotIfNeeded).mockRejectedValueOnce(
      new Error('inline refresh failed'),
    );
    const env = createEnv({ dueRows: [] }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.SELF = {
      fetch: vi.fn().mockRejectedValueOnce(new Error('service refresh failed')),
    } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(warn).toHaveBeenCalledWith(
        'homepage snapshot: service refresh failed',
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith('homepage snapshot: refresh failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs lease release failures after the tick completes', async () => {
    vi.mocked(releaseLease).mockRejectedValueOnce(new Error('release failed'));
    const env = createEnv({ dueRows: [] });
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(warn).toHaveBeenCalledWith('scheduled: failed to release lease', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('fails closed when the scheduler lease is lost before persistence', async () => {
    let persistedWrites = 0;
    let resolveCheck: ((value: unknown) => void) | null = null;

    vi.mocked(runHttpCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }) as never,
    );
    vi.mocked(renewLease).mockResolvedValue(false);

    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API',
          type: 'http',
          target: 'https://example.com',
          interval_sec: 60,
          created_at: 1_760_000_000,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_759_999_940,
          last_changed_at: 1_759_999_940,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
      onRun: () => {
        persistedWrites += 1;
      },
    });

    const waitUntil = vi.fn();
    const tickPromise = runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    await vi.advanceTimersByTimeAsync(90_000);
    resolveCheck?.({
      status: 'up',
      latencyMs: 21,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });
    await tickPromise;

    expect(persistedWrites).toBe(0);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('keeps fixed claimed monitor execution leases during batches within the lease window', async () => {
    let resolveCheck: ((value: unknown) => void) | null = null;

    vi.mocked(runHttpCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }) as never,
    );

    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API 1',
          type: 'http',
          target: 'https://example.com/1',
          interval_sec: 60,
          created_at: 1_760_000_001,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_759_999_940,
          last_changed_at: 1_759_999_940,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    });
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;

    const batchPromise = runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids: [1],
      checkedAt,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(renewLease).not.toHaveBeenCalledWith(
      env.DB,
      `scheduler:batch-monitor:${checkedAt}:1`,
      expect.any(Number),
      expect.any(Number),
    );

    resolveCheck?.({
      status: 'up',
      latencyMs: 21,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });
    await batchPromise;
  });

  it('fails closed when a fixed claimed monitor execution lease expires before persistence', async () => {
    let resolveCheck: ((value: unknown) => void) | null = null;
    let persistedWrites = 0;

    vi.mocked(runHttpCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }) as never,
    );

    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API 1',
          type: 'http',
          target: 'https://example.com/1',
          interval_sec: 60,
          created_at: 1_760_000_001,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: 1_759_999_940,
          last_changed_at: 1_759_999_940,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
      onRun: () => {
        persistedWrites += 1;
      },
    });
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;

    const batchPromise = runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids: [1],
      checkedAt,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });

    await vi.advanceTimersByTimeAsync(76_000);
    resolveCheck?.({
      status: 'up',
      latencyMs: 21,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });

    await expect(batchPromise).rejects.toBeInstanceOf(LeaseLostError);
    expect(persistedWrites).toBe(0);
  });

  it('can trust the scheduler lease and skip per-batch execution locks', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API 1',
          type: 'http',
          target: 'https://example.com/1',
          interval_sec: 60,
          created_at: 1_760_000_001,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: checkedAt - 60,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    });

    const result = await runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids: [1],
      checkedAt,
      trustSchedulerLease: true,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });

    expect(acquireLease).not.toHaveBeenCalledWith(
      env.DB,
      expect.stringContaining('scheduler:batch:'),
      expect.any(Number),
      expect.any(Number),
    );
    expect(runHttpCheck).toHaveBeenCalledTimes(1);
    expect(result.runtimeUpdates).toMatchObject([{ monitor_id: 1 }]);
  });

  it('skips monitor ids already claimed by an overlapping batch execution', async () => {
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const env = createEnv({
      dueRows: [
        {
          id: 1,
          name: 'API 1',
          type: 'http',
          target: 'https://example.com/1',
          interval_sec: 60,
          created_at: 1_760_000_001,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: checkedAt - 60,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
        {
          id: 2,
          name: 'API 2',
          type: 'http',
          target: 'https://example.com/2',
          interval_sec: 60,
          created_at: 1_760_000_002,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: checkedAt - 60,
          last_changed_at: 1_760_000_000,
          consecutive_failures: 0,
          consecutive_successes: 1,
        },
      ],
    });

    vi.mocked(acquireLease).mockImplementation(async (_db, name) => {
      if (name === `scheduler:batch-monitor:${checkedAt}:1`) {
        return false;
      }
      return true;
    });

    const result = await runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids: [1, 2],
      checkedAt,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });

    expect(runHttpCheck).toHaveBeenCalledTimes(1);
    expect(runHttpCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/2',
      }),
    );
    expect(result.runtimeUpdates).toMatchObject([
      {
        monitor_id: 2,
      },
    ]);
    expect(result.stats.rejectedCount).toBe(1);
  });

  it('keeps inline notifications when a service batch falls back with active channels', async () => {
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'down',
      latencyMs: 91,
      httpStatus: 503,
      error: 'HTTP 503',
      attempts: 1,
    });
    const checkedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
    const dueRows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      name: `API ${index + 1}`,
      type: 'http',
      target: `https://example.com/${index + 1}`,
      interval_sec: 60,
      created_at: 1_760_000_000 + index,
      timeout_ms: 10_000,
      http_method: 'GET',
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      forbidden_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      state_status: 'up',
      state_last_error: null,
      last_checked_at: checkedAt - 60,
      last_changed_at: 1_760_000_000,
      consecutive_failures: 1,
      consecutive_successes: 0,
    }));
    const channels = [
      {
        id: 1,
        name: 'primary',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: 1700000000,
      },
    ];
    const env = createEnv({ dueRows, channels }) as unknown as Env;
    env.ADMIN_TOKEN = 'test-admin-token';
    env.SELF = {
      fetch: vi.fn(async (req: Request) => {
        const pathname = new URL(req.url).pathname;
        if (pathname === '/api/v1/internal/scheduled/check-batch') {
          return new Response(
            JSON.stringify({
              ok: true,
              runtime_updates: [
                {
                  monitor_id: 1,
                  interval_sec: 60,
                  created_at: 1_760_000_001,
                  checked_at: checkedAt,
                  check_status: 'degraded',
                  next_status: 'up',
                  latency_ms: 12,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (pathname === '/api/v1/internal/refresh/homepage') {
          return new Response(JSON.stringify({ ok: true, refreshed: true }), { status: 200 });
        }
        throw new Error(`unexpected self fetch: ${pathname}`);
      }),
    } as unknown as Fetcher;
    const waitUntil = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('scheduled: service batch failed, falling back inline'),
        expect.any(Error),
      );
      expect(dispatchWebhookToChannels).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs homepage snapshot refresh failures without breaking the tick', async () => {
    vi.mocked(refreshPublicHomepageSnapshotIfNeeded).mockRejectedValueOnce(
      new Error('snapshot refresh failed'),
    );

    const env = createEnv({ dueRows: [] });
    const waitUntil = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

      expect(waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(warnSpy).toHaveBeenCalledWith('homepage snapshot: refresh failed', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('processes due HTTP monitors and writes check/state rows', async () => {
    const runSql: string[] = [];
    const runArgs: unknown[][] = [];
    const dueRows = [
      {
        id: 101,
        name: 'API',
        type: 'http',
        target: 'https://example.com/health',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 3,
      },
    ];
    const env = createEnv({
      dueRows,
      onRun: (sql, args) => {
        runSql.push(sql);
        runArgs.push(args);
      },
    });
    const waitUntil = vi.fn();
    const expectedCheckedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(runHttpCheck).toHaveBeenCalledWith({
      url: 'https://example.com/health',
      timeoutMs: 5000,
      method: 'GET',
      headers: null,
      body: null,
      followRedirects: true,
      expectedStatus: null,
      forbiddenStatus: null,
      responseKeyword: null,
      responseKeywordMode: null,
      responseForbiddenKeyword: null,
      responseForbiddenKeywordMode: null,
    });

    const checkInsertIndex = runSql.findIndex((sql) => sql.includes('insert into check_results'));
    expect(checkInsertIndex).toBeGreaterThan(-1);
    expect(runArgs[checkInsertIndex]).toEqual([
      101,
      expectedCheckedAt,
      'up',
      21,
      200,
      null,
      null,
      1,
    ]);

    const stateUpsertIndex = runSql.findIndex((sql) => sql.includes('insert into monitor_state'));
    expect(stateUpsertIndex).toBeGreaterThan(-1);
    expect(runSql[stateUpsertIndex]).toContain('where monitor_state.last_checked_at is null');
    expect(runArgs[stateUpsertIndex]?.[0]).toBe(101);
    expect(runArgs[stateUpsertIndex]?.[1]).toBe('up');
    expect(runArgs[stateUpsertIndex]?.[2]).toBe(expectedCheckedAt);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(refreshPublicHomepageSnapshotIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('passes explicit response assertion modes through scheduled HTTP checks', async () => {
    const dueRows = [
      {
        id: 102,
        name: 'Regex API',
        type: 'http',
        target: 'https://example.com/regex',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: '^ready:\\\\d+$',
        response_keyword_mode: 'regex',
        response_forbidden_keyword: 'error',
        response_forbidden_keyword_mode: 'contains',
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 2,
      },
    ];
    const env = createEnv({ dueRows });

    await runScheduledTick(env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(runHttpCheck).toHaveBeenCalledWith({
      url: 'https://example.com/regex',
      timeoutMs: 5000,
      method: 'GET',
      headers: null,
      body: null,
      followRedirects: true,
      expectedStatus: null,
      forbiddenStatus: null,
      responseKeyword: '^ready:\\\\d+$',
      responseKeywordMode: 'regex',
      responseForbiddenKeyword: 'error',
      responseForbiddenKeywordMode: 'contains',
    });
  });

  it('passes disabled redirect following through scheduled HTTP checks', async () => {
    const dueRows = [
      {
        id: 103,
        name: 'Redirect API',
        type: 'http',
        target: 'https://example.com/redirect',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        follow_redirects: 0,
        expected_status_json: JSON.stringify([302]),
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 2,
      },
    ];
    const env = createEnv({ dueRows });

    await runScheduledTick(env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(runHttpCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/redirect',
        followRedirects: false,
        expectedStatus: [302],
      }),
    );
  });

  it('batches persistence for multiple due monitors', async () => {
    const dueRows = [
      {
        id: 111,
        name: 'API A',
        type: 'http',
        target: 'https://example.com/a',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 3,
      },
      {
        id: 112,
        name: 'API B',
        type: 'http',
        target: 'https://example.com/b',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 2,
      },
    ];
    const env = createEnv({ dueRows });
    const batchSpy = vi.spyOn(env.DB, 'batch');

    await runScheduledTick(env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(runHttpCheck).toHaveBeenCalledTimes(2);
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends monitor.down notification when status changes and monitor is not suppressed', async () => {
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'down',
      latencyMs: 123,
      httpStatus: 503,
      error: 'HTTP 503',
      attempts: 2,
    });

    const dueRows = [
      {
        id: 201,
        name: 'Core API',
        type: 'http',
        target: 'https://api.example.com/health',
        display_url: 'https://status.example.com/api',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 1,
        consecutive_successes: 0,
      },
    ];
    const channels = [
      {
        id: 1,
        name: 'primary',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: 1700000000,
      },
    ];
    const env = createEnv({ dueRows, channels });
    const waitUntil = vi.fn();
    const expectedCheckedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        eventType: 'monitor.down',
        eventKey: `monitor:201:down:${expectedCheckedAt}`,
        payload: expect.objectContaining({
          event: 'monitor.down',
          monitor: expect.objectContaining({
            id: 201,
            name: 'Core API',
            target: 'https://api.example.com/health',
            display_url: 'https://status.example.com/api',
          }),
          state: expect.objectContaining({
            status: 'down',
            http_status: 503,
            error: 'HTTP 503',
          }),
        }),
      }),
    );
  });

  it('suppresses monitor notifications during active maintenance windows', async () => {
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'down',
      latencyMs: 91,
      httpStatus: 503,
      error: 'HTTP 503',
      attempts: 1,
    });
    const dueRows = [
      {
        id: 301,
        name: 'Billing API',
        type: 'http',
        target: 'https://billing.example.com/health',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'unknown',
        state_last_error: null,
        last_changed_at: null,
        consecutive_failures: 0,
        consecutive_successes: 0,
      },
    ];
    const channels = [
      {
        id: 7,
        name: 'primary',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: 1700000000,
      },
    ];
    const env = createEnv({
      dueRows,
      channels,
      suppressedMonitorIds: [301],
    });

    await runScheduledTick(env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(dispatchWebhookToChannels).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'monitor.down' }),
    );
  });

  it('sends monitor.up when a down monitor recovers', async () => {
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'up',
      latencyMs: 45,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });

    const dueRows = [
      {
        id: 302,
        name: 'Recovery API',
        type: 'http',
        target: 'https://recovery.example.com/health',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'down',
        state_last_error: 'HTTP 503',
        last_changed_at: 1700000000,
        consecutive_failures: 2,
        consecutive_successes: 1,
      },
    ];
    const channels = [
      {
        id: 8,
        name: 'primary',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: 1700000000,
      },
    ];
    const env = createEnv({ dueRows, channels });
    const waitUntil = vi.fn();
    const expectedCheckedAt = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'monitor.up',
        eventKey: `monitor:302:up:${expectedCheckedAt}`,
      }),
    );
  });

  it('runs tcp checks for tcp monitor rows', async () => {
    vi.mocked(runTcpCheck).mockResolvedValue({
      status: 'down',
      latencyMs: 70,
      httpStatus: null,
      error: 'connection refused',
      attempts: 2,
    });

    const runSql: string[] = [];
    const runArgs: unknown[][] = [];
    const dueRows = [
      {
        id: 401,
        name: 'TCP Service',
        type: 'tcp',
        target: 'example.com:5432',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: null,
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 1,
        consecutive_successes: 0,
      },
    ];
    const env = createEnv({
      dueRows,
      onRun: (sql, args) => {
        runSql.push(sql);
        runArgs.push(args);
      },
    });

    await runScheduledTick(env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(runTcpCheck).toHaveBeenCalledWith({
      target: 'example.com:5432',
      timeoutMs: 5000,
    });

    const checkInsertIndex = runSql.findIndex((sql) => sql.includes('insert into check_results'));
    expect(checkInsertIndex).toBeGreaterThan(-1);
    expect(runArgs[checkInsertIndex]?.[2]).toBe('down');
    expect(runArgs[checkInsertIndex]?.[7]).toBe(2);
  });

  it('logs failed due monitor runs and still schedules homepage refresh', async () => {
    const dueRows = [
      {
        id: 501,
        name: 'Broken API',
        type: 'http',
        target: 'https://broken.example.com/health',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        last_changed_at: 1700000000,
        consecutive_failures: 0,
        consecutive_successes: 2,
      },
    ];
    Object.defineProperty(dueRows[0] as Record<string, unknown>, 'state_last_error', {
      get() {
        throw new Error('corrupt state row');
      },
    });
    const env = createEnv({ dueRows });
    const waitUntil = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('scheduled: 1/1 monitors failed'),
      );
      expect(waitUntil).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs failed monitor notification dispatches', async () => {
    vi.mocked(runHttpCheck).mockResolvedValue({
      status: 'down',
      latencyMs: 123,
      httpStatus: 503,
      error: 'HTTP 503',
      attempts: 2,
    });
    vi.mocked(dispatchWebhookToChannels).mockRejectedValueOnce(new Error('webhook unavailable'));

    const dueRows = [
      {
        id: 502,
        name: 'Core API',
        type: 'http',
        target: 'https://api.example.com/health',
        interval_sec: 60,
        timeout_ms: 5000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        forbidden_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_changed_at: 1700000000,
        consecutive_failures: 1,
        consecutive_successes: 0,
      },
    ];
    const channels = [
      {
        id: 12,
        name: 'primary',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: 1700000000,
      },
    ];
    const env = createEnv({ dueRows, channels });
    const waitUntil = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

      expect(waitUntil).toHaveBeenCalledTimes(2);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(errorSpy).toHaveBeenCalledWith(
        'notify: failed to dispatch webhooks',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits maintenance started/ended notifications using created_at gating', async () => {
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - 60;
    const endedAt = now - 20;
    const channels = [
      {
        id: 10,
        name: 'older',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: startedAt - 10,
      },
      {
        id: 11,
        name: 'newer',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: endedAt + 10,
      },
    ];
    const env = createEnv({
      dueRows: [],
      channels,
      startedWindows: [
        {
          id: 1,
          title: 'Deploy',
          message: null,
          starts_at: startedAt,
          ends_at: endedAt,
          created_at: startedAt - 100,
        },
      ],
      endedWindows: [
        {
          id: 1,
          title: 'Deploy',
          message: null,
          starts_at: startedAt,
          ends_at: endedAt,
          created_at: startedAt - 100,
        },
      ],
      windowMonitorLinks: [{ maintenance_window_id: 1, monitor_id: 301 }],
    });
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(3);
    await Promise.all(waitUntil.mock.calls.map((c) => c[0] as Promise<unknown>));

    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.started',
        eventKey: `maintenance:1:started:${startedAt}`,
        channels: [
          expect.objectContaining({
            id: 10,
          }),
        ],
      }),
    );
    expect(dispatchWebhookToChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.ended',
        eventKey: `maintenance:1:ended:${endedAt}`,
        // channel 11 was created after endedAt and should be excluded.
        channels: [expect.objectContaining({ id: 10 })],
      }),
    );
  });

  it('logs failed maintenance notification dispatches', async () => {
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - 60;
    const endedAt = now - 20;
    const channels = [
      {
        id: 13,
        name: 'older',
        config_json: JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        created_at: startedAt - 10,
      },
    ];
    vi.mocked(dispatchWebhookToChannels).mockRejectedValue(new Error('maintenance webhook failed'));

    const env = createEnv({
      dueRows: [],
      channels,
      startedWindows: [
        {
          id: 2,
          title: 'Deploy',
          message: null,
          starts_at: startedAt,
          ends_at: endedAt,
          created_at: startedAt - 100,
        },
      ],
      endedWindows: [
        {
          id: 2,
          title: 'Deploy',
          message: null,
          starts_at: startedAt,
          ends_at: endedAt,
          created_at: startedAt - 100,
        },
      ],
      windowMonitorLinks: [{ maintenance_window_id: 2, monitor_id: 301 }],
    });
    const waitUntil = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

      expect(waitUntil).toHaveBeenCalledTimes(3);
      await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));

      expect(errorSpy).toHaveBeenCalledWith(
        'notify: failed to dispatch maintenance.started',
        expect.any(Error),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'notify: failed to dispatch maintenance.ended',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
