import { describe, it, expect } from 'vitest';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { readLatencyPoints, latencyStatistics } from '../src/public/latency-points';

describe('lossless latency reads without virtual-row scans', () => {
  it('matches the compatibility view across legacy, archived and pending samples', async () => {
    const f = createSqliteD1();
    try {
      const hour = 1_800_000_000;
      f.sqlite
        .prepare(
          "INSERT INTO monitors(id,name,type,target)VALUES(1,'API','http','https://example.com')",
        )
        .run();
      f.sqlite
        .prepare(
          "INSERT INTO check_results_legacy(monitor_id,checked_at,status,latency_ms)VALUES(1,?,'up',10)",
        )
        .run(hour - 60);
      const archived = [
        null,
        [1, hour, 'up', 20, null, null, null, 1],
        [2, hour, 'up', 999, null, null, null, 1],
        [1, hour + 60, 'down', null, 503, 'failed', null, 2],
        [1, hour + 120, 'maintenance', 400, null, null, null, 1],
      ];
      f.sqlite
        .prepare('INSERT INTO check_result_buckets VALUES(0,?,?)')
        .run(hour, JSON.stringify(archived));
      const pending = [
        [1, hour + 3600, 'up', 40, 200, null, 'local', 1],
        [1, hour + 3660, 'unknown', null, null, 'timeout', null, 1],
        [1, hour + 3720, 'up', 1000, 200, null, null, 1],
      ];
      f.sqlite
        .prepare(
          "INSERT INTO monitor_state(monitor_id,status,pending_hour,pending_samples_json)VALUES(1,'up',?,?)",
        )
        .run(hour + 3600, JSON.stringify(pending));
      const start = hour - 60,
        end = hour + 3660;
      const expected = f.sqlite
        .prepare(
          'SELECT checked_at,status,latency_ms FROM check_results WHERE monitor_id=1 AND checked_at>=? AND checked_at<=? ORDER BY checked_at',
        )
        .all(start, end)
        .map((row) => ({ ...row }));
      const points = await readLatencyPoints(f.db, 1, start, end);
      expect(points).toEqual(expected);
      expect(latencyStatistics(points)).toEqual({ avg_latency_ms: 23, p95_latency_ms: 40 });
      expect(await readLatencyPoints(f.db, 1, hour + 1, hour + 60)).toEqual([
        { checked_at: hour + 60, status: 'down', latency_ms: null },
      ]);
      expect(latencyStatistics([])).toEqual({ avg_latency_ms: null, p95_latency_ms: null });
      expect(f.calls.every((c) => !c.sql.includes('json_each'))).toBe(true);
    } finally {
      f.sqlite.close();
    }
  });
  it('rejects malformed stored arrays before returning a partial curve', async () => {
    const f = createSqliteD1();
    try {
      f.sqlite
        .prepare('INSERT INTO check_result_buckets VALUES(0,0,?)')
        .run('[[1,60,"up","invalid",null,null,null,1]]');
      await expect(readLatencyPoints(f.db, 1, 0, 120)).rejects.toThrow(
        'Invalid stored check samples',
      );
    } finally {
      f.sqlite.close();
    }
  });
});
