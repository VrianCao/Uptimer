import { describe, expect, it } from 'vitest';
import { buildPublicMonitorCards } from '../src/public/data';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('outage history growth and current-day reads', () => {
  it('keeps exact overlap boundaries while seeking both end-time ranges', async () => {
    const f = createSqliteD1();
    const day = 1_800_057_600,
      now = day + 3600;
    try {
      for (const id of [1, 2]) {
        f.sqlite
          .prepare(
            `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
          VALUES(?,?,'http','https://example.com',?,?)`,
          )
          .run(id, `API ${id}`, day - 365 * 86400, now);
        f.sqlite
          .prepare("INSERT INTO monitor_state(monitor_id,status,last_checked_at) VALUES(?,'up',?)")
          .run(id, now - 60);
        f.sqlite
          .prepare(
            "INSERT INTO check_results(monitor_id,checked_at,status,latency_ms) VALUES(?,?,'up',42)",
          )
          .run(id, now - 60);
      }
      const insert = f.sqlite.prepare(
        'INSERT INTO outages(monitor_id,started_at,ended_at) VALUES(?,?,?)',
      );
      for (let n = 0; n < 2000; n++) insert.run(1, day - 100000 - n * 60, day - 99999 - n * 60);
      for (const [start, end] of [
        [day - 60, day],
        [day - 60, day + 60],
        [day + 300, day + 360],
        [day + 3500, null],
        [now, now + 60],
      ])
        insert.run(1, start!, end!);
      await buildPublicMonitorCards(f.db, now, {
        monitorSlice: { offset: 0, limit: 10 },
        presentationContext: {
          monitorIds: [1, 2],
          maintenanceMonitorIds: [],
          uptimeRatingLevel: 3,
          rangeStart: day - 60 * 86400,
        },
      });
      const call = f.calls.find((c) => c.sql.includes('AS day_outages_json'))!;
      const result = await f.db
        .prepare(call.sql)
        .bind(...call.args)
        .all<{ id: number; day_outages_json: string }>();
      const original = f.sqlite
        .prepare(
          `SELECT started_at,ended_at FROM outages WHERE monitor_id=1
        AND started_at<? AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at`,
        )
        .all(now, day);
      const actual = JSON.parse(
        result.results.find((row) => row.id === 1)!.day_outages_json,
      ) as Array<[number, number | null]>;
      expect(actual.sort((a, b) => a[0] - b[0])).toEqual(
        original.map((row) => [row.started_at, row.ended_at]),
      );
      expect(result.results.find((row) => row.id === 2)!.day_outages_json).toBe('[]');
      const plan = await f.db
        .prepare('EXPLAIN QUERY PLAN ' + call.sql)
        .bind(...call.args)
        .all<{ detail: string }>();
      const seeks = plan.results
        .filter((row) => row.detail.includes('idx_outages_monitor_end_start'))
        .map((row) => row.detail);
      expect(seeks).toHaveLength(2);
      expect(seeks.some((s) => s.includes('ended_at=?'))).toBe(true);
      expect(seeks.some((s) => s.includes('ended_at>?'))).toBe(true);
    } finally {
      f.sqlite.close();
    }
  });
  it('uses the same index to update an open outage without walking closed history', async () => {
    const f = createSqliteD1();
    try {
      const plan = await f.db
        .prepare(
          `EXPLAIN QUERY PLAN UPDATE outages SET last_error=?1
        WHERE monitor_id=?2 AND ended_at IS NULL AND last_error IS NOT ?1`,
        )
        .bind('timeout', 1)
        .all<{ detail: string }>();
      expect(
        plan.results.some(
          (row) =>
            row.detail.includes('idx_outages_monitor_end_start') &&
            row.detail.includes('ended_at=?'),
        ),
      ).toBe(true);
    } finally {
      f.sqlite.close();
    }
  });
});
