import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
}));

import type { Env } from '../src/env';
import { acquireLease } from '../src/scheduler/lock';
import { runDailyRollup } from '../src/scheduler/daily-rollup';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createEnv(handlers: FakeD1QueryHandler[]): Env {
  return { DB: createFakeD1Database(handlers) } as unknown as Env;
}

describe('scheduler/daily-rollup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:00:00.000Z'));
    vi.mocked(acquireLease).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reads outages and checks in batched monitor queries before writing daily rollups', async () => {
    const targetDayStart = Date.UTC(2026, 1, 17, 0, 0, 0) / 1000;
    const targetDayEnd = targetDayStart + 86_400;
    const outageQueryArgs: unknown[][] = [];
    const checkQueryArgs: unknown[][] = [];
    const rollupInsertArgs: unknown[][] = [];
    const snapshotInsertArgs: unknown[][] = [];

    const env = createEnv([
      {
        match: (sql) =>
          sql.includes('select id, interval_sec, created_at') &&
          sql.includes('from monitors') &&
          sql.includes('where created_at < ?1'),
        all: () => [
          { id: 1, interval_sec: 60, created_at: targetDayStart - 86_400 },
          { id: 2, interval_sec: 60, created_at: targetDayStart - 43_200 },
        ],
      },
      {
        match: (sql) =>
          sql.includes(
            'coalesce(sum(case when r.day_start_at >= ?2 then r.total_sec else 0 end), 0) as total_sec_30d',
          ) && sql.includes('left join monitor_daily_rollups r'),
        all: () => [
          {
            monitor_id: 1,
            total_sec_30d: 86_400,
            downtime_sec_30d: 3_600,
            unknown_sec_30d: 0,
            uptime_sec_30d: 82_800,
            total_sec_90d: 86_400,
            downtime_sec_90d: 3_600,
            unknown_sec_90d: 0,
            uptime_sec_90d: 82_800,
          },
          {
            monitor_id: 2,
            total_sec_30d: 43_200,
            downtime_sec_30d: 0,
            unknown_sec_30d: 0,
            uptime_sec_30d: 43_200,
            total_sec_90d: 43_200,
            downtime_sec_90d: 0,
            unknown_sec_90d: 0,
            uptime_sec_90d: 43_200,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from outages') && sql.includes('monitor_id in'),
        all: (args) => {
          outageQueryArgs.push(args);
          return [
            {
              monitor_id: 1,
              started_at: targetDayStart + 3_600,
              ended_at: targetDayStart + 7_200,
            },
          ];
        },
      },
      {
        match: (sql) => sql.includes('from check_results') && sql.includes('monitor_id in'),
        all: (args) => {
          checkQueryArgs.push(args);
          return [
            {
              monitor_id: 1,
              checked_at: targetDayStart + 3_660,
              status: 'up',
              latency_ms: 45,
            },
            {
              monitor_id: 1,
              checked_at: targetDayStart + 3_720,
              status: 'down',
              latency_ms: null,
            },
            {
              monitor_id: 2,
              checked_at: targetDayStart + 7_200,
              status: 'up',
              latency_ms: 30,
            },
          ];
        },
      },
      {
        match: 'insert into monitor_daily_rollups',
        run: (args) => {
          rollupInsertArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          snapshotInsertArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const scheduledTime = Date.UTC(2026, 1, 18, 0, 0, 0);
    await runDailyRollup(
      env,
      { scheduledTime } as ScheduledController,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(acquireLease).toHaveBeenCalledWith(
      env.DB,
      `analytics:daily-rollup:${targetDayStart}`,
      Math.floor(scheduledTime / 1000),
      600,
    );
    expect(outageQueryArgs).toHaveLength(1);
    expect(checkQueryArgs).toHaveLength(1);
    expect(outageQueryArgs[0]?.slice(0, 2)).toEqual([1, 2]);
    expect(checkQueryArgs[0]?.slice(0, 2)).toEqual([1, 2]);
    expect(outageQueryArgs[0]?.at(-2)).toBe(targetDayEnd);
    expect(outageQueryArgs[0]?.at(-1)).toBe(targetDayStart);
    expect(checkQueryArgs[0]?.at(-2)).toBe(targetDayStart - 120);
    expect(checkQueryArgs[0]?.at(-1)).toBe(targetDayEnd);
    expect(rollupInsertArgs).toHaveLength(2);
    expect(rollupInsertArgs[0]?.[0]).toBe(1);
    expect(rollupInsertArgs[0]?.[1]).toBe(targetDayStart);
    expect(rollupInsertArgs[1]?.[0]).toBe(2);
    expect(rollupInsertArgs[1]?.[1]).toBe(targetDayStart);
    expect(snapshotInsertArgs).toHaveLength(1);
    expect(snapshotInsertArgs[0]?.[0]).toBe('analytics-overview');
  });

  it('keeps check-result batch windows aligned to each monitor interval group', async () => {
    const targetDayStart = Date.UTC(2026, 1, 17, 0, 0, 0) / 1000;
    const targetDayEnd = targetDayStart + 86_400;
    const checkQueryArgs: unknown[][] = [];

    const env = createEnv([
      {
        match: (sql) =>
          sql.includes('select id, interval_sec, created_at') &&
          sql.includes('from monitors') &&
          sql.includes('where created_at < ?1'),
        all: () => [
          { id: 1, interval_sec: 60, created_at: targetDayStart - 86_400 },
          { id: 2, interval_sec: 60, created_at: targetDayStart - 43_200 },
          { id: 3, interval_sec: 3_600, created_at: targetDayStart - 86_400 },
        ],
      },
      {
        match: (sql) =>
          sql.includes(
            'coalesce(sum(case when r.day_start_at >= ?2 then r.total_sec else 0 end), 0) as total_sec_30d',
          ) && sql.includes('left join monitor_daily_rollups r'),
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from outages') && sql.includes('monitor_id in'),
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from check_results') && sql.includes('monitor_id in'),
        all: (args) => {
          checkQueryArgs.push(args);
          return [];
        },
      },
      {
        match: 'insert into monitor_daily_rollups',
        run: () => ({ meta: { changes: 1 } }),
      },
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
    ]);

    await runDailyRollup(
      env,
      { scheduledTime: Date.UTC(2026, 1, 18, 0, 0, 0) } as ScheduledController,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(checkQueryArgs).toHaveLength(2);
    expect(checkQueryArgs[0]).toEqual([1, 2, targetDayStart - 120, targetDayEnd]);
    expect(checkQueryArgs[1]).toEqual([3, targetDayStart - 7_200, targetDayEnd]);
  });

  it('chunks monitor batches to stay under D1 variable limits', async () => {
    const targetDayStart = Date.UTC(2026, 1, 17, 0, 0, 0) / 1000;
    let outageCalls = 0;
    let checkCalls = 0;

    const env = createEnv([
      {
        match: (sql) =>
          sql.includes('select id, interval_sec, created_at') &&
          sql.includes('from monitors') &&
          sql.includes('where created_at < ?1'),
        all: () =>
          Array.from({ length: 91 }, (_, index) => ({
            id: index + 1,
            interval_sec: 60,
            created_at: targetDayStart - 86_400,
          })),
      },
      {
        match: (sql) =>
          sql.includes(
            'coalesce(sum(case when r.day_start_at >= ?2 then r.total_sec else 0 end), 0) as total_sec_30d',
          ) && sql.includes('left join monitor_daily_rollups r'),
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from outages') && sql.includes('monitor_id in'),
        all: () => {
          outageCalls += 1;
          return [];
        },
      },
      {
        match: (sql) => sql.includes('from check_results') && sql.includes('monitor_id in'),
        all: () => {
          checkCalls += 1;
          return [];
        },
      },
      {
        match: 'insert into monitor_daily_rollups',
        run: () => ({ meta: { changes: 1 } }),
      },
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
    ]);

    await runDailyRollup(
      env,
      { scheduledTime: Date.UTC(2026, 1, 18, 0, 0, 0) } as ScheduledController,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(outageCalls).toBe(2);
    expect(checkCalls).toBe(2);
  });
});
