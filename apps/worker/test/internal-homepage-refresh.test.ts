import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  renewLease: vi.fn(),
}));
vi.mock('../src/public/homepage', () => ({
  computePublicHomepagePayload: vi.fn(),
  tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates: vi.fn(),
}));
vi.mock('../src/public/status-refresh', () => ({
  tryComputePublicStatusPayloadFromScheduledRuntimeUpdates: vi.fn(),
}));
vi.mock('../src/snapshots/public-homepage', () => ({
  toHomepageSnapshotPayload: vi.fn((value) => value),
  writeHomepageSnapshot: vi.fn(),
  prepareHomepageSnapshotWrite: vi.fn(),
  didApplyHomepageSnapshotWrite: vi.fn(),
  getHomepageSnapshotArtifactKey: vi.fn(() => 'homepage:artifact'),
}));
vi.mock('../src/snapshots/public-status', () => ({
  writeStatusSnapshot: vi.fn(),
  prepareStatusSnapshotWrite: vi.fn(),
  didApplyStatusSnapshotWrite: vi.fn(),
}));

import type { Env } from '../src/env';
import worker from '../src/index';
import {
  computePublicHomepagePayload,
  tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates,
} from '../src/public/homepage';
import { tryComputePublicStatusPayloadFromScheduledRuntimeUpdates } from '../src/public/status-refresh';
import { acquireLease, releaseLease, renewLease } from '../src/scheduler/lock';
import {
  didApplyHomepageSnapshotWrite,
  prepareHomepageSnapshotWrite,
  toHomepageSnapshotPayload,
  writeHomepageSnapshot,
} from '../src/snapshots/public-homepage';
import {
  didApplyStatusSnapshotWrite,
  prepareStatusSnapshotWrite,
} from '../src/snapshots/public-status';
import { primeStatusSnapshotCache } from '../src/snapshots/public-status-read';
import { createFakeD1Database } from './helpers/fake-d1';

function createBaseSnapshot(now: number) {
  return {
    generated_at: now - 60,
    bootstrap_mode: 'full' as const,
    monitor_count_total: 1,
    site_title: 'Status Hub',
    site_description: 'Production services',
    site_locale: 'en' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
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
        type: 'http' as const,
        group_name: 'Core',
        status: 'up' as const,
        is_stale: false,
        last_checked_at: now - 60,
        heartbeat_strip: {
          checked_at: [now - 60],
          status_codes: 'u',
          latency_ms: [42],
        },
        uptime_30d: { uptime_pct: 100 },
        uptime_day_strip: {
          day_start_at: [Math.floor(now / 86_400) * 86_400],
          downtime_sec: [0],
          unknown_sec: [0],
          uptime_pct_milli: [100_000],
        },
      },
    ],
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

function createStatusSnapshot(now: number) {
  return {
    generated_at: now - 60,
    site_title: 'Status Hub',
    site_description: 'Production services',
    site_locale: 'en' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: {
      up: 0,
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

function createEnv(
  now: number,
  statusSnapshot: ReturnType<typeof createStatusSnapshot> | null = null,
): Env {
  const baseSnapshot = createBaseSnapshot(now);
  return {
    DB: createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: baseSnapshot.generated_at,
            updated_at: baseSnapshot.generated_at,
            body_json: JSON.stringify(baseSnapshot),
          },
        ],
      },
      {
        match: 'from monitor_state',
        all: () => [
          {
            monitor_id: 1,
            last_checked_at: baseSnapshot.monitors[0]?.last_checked_at ?? null,
            status: baseSnapshot.monitors[0]?.status ?? 'unknown',
          },
        ],
      },
      {
        match: 'select generated_at, updated_at, body_json from public_snapshots',
        first: () =>
          statusSnapshot
            ? {
                generated_at: statusSnapshot.generated_at,
                updated_at: statusSnapshot.generated_at,
                body_json: JSON.stringify(statusSnapshot),
              }
            : null,
      },
    ]),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;
}

describe('internal homepage refresh route', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let homepageWritePrime: ReturnType<typeof vi.fn>;
  let statusWritePrime: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(releaseLease).mockResolvedValue(undefined);
    vi.mocked(renewLease).mockResolvedValue(true);
    vi.mocked(writeHomepageSnapshot).mockResolvedValue(true as never);
    homepageWritePrime = vi.fn();
    statusWritePrime = vi.fn();
    vi.mocked(prepareHomepageSnapshotWrite).mockReturnValue({
      statement: {
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      } as unknown as D1PreparedStatement,
      generatedAt: 1_776_230_340,
      prime: homepageWritePrime,
    });
    vi.mocked(didApplyHomepageSnapshotWrite).mockReturnValue(true);
    vi.mocked(prepareStatusSnapshotWrite).mockReturnValue({
      statement: {
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      } as unknown as D1PreparedStatement,
      prime: statusWritePrime,
    });
    vi.mocked(didApplyStatusSnapshotWrite).mockReturnValue(true);
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the scheduled runtime fast path when available', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    const fastPayload = {
      ...baseSnapshot,
      generated_at: now,
      monitors: [
        {
          ...baseSnapshot.monitors[0]!,
          last_checked_at: now,
          heartbeat_strip: {
            checked_at: [now],
            status_codes: 'u',
            latency_ms: [55],
          },
        },
      ],
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      fastPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).toHaveBeenCalledTimes(1);
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(toHomepageSnapshotPayload).toHaveBeenCalledWith(fastPayload);
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledWith(
      env.DB,
      now,
      fastPayload,
      undefined,
      false,
      {
        name: 'snapshot:homepage:refresh',
        expiresAt: now + 55,
      },
      true,
    );
    expect(homepageWritePrime).toHaveBeenCalledTimes(1);
    expect(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith({
      db: env.DB,
      now,
      baseSnapshot: null,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: now - 300,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });
    expect(prepareStatusSnapshotWrite).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith(env.DB, 'snapshot:homepage:refresh', now + 55);
    expect(
      vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        now,
        baseSnapshot,
        baseSnapshotBodyJson: null,
        updates: [
          {
            monitor_id: 1,
            interval_sec: 60,
            created_at: now - 300,
            checked_at: now,
            check_status: 'up',
            next_status: 'up',
            latency_ms: 55,
          },
        ],
      }),
    );
  });

  it('can skip the auxiliary homepage payload snapshot write for scheduled refresh experiments', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    env.UPTIMER_HOMEPAGE_PAYLOAD_SNAPSHOT_WRITE = '0';
    const baseSnapshot = createBaseSnapshot(now);
    const fastPayload = {
      ...baseSnapshot,
      generated_at: now,
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      fastPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledWith(
      env.DB,
      now,
      fastPayload,
      undefined,
      false,
      {
        name: 'snapshot:homepage:refresh',
        expiresAt: now + 55,
      },
      false,
    );
    expect(homepageWritePrime).toHaveBeenCalledTimes(1);
  });

  it('writes a patched status snapshot when the scheduled fast path can produce one', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    const statusPayload = {
      generated_at: now,
      site_title: 'Status Hub',
      site_description: 'Production services',
      site_locale: 'en' as const,
      site_timezone: 'UTC',
      uptime_rating_level: 4 as const,
      overall_status: 'up' as const,
      banner: {
        source: 'monitors' as const,
        status: 'operational' as const,
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
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      statusPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(prepareStatusSnapshotWrite).toHaveBeenCalledWith({
      db: env.DB,
      now,
      payload: statusPayload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 1_776_230_340,
        updatedAt: now,
        lease: {
          name: 'snapshot:homepage:refresh',
          expiresAt: now + 55,
        },
      },
    });
    expect(statusWritePrime).toHaveBeenCalledTimes(1);
  });

  it('does not skip scheduled runtime updates when the base snapshot was already refreshed this minute', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = {
      ...createBaseSnapshot(now),
      generated_at: now - 5,
    };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) =>
            sql.includes('select key, generated_at, updated_at') &&
            sql.includes('from public_snapshots') &&
            !sql.includes('body_json'),
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
            },
          ],
        },
        {
          match: 'from monitor_state',
          all: () => [
            {
              monitor_id: 1,
              last_checked_at: baseSnapshot.monitors[0]?.last_checked_at ?? null,
              status: baseSnapshot.monitors[0]?.status ?? 'unknown',
            },
          ],
        },
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: (args) => {
            const [key] = args as [string];
            if (key !== 'homepage') {
              return null;
            }
            return {
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    const fastPayload = {
      ...baseSnapshot,
      generated_at: now,
      monitors: [
        {
          ...baseSnapshot.monitors[0]!,
          last_checked_at: now,
          heartbeat_strip: {
            checked_at: [now],
            status_codes: 'u',
            latency_ms: [55],
          },
        },
      ],
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      fastPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: true });
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).toHaveBeenCalledTimes(1);
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledWith(
      env.DB,
      now,
      fastPayload,
      undefined,
      false,
      {
        name: 'snapshot:homepage:refresh',
        expiresAt: now + 55,
      },
      true,
    );
  });

  it('skips a scheduled refresh without runtime updates when the snapshot is fresh this minute', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = {
      ...createBaseSnapshot(now),
      generated_at: now,
    };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) =>
            sql.includes('select key, generated_at, updated_at') &&
            sql.includes('from public_snapshots') &&
            !sql.includes('body_json'),
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: (args) => {
            const [key] = args as [string];
            if (key !== 'homepage') {
              return null;
            }
            return {
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: 'test-admin-token',
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(acquireLease).not.toHaveBeenCalled();
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).not.toHaveBeenCalled();
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(prepareHomepageSnapshotWrite).not.toHaveBeenCalled();
  });

  it('normalizes privileged runtime update latency values before fast-path compute', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', -3.7]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(
      vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        now,
        baseSnapshot,
        baseSnapshotBodyJson: null,
        updates: [
          {
            monitor_id: 1,
            interval_sec: 60,
            created_at: now - 300,
            checked_at: now,
            check_status: 'up',
            next_status: 'up',
            latency_ms: 0,
          },
        ],
      }),
    );
  });

  it('tries runtime snapshot fast compute before full compute when no scheduled runtime updates are available', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    const computedPayload = {
      ...baseSnapshot,
      generated_at: now,
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue(computedPayload as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        now,
        baseSnapshot,
        baseSnapshotBodyJson: null,
        updates: [],
      }),
    );
    expect(computePublicHomepagePayload).toHaveBeenCalledWith(env.DB, now, {
      baseSnapshot,
      baseSnapshotBodyJson: null,
    });
    expect(toHomepageSnapshotPayload).toHaveBeenCalledWith(computedPayload);
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledWith(
      env.DB,
      now,
      computedPayload,
      undefined,
      false,
      {
        name: 'snapshot:homepage:refresh',
        expiresAt: now + 55,
      },
      true,
    );
    expect(releaseLease).toHaveBeenCalledWith(env.DB, 'snapshot:homepage:refresh', now + 55);
  });

  it('uses runtime snapshot fast compute for scheduled refreshes without runtime updates', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    const fastPayload = {
      ...baseSnapshot,
      generated_at: now,
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      fastPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: 'test-admin-token',
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: true });
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        db: env.DB,
        now,
        baseSnapshot,
        baseSnapshotBodyJson: null,
        updates: [],
      }),
    );
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledWith(
      env.DB,
      now,
      fastPayload,
      undefined,
      false,
      {
        name: 'snapshot:homepage:refresh',
        expiresAt: now + 55,
      },
      true,
    );
  });

  it('fails closed when the homepage refresh lease is lost before snapshot writes', async () => {
    vi.useFakeTimers();
    const now = 1_776_230_340;
    vi.setSystemTime(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(renewLease).mockResolvedValue(false);

    let resolveCompute: ((value: unknown) => void) | null = null;
    vi.mocked(computePublicHomepagePayload).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve;
        }) as never,
    );

    const fetchPromise = worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    await vi.advanceTimersByTimeAsync(45_000);
    resolveCompute?.({
      ...baseSnapshot,
      generated_at: now,
    });

    const res = await fetchPromise;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(prepareHomepageSnapshotWrite).not.toHaveBeenCalled();
    expect(prepareStatusSnapshotWrite).not.toHaveBeenCalled();
  });

  it('returns refreshed=false and skips status writes when the homepage snapshot write is a no-op', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    vi.mocked(didApplyHomepageSnapshotWrite).mockReturnValue(false);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledTimes(1);
    expect(prepareStatusSnapshotWrite).not.toHaveBeenCalled();
  });

  it('does not prime status cache when a batched homepage snapshot write is a no-op', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      generated_at: now,
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
      monitors: [],
      active_incidents: [],
      maintenance_windows: {
        active: [],
        upcoming: [],
      },
    } as never);
    vi.mocked(didApplyHomepageSnapshotWrite).mockReturnValue(false);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(prepareStatusSnapshotWrite).toHaveBeenCalledTimes(1);
    expect(homepageWritePrime).not.toHaveBeenCalled();
    expect(statusWritePrime).not.toHaveBeenCalled();
  });

  it('fails closed and skips cache priming when the lease expires during batched snapshot writes', async () => {
    const now = 1_776_230_340;
    let currentNowMs = now * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentNowMs);
    const env = createEnv(now);
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      generated_at: now,
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
      monitors: [],
      active_incidents: [],
      maintenance_windows: {
        active: [],
        upcoming: [],
      },
    } as never);
    vi.mocked(prepareStatusSnapshotWrite).mockReturnValue({
      statement: {
        run: vi.fn(async () => {
          currentNowMs = (now + 56) * 1000;
          return { meta: { changes: 1 } };
        }),
      } as unknown as D1PreparedStatement,
      prime: statusWritePrime,
    });

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(homepageWritePrime).not.toHaveBeenCalled();
    expect(statusWritePrime).not.toHaveBeenCalled();
  });

  it('drops stale scheduled runtime updates before attempting the fast path', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = createBaseSnapshot(now);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: (args) =>
            args[0] === 'monitor-runtime'
              ? {
                  generated_at: now,
                  updated_at: now,
                  body_json: JSON.stringify({
                    version: 1,
                    generated_at: now,
                    day_start_at: Math.floor(now / 86_400) * 86_400,
                    monitors: [
                      {
                        monitor_id: 1,
                        created_at: now - 300,
                        interval_sec: 60,
                        range_start_at: Math.floor(now / 86_400) * 86_400,
                        materialized_at: now,
                        last_checked_at: now,
                        last_status_code: 'u',
                        last_outage_open: false,
                        total_sec: 300,
                        downtime_sec: 0,
                        unknown_sec: 0,
                        uptime_sec: 300,
                        heartbeat_gap_sec: '',
                        heartbeat_latency_ms: [88],
                        heartbeat_status_codes: 'u',
                      },
                    ],
                  }),
                }
              : null,
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now - 30, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).not.toHaveBeenCalled();
    expect(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: [],
      }),
    );
    expect(computePublicHomepagePayload).toHaveBeenCalledTimes(1);
  });

  it('fails closed when no scheduled runtime freshness baseline is available', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = createBaseSnapshot(now);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: () => null,
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).not.toHaveBeenCalled();
    expect(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: [],
      }),
    );
    expect(computePublicHomepagePayload).toHaveBeenCalledTimes(1);
  });

  it('trusts scheduled runtime updates when the sanitizer bypass flag is enabled', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = createBaseSnapshot(now);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: () => null,
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_TRUST_SCHEDULED_RUNTIME_UPDATES: '1',
    } as unknown as Env;
    const fastPayload = {
      ...baseSnapshot,
      generated_at: now,
      monitors: [
        {
          ...baseSnapshot.monitors[0]!,
          last_checked_at: now,
        },
      ],
    };
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      fastPayload as never,
    );

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: [
          {
            monitor_id: 1,
            interval_sec: 60,
            created_at: now - 300,
            checked_at: now,
            check_status: 'up',
            next_status: 'up',
            latency_ms: 55,
          },
        ],
      }),
    );
    expect(computePublicHomepagePayload).not.toHaveBeenCalled();
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledTimes(1);
  });

  it('does not skip a fresh scheduled refresh when runtime updates cannot use the fast path', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = {
      ...createBaseSnapshot(now),
      generated_at: now,
    };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) =>
            sql.includes('select key, generated_at, updated_at') &&
            sql.includes('from public_snapshots') &&
            !sql.includes('body_json'),
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
            },
          ],
        },
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: () => null,
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, refreshed: true });
    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).not.toHaveBeenCalled();
    expect(computePublicHomepagePayload).toHaveBeenCalledTimes(1);
    expect(prepareHomepageSnapshotWrite).toHaveBeenCalledTimes(1);
  });

  it('fails closed when only monitor_state is available and the timestamp is ambiguous', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const baseSnapshot = createBaseSnapshot(now);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'select key, generated_at, updated_at, body_json from public_snapshots',
          all: () => [
            {
              key: 'homepage',
              generated_at: baseSnapshot.generated_at,
              updated_at: baseSnapshot.generated_at,
              body_json: JSON.stringify(baseSnapshot),
            },
          ],
        },
        {
          match: 'from monitor_state',
          all: () => [
            {
              monitor_id: 1,
              last_checked_at: now,
              status: 'up',
            },
          ],
        },
        {
          match: 'select generated_at, updated_at, body_json from public_snapshots',
          first: () => null,
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue(
      null as never,
    );
    vi.mocked(computePublicHomepagePayload).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).not.toHaveBeenCalled();
    expect(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: [],
      }),
    );
    expect(computePublicHomepagePayload).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for non-internal hosts before method checks', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/internal/refresh/homepage', {
        method: 'GET',
      }),
      createEnv(now),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found',
      },
    });
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('does not emit trace headers when the internal trace token is missing', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    (env as unknown as Record<string, unknown>).UPTIMER_TRACE_TOKEN = 'expected-token';

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace')).toBeNull();
    expect(res.headers.get('X-Uptimer-Trace-Id')).toBeNull();
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('internal-refresh:'));
  });

  it('does not emit trace headers when the internal trace token is invalid', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    (env as unknown as Record<string, unknown>).UPTIMER_TRACE_TOKEN = 'expected-token';

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Token': 'wrong-token',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace')).toBeNull();
    expect(res.headers.get('X-Uptimer-Trace-Id')).toBeNull();
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('internal-refresh:'));
  });

  it('emits internal refresh trace labels when the trace token matches', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const statusSnapshot = createStatusSnapshot(now);
    const env = createEnv(now, statusSnapshot);
    (env as unknown as Record<string, unknown>).UPTIMER_TRACE_TOKEN = 'expected-token';
    const baseSnapshot = createBaseSnapshot(now);
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      generated_at: now,
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
      monitors: [],
      active_incidents: [],
      maintenance_windows: {
        active: [],
        upcoming: [],
      },
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Id': 'trace-123',
          'X-Uptimer-Trace-Token': 'expected-token',
          'X-Uptimer-Trace-Mode': 'scheduled',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace-Id')).toBe('trace-123');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('route=internal/homepage-refresh');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('runtime_updates_fast_path_count=1');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('skip_initial_freshness_check=1');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('fast_path=scheduled_runtime');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('status_base_snapshot=d1');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('status_refresh=patched');
    expect(res.headers.get('Server-Timing')).toContain('w_status_refresh_read_base_snapshot');
    expect(res.headers.get('Server-Timing')).toContain('w_snapshot_writes_batch');
    expect(res.headers.get('Server-Timing')).toContain('w_total');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('internal-refresh:'));
  });

  it('uses the cached status snapshot base in internal refresh traces when available', async () => {
    const now = 1_776_230_340;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = createEnv(now);
    (env as unknown as Record<string, unknown>).UPTIMER_TRACE_TOKEN = 'expected-token';
    const baseSnapshot = createBaseSnapshot(now);
    const statusSnapshot = createStatusSnapshot(now);
    primeStatusSnapshotCache({
      db: env.DB,
      generatedAt: statusSnapshot.generated_at,
      updatedAt: statusSnapshot.generated_at,
      bodyJson: JSON.stringify(statusSnapshot),
      data: statusSnapshot,
    });
    vi.mocked(tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...baseSnapshot,
      generated_at: now,
    } as never);
    vi.mocked(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).mockResolvedValue({
      ...statusSnapshot,
      generated_at: now,
    } as never);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/refresh/homepage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Id': 'trace-456',
          'X-Uptimer-Trace-Token': 'expected-token',
          'X-Uptimer-Trace-Mode': 'scheduled',
          'X-Uptimer-Refresh-Source': 'scheduled',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          runtime_updates: [[1, 60, now - 300, now, 'up', 'up', 55]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace')).toContain('status_base_snapshot=memory_cache');
    expect(res.headers.get('Server-Timing')).not.toContain('w_status_refresh_read_base_snapshot');
    expect(tryComputePublicStatusPayloadFromScheduledRuntimeUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ baseSnapshot: statusSnapshot }),
    );
  });
});
