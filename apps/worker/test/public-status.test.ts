import { describe, expect, it } from 'vitest';

import { computePublicStatusPayload } from '../src/public/status';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createPublicStatusDb(handlers: FakeD1QueryHandler[]): D1Database {
  return createFakeD1Database([
    {
      match: 'from status_pages',
      first: () => ({
        id: 1,
        slug: 'default',
        name: 'Default status page',
        title: 'Status Hub',
        description: 'Production services',
        custom_hostname: null,
        logo_url: 'https://cdn.example.com/brand.svg',
      }),
    },
    ...handlers,
  ]);
}

describe('public/status payload regression', () => {
  it('keeps monitor heartbeats and uptime data stable when parallel reads are used', async () => {
    const now = 1_728_000_000;

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 11,
            name: 'API Gateway',
            type: 'http',
            display_url: 'https://status.example.com/api',
            group_name: 'Core',
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: now - 40 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 84,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '4' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [
          { monitor_id: 11, checked_at: now - 60, status: 'up', latency_ms: 80 },
          { monitor_id: 11, checked_at: now - 120, status: 'down', latency_ms: null },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [
          {
            monitor_id: 11,
            day_start_at: now - 86_400,
            total_sec: 86_400,
            downtime_sec: 0,
            unknown_sec: 0,
            uptime_sec: 86_400,
          },
        ],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [
          { key: 'site_title', value: 'Status Hub' },
          { key: 'site_description', value: 'Production services' },
          { key: 'site_locale', value: 'en' },
          { key: 'site_timezone', value: 'UTC' },
        ],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);

    expect(payload.site_title).toBe('Status Hub');
    expect(payload.logo_url).toBe('https://cdn.example.com/brand.svg');
    expect(payload.uptime_rating_level).toBe(4);
    expect(payload.summary).toEqual({
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    });
    expect(payload.overall_status).toBe('up');
    expect(payload.banner).toMatchObject({
      source: 'monitors',
      status: 'operational',
      title: 'All Systems Operational',
    });

    expect(payload.monitors).toHaveLength(1);
    expect(payload.monitors[0]?.display_url).toBe('https://status.example.com/api');
    expect(payload.monitors[0]?.heartbeats).toEqual([
      { checked_at: now - 60, status: 'up', latency_ms: 80 },
      { checked_at: now - 120, status: 'down', latency_ms: null },
    ]);
    expect(payload.monitors[0]?.uptime_days).toHaveLength(1);
    expect(payload.monitors[0]?.uptime_30d).toMatchObject({
      total_sec: 86_400,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 86_400,
      uptime_pct: 100,
    });
  });

  it('keeps incident banner and incident details stable when settings query runs in parallel', async () => {
    const now = 1_728_123_456;

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'from incidents',
        all: () => [
          {
            id: 5,
            title: 'Core API latency spike',
            status: 'identified',
            impact: 'major',
            message: 'Investigating upstream dependency saturation',
            started_at: now - 900,
            resolved_at: null,
          },
        ],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'from incident_monitors',
        all: () => [{ incident_id: 5, monitor_id: 11 }],
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: () => [{ id: 11 }],
      },
      {
        match: 'from incident_updates',
        all: () => [
          {
            id: 9,
            incident_id: 5,
            status: 'monitoring',
            message: 'Mitigation deployed, observing recovery',
            created_at: now - 300,
          },
        ],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_title', value: 'Status Hub' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);

    expect(payload.overall_status).toBe('unknown');
    expect(payload.banner).toMatchObject({
      source: 'incident',
      status: 'major_outage',
      title: 'Major Outage',
      incident: {
        id: 5,
        title: 'Core API latency spike',
        status: 'identified',
        impact: 'major',
      },
    });

    expect(payload.active_incidents).toHaveLength(1);
    expect(payload.active_incidents[0]).toMatchObject({
      id: 5,
      monitor_ids: [11],
    });
    expect(payload.active_incidents[0]?.updates).toEqual([
      {
        id: 9,
        incident_id: 5,
        status: 'monitoring',
        message: 'Mitigation deployed, observing recovery',
        created_at: now - 300,
      },
    ]);
  });

  it('starts synthetic today uptime at the first probe for newly created monitors', async () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 36_600; // 10h 10m into current UTC day
    const newMonitorCreatedAt = now - 600; // created 10m ago

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 11,
            name: 'Legacy Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: dayStart - 5 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 50,
          },
          {
            id: 12,
            name: 'New Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 1,
            interval_sec: 60,
            created_at: newMonitorCreatedAt,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 70,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [
          { monitor_id: 11, checked_at: now - 60, status: 'up', latency_ms: 50 },
          { monitor_id: 12, checked_at: now - 120, status: 'up', latency_ms: 70 },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [{ monitor_id: 12, checked_at: now - 120, status: 'up' }],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 120,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 120,
    });
    expect(today?.uptime_pct).toBeCloseTo(100, 6);
  });

  it('does not hide uptime metrics when all monitors are created after UTC day start', async () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 36_600; // 10h 10m into current UTC day
    const createdAt = now - 600; // created 10m ago

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 12,
            name: 'Fresh Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: createdAt,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 70,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [{ monitor_id: 12, checked_at: now - 120, status: 'up', latency_ms: 70 }],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [{ monitor_id: 12, checked_at: now - 120, status: 'up' }],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    expect(payload.monitors).toHaveLength(1);

    const monitor = payload.monitors[0];
    expect(monitor?.uptime_30d).not.toBeNull();

    const today = monitor?.uptime_days.at(-1);
    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 120,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 120,
    });
    expect(today?.uptime_pct).toBeCloseTo(100, 6);
  });

  it('does not count unknown time before the first probe when monitor has never been checked', async () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 36_600; // 10h 10m into current UTC day
    const newMonitorCreatedAt = now - 600; // created 10m ago

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 11,
            name: 'Legacy Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: dayStart - 5 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 50,
          },
          {
            id: 12,
            name: 'New Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 1,
            interval_sec: 60,
            created_at: newMonitorCreatedAt,
            state_status: 'unknown',
            last_checked_at: null,
            last_latency_ms: null,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [{ monitor_id: 11, checked_at: now - 60, status: 'up', latency_ms: 50 }],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
    });
    expect(today?.uptime_pct).toBeNull();
  });

  it('keeps existing monitor windows anchored to day start in synthetic today uptime', async () => {
    const dayStart = 1_728_000_000;
    const now = dayStart + 600; // 10m into current UTC day

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 12,
            name: 'Legacy Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: dayStart - 5 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 50,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [{ monitor_id: 12, checked_at: now - 60, status: 'up', latency_ms: 50 }],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [{ monitor_id: 12, started_at: dayStart + 120, ended_at: dayStart + 180 }],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [
          { monitor_id: 12, checked_at: dayStart - 60, status: 'up' },
          { monitor_id: 12, checked_at: dayStart + 300, status: 'up' },
        ],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 600,
      downtime_sec: 60,
      unknown_sec: 360,
      uptime_sec: 180,
    });
    expect(today?.uptime_pct).toBeCloseTo(30, 6);
  });

  it('does not seed synthetic today uptime from checks before monitor creation', async () => {
    const dayStart = 1_728_000_000;
    const newMonitorCreatedAt = dayStart + 36_630; // 10:10:30 UTC
    const now = newMonitorCreatedAt + 90; // 90s after creation
    const roundedPreCreationCheckAt = newMonitorCreatedAt - 30; // scheduler floor-to-minute artifact

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 11,
            name: 'Legacy Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: dayStart - 5 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 50,
          },
          {
            id: 12,
            name: 'New Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 1,
            interval_sec: 60,
            created_at: newMonitorCreatedAt,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 70,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [
          { monitor_id: 11, checked_at: now - 60, status: 'up', latency_ms: 50 },
          { monitor_id: 12, checked_at: roundedPreCreationCheckAt, status: 'up', latency_ms: 70 },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [{ monitor_id: 12, checked_at: roundedPreCreationCheckAt, status: 'up' }],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 90,
      downtime_sec: 0,
      unknown_sec: 90,
      uptime_sec: 0,
    });
    expect(today?.uptime_pct).toBeCloseTo(0, 6);
  });

  it('does not count downtime before monitor creation in synthetic today uptime', async () => {
    const dayStart = 1_728_000_000;
    const newMonitorCreatedAt = dayStart + 36_000; // 10:00:00 UTC
    const now = newMonitorCreatedAt + 300; // 5m after creation

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 11,
            name: 'Legacy Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 0,
            interval_sec: 60,
            created_at: dayStart - 5 * 86_400,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 50,
          },
          {
            id: 12,
            name: 'New Monitor',
            type: 'http',
            group_name: null,
            group_sort_order: 0,
            sort_order: 1,
            interval_sec: 60,
            created_at: newMonitorCreatedAt,
            state_status: 'up',
            last_checked_at: now - 30,
            last_latency_ms: 70,
          },
        ],
      },
      {
        match: 'select distinct mwm.monitor_id',
        all: () => [],
      },
      {
        match: 'select value from settings where key = ?1',
        first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
      },
      {
        match: 'row_number() over',
        all: () => [
          { monitor_id: 11, checked_at: now - 60, status: 'up', latency_ms: 50 },
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 270, status: 'up', latency_ms: 70 },
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 150, status: 'up', latency_ms: 70 },
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 90, status: 'up', latency_ms: 70 },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'select monitor_id, started_at, ended_at',
        all: () => [
          {
            monitor_id: 12,
            started_at: newMonitorCreatedAt - 600,
            ended_at: newMonitorCreatedAt + 60,
          },
        ],
      },
      {
        match: 'select monitor_id, checked_at, status from check_results',
        all: () => [
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 90, status: 'up' },
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 150, status: 'up' },
          { monitor_id: 12, checked_at: newMonitorCreatedAt + 270, status: 'up' },
        ],
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
        all: () => [],
      },
      {
        match: 'from maintenance_windows where starts_at > ?1',
        all: () => [],
      },
      {
        match: 'select key, value from settings',
        all: () => [{ key: 'site_timezone', value: 'UTC' }],
      },
    ];

    const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 210,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 210,
    });
    expect(today?.uptime_pct).toBeCloseTo(100, 6);
  });
});

it('filters hidden monitors and hidden-only scoped events from anonymous status payloads', async () => {
  const now = 1_728_500_000;

  const handlers: FakeD1QueryHandler[] = [
    {
      match: (sql) => sql.includes('from monitors m') && sql.includes('show_on_status_page = 1'),
      all: () => [
        {
          id: 11,
          name: 'Public API',
          type: 'http',
          group_name: 'Core',
          group_sort_order: 0,
          sort_order: 0,
          interval_sec: 60,
          created_at: now - 40 * 86_400,
          state_status: 'up',
          last_checked_at: now - 30,
          last_latency_ms: 84,
        },
      ],
    },
    {
      match: (sql) => sql.includes('from monitors m') && sql.includes('and 1 = 1'),
      all: () => [
        {
          id: 11,
          name: 'Public API',
          type: 'http',
          group_name: 'Core',
          group_sort_order: 0,
          sort_order: 0,
          interval_sec: 60,
          created_at: now - 40 * 86_400,
          state_status: 'up',
          last_checked_at: now - 30,
          last_latency_ms: 84,
        },
        {
          id: 22,
          name: 'Private Admin',
          type: 'http',
          group_name: 'Internal',
          group_sort_order: 1,
          sort_order: 0,
          interval_sec: 60,
          created_at: now - 40 * 86_400,
          state_status: 'down',
          last_checked_at: now - 30,
          last_latency_ms: 120,
        },
      ],
    },
    {
      match: 'select distinct mwm.monitor_id',
      all: () => [],
    },
    {
      match: 'select value from settings where key = ?1',
      first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
    },
    {
      match: 'row_number() over',
      all: () => [],
    },
    {
      match: 'from monitor_daily_rollups',
      all: () => [],
    },
    {
      match: (sql) => sql.includes('from outages') && sql.includes('monitor_id in'),
      all: () => [],
    },
    {
      match: (sql) =>
        sql.includes('select monitor_id, checked_at, status') && sql.includes('monitor_id in'),
      all: () => [],
    },
    {
      match: (sql) => sql.includes('from incidents') && sql.includes("where status != 'resolved'"),
      all: () => [
        {
          id: 1,
          title: 'Private control plane outage',
          status: 'identified',
          impact: 'major',
          message: 'Internal only',
          started_at: now - 600,
          resolved_at: null,
        },
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
      match: 'from incident_monitors',
      all: () => [
        { incident_id: 1, monitor_id: 22 },
        { incident_id: 2, monitor_id: 11 },
        { incident_id: 2, monitor_id: 22 },
      ],
    },
    {
      match: 'from incident_updates',
      all: () => [],
    },
    {
      match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
      all: () => [
        {
          id: 5,
          title: 'Private cluster maintenance',
          message: 'Do not expose',
          starts_at: now - 900,
          ends_at: now + 900,
          created_at: now - 1_800,
        },
      ],
    },
    {
      match: 'from maintenance_windows where starts_at > ?1',
      all: () => [
        {
          id: 6,
          title: 'Shared API rollout',
          message: 'Public notice',
          starts_at: now + 3_600,
          ends_at: now + 7_200,
          created_at: now - 1_200,
        },
      ],
    },
    {
      match: 'from maintenance_window_monitors',
      all: () => [
        { maintenance_window_id: 5, monitor_id: 22 },
        { maintenance_window_id: 6, monitor_id: 11 },
        { maintenance_window_id: 6, monitor_id: 22 },
      ],
    },
    {
      match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
      all: () => [{ id: 11 }],
    },
    {
      match: 'select key, value from settings',
      all: () => [{ key: 'site_title', value: 'Status Hub' }],
    },
  ];

  const db = createPublicStatusDb(handlers);

  const anonymousPayload = await computePublicStatusPayload(db, now);
  expect(anonymousPayload.monitors.map((monitor) => monitor.id)).toEqual([11]);
  expect(anonymousPayload.active_incidents).toHaveLength(1);
  expect(anonymousPayload.active_incidents[0]).toMatchObject({
    id: 2,
    monitor_ids: [11],
  });
  expect(anonymousPayload.maintenance_windows.active).toEqual([]);
  expect(anonymousPayload.maintenance_windows.upcoming[0]).toMatchObject({
    id: 6,
    monitor_ids: [11],
  });
  expect(anonymousPayload.banner).toMatchObject({
    source: 'incident',
    status: 'partial_outage',
  });

  const adminPayload = await computePublicStatusPayload(db, now, { includeHiddenMonitors: true });
  expect(adminPayload.monitors.map((monitor) => monitor.id)).toEqual([11, 22]);
  expect(adminPayload.active_incidents.map((incident) => incident.id)).toEqual([1, 2]);
  expect(adminPayload.active_incidents[0]?.monitor_ids).toEqual([22]);
  expect(adminPayload.maintenance_windows.active[0]?.monitor_ids).toEqual([22]);
  expect(adminPayload.maintenance_windows.upcoming[0]?.monitor_ids).toEqual([11, 22]);
  expect(adminPayload.banner).toMatchObject({
    source: 'incident',
    status: 'major_outage',
  });
});

it('bounds anonymous incident and maintenance status queries before expanding related rows', async () => {
  const now = 1_728_510_000;
  const activeIncidentSqls: string[] = [];
  const activeIncidentArgs: unknown[][] = [];
  const activeMaintenanceSqls: string[] = [];
  const activeMaintenanceArgs: unknown[][] = [];
  const upcomingMaintenanceSqls: string[] = [];
  const upcomingMaintenanceArgs: unknown[][] = [];

  const handlers: FakeD1QueryHandler[] = [
    {
      match: (sql) => sql.includes('from monitors m') && sql.includes('show_on_status_page = 1'),
      all: () => [
        {
          id: 11,
          name: 'Public API',
          type: 'http',
          group_name: 'Core',
          group_sort_order: 0,
          sort_order: 0,
          interval_sec: 60,
          created_at: now - 40 * 86_400,
          state_status: 'up',
          last_checked_at: now - 30,
          last_latency_ms: 84,
        },
      ],
    },
    {
      match: 'select distinct mwm.monitor_id',
      all: () => [],
    },
    {
      match: 'select value from settings where key = ?1',
      first: (args) => (args[0] === 'uptime_rating_level' ? { value: '3' } : null),
    },
    {
      match: 'row_number() over',
      all: () => [],
    },
    {
      match: 'from monitor_daily_rollups',
      all: () => [],
    },
    {
      match: (sql) => sql.includes('from outages') && sql.includes('monitor_id in'),
      all: () => [],
    },
    {
      match: (sql) =>
        sql.includes('select monitor_id, checked_at, status') && sql.includes('monitor_id in'),
      all: () => [],
    },
    {
      match: (sql) => sql.includes('from incidents') && sql.includes("where status != 'resolved'"),
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
      match: 'from incident_monitors',
      all: () => [{ incident_id: 2, monitor_id: 11 }],
    },
    {
      match: 'from incident_updates',
      all: () => [],
    },
    {
      match: 'from maintenance_windows where starts_at <= ?1 and ends_at > ?1',
      all: (args, sql) => {
        activeMaintenanceArgs.push([...args]);
        activeMaintenanceSqls.push(sql);
        return [
          {
            id: 5,
            title: 'Shared API maintenance',
            message: 'Public notice',
            starts_at: now - 900,
            ends_at: now + 900,
            created_at: now - 1_800,
          },
        ];
      },
    },
    {
      match: 'from maintenance_windows where starts_at > ?1',
      all: (args, sql) => {
        upcomingMaintenanceArgs.push([...args]);
        upcomingMaintenanceSqls.push(sql);
        return [
          {
            id: 6,
            title: 'Shared API rollout',
            message: 'Public notice',
            starts_at: now + 3_600,
            ends_at: now + 7_200,
            created_at: now - 1_200,
          },
        ];
      },
    },
    {
      match: 'from maintenance_window_monitors',
      all: () => [
        { maintenance_window_id: 5, monitor_id: 11 },
        { maintenance_window_id: 6, monitor_id: 11 },
      ],
    },
    {
      match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
      all: () => [{ id: 11 }],
    },
    {
      match: 'select key, value from settings',
      all: () => [],
    },
  ];

  const payload = await computePublicStatusPayload(createPublicStatusDb(handlers), now);

  expect(activeIncidentArgs[0]).toEqual([5]);
  expect(activeIncidentSqls[0]).toContain('limit ?1');
  expect(activeIncidentSqls[0]).toContain('not exists');
  expect(activeIncidentSqls[0]).toContain('show_on_status_page = 1');
  expect(activeMaintenanceArgs[0]).toEqual([now, 3]);
  expect(activeMaintenanceSqls[0]).toContain('limit ?2');
  expect(activeMaintenanceSqls[0]).toContain('not exists');
  expect(upcomingMaintenanceArgs[0]).toEqual([now, 5]);
  expect(upcomingMaintenanceSqls[0]).toContain('limit ?2');
  expect(upcomingMaintenanceSqls[0]).toContain('show_on_status_page = 1');
  expect(payload.active_incidents.map((incident) => incident.id)).toEqual([2]);
  expect(payload.maintenance_windows.active.map((window) => window.id)).toEqual([5]);
  expect(payload.maintenance_windows.upcoming.map((window) => window.id)).toEqual([6]);
});
