import { describe, expect, it } from 'vitest';

import { computePublicStatusPayload } from '../src/public/status';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

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

    const payload = await computePublicStatusPayload(createFakeD1Database(handlers), now);

    expect(payload.site_title).toBe('Status Hub');
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

    const payload = await computePublicStatusPayload(createFakeD1Database(handlers), now);

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

  it('clamps synthetic today uptime to monitor creation time for newly created monitors', async () => {
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

    const payload = await computePublicStatusPayload(createFakeD1Database(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 600,
      downtime_sec: 0,
      unknown_sec: 480,
      uptime_sec: 120,
    });
    expect(today?.uptime_pct).toBeCloseTo(20, 6);
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

    const payload = await computePublicStatusPayload(createFakeD1Database(handlers), now);
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

    const payload = await computePublicStatusPayload(createFakeD1Database(handlers), now);
    const monitor = payload.monitors.find((m) => m.id === 12);
    const today = monitor?.uptime_days.at(-1);

    expect(today).toBeDefined();
    expect(today).toMatchObject({
      day_start_at: dayStart,
      total_sec: 300,
      downtime_sec: 60,
      unknown_sec: 30,
      uptime_sec: 210,
    });
    expect(today?.uptime_pct).toBeCloseTo(70, 6);
  });
});
