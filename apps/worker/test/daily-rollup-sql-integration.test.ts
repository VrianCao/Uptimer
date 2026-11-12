import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { runDailyRollup } from '../src/scheduler/daily-rollup';
import { writeDailyRollupsSql } from '../src/scheduler/daily-rollup-sql';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('native daily rollup parity', () => {
  afterEach(() => vi.restoreAllMocks());
  it('matches existing interval, outage, counters and exact latency calculations', async () => {
    const start = 1_799_971_200;
    const end = start + 86400;
    vi.spyOn(Date, 'now').mockReturnValue((end + 60) * 1000);
    const legacy = createSqliteD1();
    const native = createSqliteD1();
    for (const { sqlite } of [legacy, native]) {
      for (let id = 1; id <= 8; id++) {
        sqlite
          .prepare(
            `INSERT INTO monitors(id,name,type,target,interval_sec,created_at,updated_at)
          VALUES (?,?,'http','https://example.com',60,?,?)`,
          )
          .run(id, `API ${id}`, id === 7 ? start + 300 : start - 86400, start);
        if (id === 8) continue; // no checks at all
        for (let minute = -2; minute < 1440; minute++) {
          if (id === 2 && minute > 500 && minute < 900) continue;
          if (id === 7 && minute < 10) continue;
          const status =
            id === 3 || (id === 4 && minute % 31 < 8)
              ? 'unknown'
              : id === 5 && minute % 13 < 3
                ? 'down'
                : id === 6
                  ? 'maintenance'
                  : 'up';
          sqlite
            .prepare(
              `INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
            VALUES (?,?,?,?)`,
            )
            .run(
              id,
              start + minute * 60,
              status,
              minute % 100 === 0 ? null : (minute * 37) % 70000,
            );
        }
        // Equal timestamps, explicit unknowns and clamped negative histogram input.
        sqlite
          .prepare(
            `INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
          VALUES (?,?,?,?)`,
          )
          .run(id, start + 86340, 'unknown', null);
        sqlite
          .prepare(
            `INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
          VALUES (?,?,?,?)`,
          )
          .run(id, start + 86340, 'up', -1);
        for (const [lo, hi] of [
          [-100, 800],
          [500, 1200],
          [45000, 50000],
          [49000, null],
        ]) {
          sqlite
            .prepare('INSERT INTO outages(monitor_id,started_at,ended_at) VALUES (?,?,?)')
            .run(id, start + lo!, hi === null ? null : start + hi!);
        }
      }
    }
    await runDailyRollup(
      { DB: legacy.db } as Env,
      { scheduledTime: (end + 60) * 1000 } as ScheduledController,
      {} as ExecutionContext,
    );
    expect(await writeDailyRollupsSql(native.db, start, end, end + 60)).toBe(8);
    const select = 'SELECT * FROM monitor_daily_rollups ORDER BY monitor_id';
    expect(native.sqlite.prepare(select).all()).toEqual(legacy.sqlite.prepare(select).all());
    expect(await writeDailyRollupsSql(native.db, start, end, end + 60)).toBe(8);
    expect(native.sqlite.prepare(select).all()).toEqual(legacy.sqlite.prepare(select).all());
    legacy.sqlite.close();
    native.sqlite.close();
  });
});
