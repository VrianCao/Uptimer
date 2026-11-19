import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/monitor/http', () => ({ runHttpCheck: vi.fn() }));
import { runHttpCheck } from '../src/monitor/http';
import { runExclusivePersistedMonitorBatch } from '../src/scheduler/scheduled';
import { runRetention } from '../src/scheduler/retention';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqlite-d1';

function fixture() {
  const f = createSqliteD1();
  const hour = 1_800_000_000;
  const ids = [101, 10001, 900001];
  for (const id of ids)
    f.sqlite
      .prepare(
        "INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES (?,?,'http','https://example.com',?,?)",
      )
      .run(id, `API ${id}`, hour - 86400, hour);
  vi.mocked(runHttpCheck)
    .mockReset()
    .mockResolvedValue({ status: 'up', latencyMs: 42, httpStatus: 200, error: null, attempts: 1 });
  const tick = (at: number) =>
    runExclusivePersistedMonitorBatch({
      db: f.db,
      ids,
      checkedAt: at,
      bufferSamples: true,
      trustSchedulerLease: true,
      stateMachineConfig: { failuresToDownFromUp: 1, successesToUpFromDown: 1 },
    });
  return { ...f, hour, ids, tick };
}

describe('canonical current-hour samples', () => {
  afterEach(() => vi.restoreAllMocks());
  it('persists every sample immediately for sparse IDs and archives exactly once on hour transition', async () => {
    const f = fixture();
    try {
      await f.tick(f.hour + 60);
      const first = f.writes.length;
      vi.mocked(runHttpCheck).mockResolvedValue({
        status: 'down',
        latencyMs: null,
        httpStatus: 503,
        error: '故障 "quoted"\nline',
        attempts: 3,
      });
      await f.tick(f.hour + 120);
      const before = f.sqlite
        .prepare(
          'SELECT monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt FROM check_results ORDER BY monitor_id,checked_at',
        )
        .all();
      expect(before).toHaveLength(6);
      expect(before[1]).toMatchObject({ status: 'down', error: '故障 "quoted"\nline', attempt: 3 });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({
        n: 0,
      });
      expect(
        f.writes
          .slice(first)
          .some((write) => write.sql.includes('INSERT INTO check_result_buckets')),
      ).toBe(false);
      await f.tick(f.hour + 3600);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({
        n: 3,
      });
      expect(
        f.sqlite
          .prepare(
            'SELECT monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt FROM check_results WHERE checked_at<? ORDER BY monitor_id,checked_at',
          )
          .all(f.hour + 3600),
      ).toEqual(before);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 9 });
      expect((await f.tick(f.hour + 3600)).stats.processedCount).toBe(0);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 9 });
      const plan = f.sqlite
        .prepare(
          'EXPLAIN QUERY PLAN SELECT checked_at FROM check_results WHERE monitor_id=101 AND storage_shard=25 AND bucket_start_at>=1800000000',
        )
        .all();
      expect(
        plan.some((row) => /SEARCH s USING INTEGER PRIMARY KEY/.test(String(row.detail))),
      ).toBe(true);
    } finally {
      f.sqlite.close();
    }
  });
  it('rolls the archive and state replacement back together if the state write fails', async () => {
    const f = fixture();
    try {
      await f.tick(f.hour + 60);
      f.sqlite.exec(
        "CREATE TRIGGER fail_state BEFORE UPDATE ON monitor_state BEGIN SELECT RAISE(ABORT,'injected failure'); END",
      );
      await expect(f.tick(f.hour + 3600)).rejects.toThrow('injected failure');
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({
        n: 0,
      });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 3 });
      f.sqlite.exec('DROP TRIGGER fail_state');
      await f.tick(f.hour + 3600);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 6 });
    } finally {
      f.sqlite.close();
    }
  });
  it('preserves DELETE compatibility for pending samples, later appends and subsequent archival', async () => {
    const f = fixture();
    try {
      await f.tick(f.hour + 60);
      await f.tick(f.hour + 120);
      f.sqlite
        .prepare('DELETE FROM check_results WHERE monitor_id=101 AND checked_at=?')
        .run(f.hour + 60);
      await f.tick(f.hour + 180);
      await f.tick(f.hour + 3600);
      expect(
        f.sqlite
          .prepare('SELECT checked_at FROM check_results WHERE monitor_id=101 ORDER BY checked_at')
          .all(),
      ).toEqual([
        { checked_at: f.hour + 120 },
        { checked_at: f.hour + 180 },
        { checked_at: f.hour + 3600 },
      ]);
    } finally {
      f.sqlite.close();
    }
  });
  it('applies exact retention to a paused buffer without waiting for a later probe', async () => {
    const f = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await f.tick(f.hour + 60);
      await f.tick(f.hour + 120);
      f.sqlite.exec("UPDATE monitor_state SET status='paused'");
      const now = f.hour + 90 + 7 * 86400;
      await runRetention({ DB: f.db } as Env, { scheduledTime: now * 1000 } as ScheduledController);
      expect(
        f.sqlite.prepare('SELECT checked_at FROM check_results WHERE monitor_id=101').all(),
      ).toEqual([{ checked_at: f.hour + 120 }]);
      await runRetention(
        { DB: f.db } as Env,
        { scheduledTime: (now + 86400) * 1000 } as ScheduledController,
      );
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 0 });
    } finally {
      f.sqlite.close();
    }
  });
});
