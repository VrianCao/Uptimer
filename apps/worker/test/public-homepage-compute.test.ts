import { describe, expect, it } from 'vitest';

import {
  computePublicHomepagePayload,
  tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates,
  tryPatchPublicHomepagePayloadFromRuntimeUpdates,
} from '../src/public/homepage';
import { publicHomepageResponseSchema } from '../src/schemas/public-homepage';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

describe('computePublicHomepagePayload', () => {
  it('builds compact homepage monitor cards with the expected strips and uptime summary', async () => {
    const now = 1_728_000_000;

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 1,
            name: 'API',
            type: 'http',
            display_url: 'https://status.example.com/api',
            group_name: 'Core',
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: now - 40 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select checked_at, latency_ms, status from check_results',
        all: () => [
          { checked_at: now - 60, latency_ms: 42, status: 'up' },
          { checked_at: now - 120, latency_ms: null, status: 'down' },
        ],
      },
      {
        match: 'json_group_array(day_start_at)',
        raw: () => [
          [
            1,
            JSON.stringify([now - 2 * 86_400, now - 86_400]),
            JSON.stringify([0, 60]),
            JSON.stringify([0, 0]),
            JSON.stringify([100_000, 99_931]),
            172_800,
            172_740,
          ],
        ],
      },
      {
        match: (sql) => sql.startsWith('select key, value from settings'),
        all: () => [
          { key: 'site_title', value: 'Status Hub' },
          { key: 'site_description', value: 'Production services' },
          { key: 'site_locale', value: 'en' },
          { key: 'site_timezone', value: 'UTC' },
          { key: 'uptime_rating_level', value: '4' },
        ],
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

    const payload = await computePublicHomepagePayload(createFakeD1Database(handlers), now);

    expect(payload.generated_at).toBe(now);
    expect(payload.bootstrap_mode).toBe('full');
    expect(payload.monitor_count_total).toBe(1);
    expect(payload.uptime_rating_level).toBe(4);
    expect(payload.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(payload.banner).toEqual({
      source: 'monitors',
      status: 'operational',
      title: 'All Systems Operational',
    });

    expect(payload.monitors).toHaveLength(1);
    expect(payload.monitors[0]).toMatchObject({
      id: 1,
      name: 'API',
      type: 'http',
      display_url: 'https://status.example.com/api',
      group_name: 'Core',
      status: 'up',
      is_stale: false,
      last_checked_at: now - 30,
      heartbeat_strip: {
        checked_at: [now - 60, now - 120],
        status_codes: 'ud',
        latency_ms: [42, null],
      },
      uptime_day_strip: {
        day_start_at: [now - 2 * 86_400, now - 86_400],
        downtime_sec: [0, 60],
        unknown_sec: [0, 0],
        uptime_pct_milli: [100_000, 99_931],
      },
    });
    expect(payload.monitors[0]?.uptime_30d?.uptime_pct).toBeCloseTo(99.965, 3);
  });

  it('includes today uptime when all monitors are created after UTC day start', async () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 36_600; // 10h 10m into current UTC day
    const createdAt = now - 600; // created 10m ago

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 1,
            name: 'API',
            type: 'http',
            group_name: null,
            interval_sec: 60,
            created_at: createdAt,
            state_status: 'up',
            last_checked_at: now - 30,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: (sql) => sql.startsWith('select key, value from settings'),
        all: () => [
          { key: 'site_title', value: 'Status Hub' },
          { key: 'site_description', value: 'Production services' },
          { key: 'site_locale', value: 'en' },
          { key: 'site_timezone', value: 'UTC' },
          { key: 'uptime_rating_level', value: '4' },
        ],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
      {
        match: 'select checked_at, latency_ms, status from check_results',
        all: () => [{ checked_at: now - 120, latency_ms: 42, status: 'up' }],
      },
      {
        match: 'json_group_array(day_start_at)',
        raw: () => [],
      },
      {
        match: 'with input(monitor_id, interval_sec, created_at, last_checked_at) as (',
        all: () => [
          {
            monitor_id: 1,
            start_at: now - 120,
            total_sec: 120,
            downtime_sec: 0,
            unknown_sec: 0,
          },
        ],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [{ monitor_id: 1, checked_at: now - 120, status: 'up' }],
      },
    ];

    const payload = await computePublicHomepagePayload(createFakeD1Database(handlers), now);

    expect(payload.monitors).toHaveLength(1);
    expect(payload.monitors[0]?.uptime_30d?.uptime_pct).toBeCloseTo(100, 6);
    expect(payload.monitors[0]?.uptime_day_strip).toMatchObject({
      day_start_at: [dayStart],
      downtime_sec: [0],
      unknown_sec: [0],
      uptime_pct_milli: [100_000],
    });
  });

  it('reuses base snapshot monitor metadata and historical uptime strips without querying monitor rows', async () => {
    const now = 1_728_000_000;
    const previousDay = now - 86_400;

    const baseSnapshot = {
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
          last_checked_at: previousDay + 60,
          heartbeat_strip: {
            checked_at: [previousDay + 60],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [previousDay],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) => sql.startsWith('select key, value from settings'),
        all: () => [
          { key: 'site_title', value: 'Status Hub' },
          { key: 'site_description', value: 'Production services' },
          { key: 'site_locale', value: 'en' },
          { key: 'site_timezone', value: 'UTC' },
          { key: 'uptime_rating_level', value: '4' },
        ],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
      {
        match: 'count(*) as monitor_count_total',
        first: () => ({
          monitor_count_total: 1,
          max_updated_at: now - 60,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 30,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 30,
            day_start_at: now,
            monitors: [
              {
                monitor_id: 1,
                created_at: now - 40 * 86_400,
                interval_sec: 60,
                range_start_at: now,
                materialized_at: now - 30,
                last_checked_at: now - 30,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 0,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 0,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
    ];

    const payload = await computePublicHomepagePayload(createFakeD1Database(handlers), now, {
      baseSnapshotBodyJson: JSON.stringify(baseSnapshot),
    });

    expect(payload.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(payload.monitors[0]?.uptime_day_strip).toEqual(
      baseSnapshot.monitors[0]?.uptime_day_strip,
    );
    expect(payload.monitors[0]?.uptime_30d).toEqual({ uptime_pct: 100 });
  });

  it('does not suppress fresh active incidents when recomputing from a reusable base snapshot', async () => {
    const now = 1_728_000_000;
    const baseSnapshot = {
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
          last_checked_at: now - 30,
          heartbeat_strip: {
            checked_at: [now - 30],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [now - 86_400],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: (sql) => sql.startsWith('select key, value from settings'),
        all: () => [
          { key: 'site_title', value: 'Status Hub' },
          { key: 'site_description', value: 'Production services' },
          { key: 'site_locale', value: 'en' },
          { key: 'site_timezone', value: 'UTC' },
          { key: 'uptime_rating_level', value: '4' },
        ],
      },
      {
        match: 'count(*) as monitor_count_total',
        first: () => ({
          monitor_count_total: 1,
          max_updated_at: now - 60,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 30,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 30,
            day_start_at: now,
            monitors: [
              {
                monitor_id: 1,
                created_at: now - 40 * 86_400,
                interval_sec: 60,
                range_start_at: now,
                materialized_at: now - 30,
                last_checked_at: now - 30,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 0,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 0,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'from incidents',
        all: (_args, normalizedSql) =>
          normalizedSql.includes("status != 'resolved'")
            ? [
                {
                  id: 9,
                  title: 'Database Degraded',
                  status: 'investigating',
                  impact: 'major',
                  message: 'Investigating elevated latency.',
                  started_at: now - 120,
                  resolved_at: null,
                },
              ]
            : [],
      },
      {
        match: 'from incident_monitors',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
    ];

    const payload = await computePublicHomepagePayload(createFakeD1Database(handlers), now, {
      baseSnapshotBodyJson: JSON.stringify(baseSnapshot),
    });

    expect(payload.active_incidents).toHaveLength(1);
    expect(payload.active_incidents[0]).toMatchObject({
      id: 9,
      title: 'Database Degraded',
      impact: 'major',
    });
    expect(payload.banner.status).toBe('major_outage');
  });

  it('patches a same-day homepage snapshot from runtime updates without D1 reads', () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 60;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const patched = tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 1,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(patched).not.toBeNull();
    expect(publicHomepageResponseSchema.safeParse(patched).success).toBe(true);
    expect(patched?.generated_at).toBe(now);
    expect(patched?.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(patched?.monitors[0]?.heartbeat_strip.checked_at[0]).toBe(now);
    expect(patched?.monitors[0]?.heartbeat_strip.latency_ms[0]).toBe(55);
    expect(patched?.monitors[0]?.last_checked_at).toBe(now);
    expect(patched?.monitors[0]?.uptime_day_strip.day_start_at).toEqual([dayStart]);
    expect(patched?.monitors[0]?.uptime_day_strip.unknown_sec).toEqual([0]);
  });

  it('refuses to patch from a stale base snapshot', () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 180;
    const baseSnapshot = {
      generated_at: now - 120,
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
          last_checked_at: now - 120,
          heartbeat_strip: {
            checked_at: [now - 120],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const patched = tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 1,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(patched).toBeNull();
  });

  it('refuses to patch from out-of-order runtime updates', () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 120;
    const now = dayStart + 180;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const patched = tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 1,
          checked_at: baseNow - 30,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(patched).toBeNull();
  });

  it('reuses the scheduled fast path when the latest resolved incident preview is unchanged', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 60;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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
      resolved_incident_preview: {
        id: 9,
        title: 'API recovered',
        status: 'resolved' as const,
        impact: 'minor' as const,
        message: 'Recovered cleanly.',
        started_at: baseNow - 600,
        resolved_at: baseNow - 300,
      },
      maintenance_history_preview: null,
    };

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 1,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: (sql) => sql.includes('from incidents') && sql.includes("status = 'resolved'"),
        all: () => [
          {
            id: 9,
            title: 'API recovered',
            status: 'resolved',
            impact: 'minor',
            message: 'Recovered cleanly.',
            started_at: baseNow - 600,
            resolved_at: baseNow - 300,
          },
        ],
      },
      {
        match: 'from incident_monitors',
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from maintenance_windows') && sql.includes('ends_at <='),
        all: () => [],
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 1,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.resolved_incident_preview).toEqual(baseSnapshot.resolved_incident_preview);
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at[0]).toBe(now);
    expect(payload?.monitors[0]?.heartbeat_strip.latency_ms[0]).toBe(55);
  });

  it('reuses the scheduled runtime snapshot patch path for partial monitor updates', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 60;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
      bootstrap_mode: 'full' as const,
      monitor_count_total: 2,
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
        up: 2,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
            downtime_sec: [0],
            unknown_sec: [0],
            uptime_pct_milli: [100_000],
          },
        },
        {
          id: 2,
          name: 'DB',
          type: 'tcp' as const,
          group_name: 'Core',
          status: 'up' as const,
          is_stale: false,
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [18],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 2,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 5,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 5,
            day_start_at: dayStart,
            monitors: [
              {
                monitor_id: 1,
                created_at: dayStart - 86_400,
                interval_sec: 60,
                range_start_at: dayStart,
                materialized_at: baseNow,
                last_checked_at: baseNow,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 60,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 60,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
              {
                monitor_id: 2,
                created_at: dayStart - 86_400,
                interval_sec: 120,
                range_start_at: dayStart,
                materialized_at: baseNow,
                last_checked_at: baseNow,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 60,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 60,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [18],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 86_400,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.summary).toEqual({
      up: 2,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at).toEqual([now, baseNow]);
    expect(payload?.monitors[0]?.heartbeat_strip.latency_ms).toEqual([55, 42]);
    expect(payload?.monitors[1]?.last_checked_at).toBe(baseNow);
    expect(payload?.monitors[1]?.heartbeat_strip.checked_at).toEqual([baseNow]);
    expect(payload?.monitors[1]?.uptime_day_strip.day_start_at).toEqual([dayStart]);
    expect(payload?.monitors[1]?.uptime_day_strip.unknown_sec).toEqual([0]);
  });

  it('reuses the runtime snapshot metadata patch path when scheduled refresh has no runtime updates', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 60;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 5,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 5,
            day_start_at: dayStart,
            monitors: [
              {
                monitor_id: 1,
                created_at: dayStart - 86_400,
                interval_sec: 60,
                range_start_at: dayStart,
                materialized_at: now - 5,
                last_checked_at: baseNow,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 50,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 50,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at).toEqual([baseNow]);
    expect(payload?.monitors[0]?.status).toBe('up');
    expect(payload?.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
  });

  it('reuses the direct scheduled patch path when the base snapshot is older than the snapshot freshness window', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 40;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 86_400,
          checked_at: baseNow + 60,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.monitors[0]?.last_checked_at).toBe(baseNow + 60);
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at).toEqual([baseNow + 60, baseNow]);
    expect(payload?.monitors[0]?.heartbeat_strip.latency_ms).toEqual([55, 42]);
    expect(payload?.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
  });

  it('reuses the runtime snapshot metadata patch path when the base snapshot is older than the snapshot freshness window', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 40;
    const now = dayStart + 130;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 5,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 5,
            day_start_at: dayStart,
            monitors: [
              {
                monitor_id: 1,
                created_at: dayStart - 86_400,
                interval_sec: 120,
                range_start_at: dayStart,
                materialized_at: now - 5,
                last_checked_at: baseNow,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 85,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 85,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.monitors[0]?.last_checked_at).toBe(baseNow);
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at).toEqual([baseNow]);
    expect(payload?.monitors[0]?.status).toBe('up');
    expect(payload?.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
  });

  it('uses runtime snapshot state for monitors without fresh runtime updates in the metadata patch path', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 40;
    const now = dayStart + 130;
    const baseSnapshot = {
      generated_at: baseNow,
      bootstrap_mode: 'full' as const,
      monitor_count_total: 1,
      site_title: 'Status Hub',
      site_description: 'Production services',
      site_locale: 'en' as const,
      site_timezone: 'UTC',
      uptime_rating_level: 4 as const,
      overall_status: 'down' as const,
      banner: {
        source: 'monitors' as const,
        status: 'partial_outage' as const,
        title: 'Partial Outage',
      },
      summary: {
        up: 0,
        down: 1,
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
          status: 'down' as const,
          is_stale: false,
          last_checked_at: baseNow - 30,
          heartbeat_strip: {
            checked_at: [baseNow - 30],
            status_codes: 'd',
            latency_ms: [null],
          },
          uptime_30d: { uptime_pct: 98 },
          uptime_day_strip: {
            day_start_at: [dayStart],
            downtime_sec: [30],
            unknown_sec: [0],
            uptime_pct_milli: [95_000],
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

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 0,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 5,
          body_json: JSON.stringify({
            version: 1,
            generated_at: now - 5,
            day_start_at: dayStart,
            monitors: [
              {
                monitor_id: 1,
                created_at: dayStart - 86_400,
                interval_sec: 60,
                range_start_at: dayStart,
                materialized_at: now - 5,
                last_checked_at: now - 10,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 120,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 120,
                heartbeat_gap_sec: '',
                heartbeat_latency_ms: [42],
                heartbeat_status_codes: 'u',
              },
            ],
          }),
        }),
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [],
    });

    expect(payload).not.toBeNull();
    expect(payload?.generated_at).toBe(now);
    expect(payload?.overall_status).toBe('up');
    expect(payload?.monitors[0]?.status).toBe('up');
    expect(payload?.monitors[0]?.is_stale).toBe(false);
    expect(payload?.monitors[0]?.last_checked_at).toBe(now - 10);
    expect(payload?.monitors[0]?.heartbeat_strip.checked_at).toEqual([now - 10]);
    expect(payload?.monitors[0]?.heartbeat_strip.status_codes).toBe('u');
    expect(payload?.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
  });

  it('falls back from the scheduled fast path when the latest resolved incident preview changes', async () => {
    const dayStart = 1_728_000_000;
    const baseNow = dayStart + 60;
    const now = dayStart + 120;
    const baseSnapshot = {
      generated_at: baseNow,
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
          last_checked_at: baseNow,
          heartbeat_strip: {
            checked_at: [baseNow],
            status_codes: 'u',
            latency_ms: [42],
          },
          uptime_30d: { uptime_pct: 100 },
          uptime_day_strip: {
            day_start_at: [dayStart],
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
      resolved_incident_preview: {
        id: 9,
        title: 'API recovered',
        status: 'resolved' as const,
        impact: 'minor' as const,
        message: 'Recovered cleanly.',
        started_at: baseNow - 600,
        resolved_at: baseNow - 300,
      },
      maintenance_history_preview: null,
    };

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'has_resolved_incident_preview',
        first: () => ({
          site_title_value: 'Status Hub',
          site_description_value: 'Production services',
          site_locale_value: 'en',
          site_timezone_value: 'UTC',
          uptime_rating_level_value: '4',
          monitor_count_total: 1,
          max_updated_at: baseNow,
          has_active_incidents: 0,
          has_resolved_incident_preview: 1,
          has_active_maintenance: 0,
          has_upcoming_maintenance: 0,
          has_maintenance_history_preview: 0,
        }),
      },
      {
        match: (sql) => sql.includes('from incidents') && sql.includes("status = 'resolved'"),
        all: () => [
          {
            id: 10,
            title: 'API recovered again',
            status: 'resolved',
            impact: 'minor',
            message: 'A newer incident exists.',
            started_at: baseNow - 500,
            resolved_at: baseNow - 200,
          },
        ],
      },
      {
        match: 'from incident_monitors',
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from maintenance_windows') && sql.includes('ends_at <='),
        all: () => [],
      },
    ];

    const payload = await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
      db: createFakeD1Database(handlers),
      now,
      baseSnapshot,
      baseSnapshotBodyJson: null,
      updates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: dayStart - 1,
          checked_at: now,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 55,
        },
      ],
    });

    expect(payload).toBeNull();
  });
});
