import { describe, expect, it } from 'vitest';

import { Trace } from '../src/observability/trace';
import {
  tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates,
  tryPatchPublicHomepagePayloadFromRuntimeUpdates,
} from '../src/public/homepage';
import { tryPatchPublicStatusPayloadFromRuntimeUpdates } from '../src/public/status-refresh';
import type { PublicHomepageResponse } from '../src/schemas/public-homepage';
import type { PublicStatusResponse } from '../src/schemas/public-status';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createHomepageSnapshot(now: number): PublicHomepageResponse {
  const dayStartAt = Math.floor(now / 86_400) * 86_400;
  return {
    generated_at: now - 180,
    bootstrap_mode: 'full',
    monitor_count_total: 1,
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
        group_name: 'Core',
        status: 'up',
        is_stale: false,
        last_checked_at: now - 180,
        heartbeat_strip: {
          checked_at: [now - 180],
          status_codes: 'u',
          latency_ms: [42],
        },
        uptime_30d: {
          uptime_pct: 100,
        },
        uptime_day_strip: {
          day_start_at: [dayStartAt],
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

function createStatusSnapshot(now: number): PublicStatusResponse {
  const dayStartAt = Math.floor(now / 86_400) * 86_400;
  return {
    generated_at: now - 180,
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
        group_name: 'Core',
        group_sort_order: 0,
        sort_order: 0,
        uptime_rating_level: 4,
        status: 'up',
        is_stale: false,
        last_checked_at: now - 180,
        last_latency_ms: 42,
        heartbeats: [
          {
            checked_at: now - 180,
            status: 'up',
            latency_ms: 42,
          },
        ],
        uptime_30d: {
          range_start_at: dayStartAt,
          range_end_at: now,
          total_sec: 180,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 180,
          uptime_pct: 100,
        },
        uptime_days: [
          {
            day_start_at: dayStartAt,
            total_sec: 180,
            downtime_sec: 0,
            unknown_sec: 0,
            uptime_sec: 180,
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
  };
}

describe('public fast-path guards', () => {
  it('rejects stale homepage runtime updates relative to now', () => {
    const now = 1_728_000_360;
    const baseSnapshot = createHomepageSnapshot(now);

    const patched = tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: now - 600,
          checked_at: now - 121,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(patched).toBeNull();
  });

  it('counts homepage downtime between a down runtime update and now', () => {
    const now = 1_728_000_240;
    const dayStartAt = Math.floor(now / 86_400) * 86_400;
    const baseSnapshot = createHomepageSnapshot(now);
    baseSnapshot.generated_at = now - 120;
    baseSnapshot.monitors[0] = {
      ...baseSnapshot.monitors[0]!,
      last_checked_at: now - 120,
      heartbeat_strip: {
        checked_at: [now - 120],
        status_codes: 'u',
        latency_ms: [42],
      },
      uptime_day_strip: {
        day_start_at: [dayStartAt],
        downtime_sec: [0],
        unknown_sec: [0],
        uptime_pct_milli: [100_000],
      },
    };

    const patched = tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStartAt,
          checked_at: now - 60,
          check_status: 'down',
          next_status: 'down',
          latency_ms: null,
        },
      ],
    });

    expect(patched).not.toBeNull();
    expect(patched?.summary).toEqual({
      up: 0,
      down: 1,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(patched?.monitors[0]).toMatchObject({
      status: 'down',
      is_stale: false,
      last_checked_at: now - 60,
    });
    expect(patched?.monitors[0]?.uptime_day_strip.downtime_sec).toEqual([60]);
    expect(patched?.monitors[0]?.uptime_day_strip.unknown_sec).toEqual([0]);
    expect(patched?.monitors[0]?.uptime_day_strip.uptime_pct_milli).toEqual([75_000]);
  });

  it('rejects stale status runtime updates relative to now', () => {
    const now = 1_728_000_360;
    const baseSnapshot = createStatusSnapshot(now);

    const patched = tryPatchPublicStatusPayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: now - 600,
          checked_at: now - 121,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(patched).toBeNull();
  });

  it('counts status unknown time between an unknown runtime update and now', () => {
    const now = 1_728_000_240;
    const dayStartAt = Math.floor(now / 86_400) * 86_400;
    const baseSnapshot = createStatusSnapshot(now);
    baseSnapshot.generated_at = now - 120;
    baseSnapshot.monitors[0] = {
      ...baseSnapshot.monitors[0]!,
      last_checked_at: now - 120,
      last_latency_ms: 42,
      heartbeats: [
        {
          checked_at: now - 120,
          status: 'up',
          latency_ms: 42,
        },
      ],
      uptime_30d: {
        range_start_at: dayStartAt,
        range_end_at: now,
        total_sec: 240,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 240,
        uptime_pct: 100,
      },
      uptime_days: [
        {
          day_start_at: dayStartAt,
          total_sec: 240,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 240,
          uptime_pct: 100,
        },
      ],
    };

    const patched = tryPatchPublicStatusPayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStartAt,
          checked_at: now - 60,
          check_status: 'unknown',
          next_status: 'unknown',
          latency_ms: null,
        },
      ],
    });

    expect(patched).not.toBeNull();
    expect(patched?.summary).toEqual({
      up: 0,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 1,
    });
    expect(patched?.monitors[0]).toMatchObject({
      status: 'unknown',
      is_stale: false,
      last_checked_at: now - 60,
      last_latency_ms: null,
    });
    expect(patched?.monitors[0]?.uptime_days).toEqual([
      {
        day_start_at: dayStartAt,
        total_sec: 240,
        downtime_sec: 0,
        unknown_sec: 60,
        uptime_sec: 180,
        uptime_pct: 75,
      },
    ]);
    expect(patched?.monitors[0]?.uptime_30d).toEqual({
      range_start_at: dayStartAt,
      range_end_at: now,
      total_sec: 240,
      downtime_sec: 0,
      unknown_sec: 60,
      uptime_sec: 180,
      uptime_pct: 75,
    });
  });

  it('rejects the fast path when only the page logo changed', async () => {
    const now = 1_728_000_360;
    const baseSnapshot = createHomepageSnapshot(now);
    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from status_pages') &&
          sql.includes("where slug = 'default'") &&
          sql.includes('has_active_incidents'),
        first: () => ({
          site_title_value: baseSnapshot.site_title,
          site_description_value: baseSnapshot.site_description,
          logo_url_value: 'https://cdn.example.com/new-logo.png',
          site_locale_value: baseSnapshot.site_locale,
          site_timezone_value: baseSnapshot.site_timezone,
          uptime_rating_level_value: String(baseSnapshot.uptime_rating_level),
          monitor_count_total: 1,
          max_updated_at: baseSnapshot.generated_at,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'select generated_at, updated_at, body_json from public_snapshots',
        first: (args) =>
          args[0] === 'monitor-runtime'
            ? {
                generated_at: baseSnapshot.generated_at + 60,
                updated_at: baseSnapshot.generated_at + 60,
                body_json: JSON.stringify({
                  version: 1,
                  generated_at: baseSnapshot.generated_at + 60,
                  day_start_at: Math.floor(now / 86_400) * 86_400,
                  monitors: [
                    {
                      monitor_id: 1,
                      created_at: now - 600,
                      interval_sec: 60,
                      range_start_at: Math.floor(now / 86_400) * 86_400,
                      materialized_at: baseSnapshot.generated_at + 60,
                      last_checked_at: baseSnapshot.monitors[0]?.last_checked_at,
                      last_status_code: 'u',
                      last_outage_open: false,
                      total_sec: 180,
                      downtime_sec: 0,
                      unknown_sec: 0,
                      uptime_sec: 180,
                      heartbeat_gap_sec: '',
                      heartbeat_latency_ms: [42],
                      heartbeat_status_codes: 'u',
                    },
                  ],
                }),
              }
            : null,
      },
    ];

    const trace = new Trace({ enabled: true, id: 'trace-test', mode: 'scheduled' });
    const patched = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [],
      trace,
    });

    expect(patched).toBeNull();
  });

  it('does not reuse an older runtime snapshot than the homepage base snapshot', async () => {
    const now = 1_728_000_360;
    const baseSnapshot = createHomepageSnapshot(now);
    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) =>
          sql.includes('from status_pages') &&
          sql.includes("where slug = 'default'") &&
          sql.includes('has_active_incidents'),
        first: () => ({
          site_title_value: baseSnapshot.site_title,
          site_description_value: baseSnapshot.site_description,
          site_locale_value: baseSnapshot.site_locale,
          site_timezone_value: baseSnapshot.site_timezone,
          uptime_rating_level_value: String(baseSnapshot.uptime_rating_level),
          monitor_count_total: 1,
          max_updated_at: baseSnapshot.generated_at,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'select generated_at, updated_at, body_json from public_snapshots',
        first: (args) =>
          args[0] === 'monitor-runtime'
            ? {
                generated_at: baseSnapshot.generated_at - 60,
                updated_at: baseSnapshot.generated_at - 60,
                body_json: JSON.stringify({
                  version: 1,
                  generated_at: baseSnapshot.generated_at - 60,
                  day_start_at: Math.floor(now / 86_400) * 86_400,
                  monitors: [
                    {
                      monitor_id: 1,
                      created_at: now - 600,
                      interval_sec: 60,
                      range_start_at: Math.floor(now / 86_400) * 86_400,
                      materialized_at: baseSnapshot.generated_at - 60,
                      last_checked_at: baseSnapshot.monitors[0]?.last_checked_at,
                      last_status_code: 'u',
                      last_outage_open: false,
                      total_sec: 180,
                      downtime_sec: 0,
                      unknown_sec: 0,
                      uptime_sec: 180,
                      heartbeat_gap_sec: '',
                      heartbeat_latency_ms: [42],
                      heartbeat_status_codes: 'u',
                    },
                  ],
                }),
              }
            : null,
      },
    ];

    const trace = new Trace({ enabled: true, id: 'trace-test', mode: 'scheduled' });
    const patched = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [],
      trace,
    });

    expect(patched).toBeNull();
    const serverTiming = trace.toServerTiming('w');
    expect(serverTiming).toContain('w_homepage_refresh_fast_guard_query');
    expect(serverTiming).toContain('w_homepage_refresh_fast_guard_normalize');
  });
});
