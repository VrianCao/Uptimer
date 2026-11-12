import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { readLatencyPoints } from '../src/public/latency-points';
import { loadCheckSummary } from '../src/public/check-summary';

const historicalSql = readFileSync(
  new URL(
    '../../../Develop/Legacy-Experiments/0014_check_results_without_autoincrement.sql',
    import.meta.url,
  ),
  'utf8',
);
describe('historical Dev legacy-table variant', () => {
  it.each([false, true])(
    'preserves fields and current reads/writes; historical=%s',
    async (historical) => {
      const f = createSqliteD1({
        beforeMigration(sqlite, name) {
          if (!name.startsWith('0014_')) return;
          sqlite
            .prepare(
              `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
        VALUES(1,'API','http','https://example.com',0,0)`,
            )
            .run();
          sqlite
            .prepare(
              "INSERT INTO monitor_state(monitor_id,status,last_checked_at) VALUES(1,'up',120)",
            )
            .run();
          const insert = sqlite.prepare(
            'INSERT INTO check_results(monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt) VALUES(?,?,?,?,?,?,?,?)',
          );
          insert.run(1, 60, 'down', null, 503, '故障 "quoted"\nline', 'HKG', 3);
          insert.run(1, 120, 'up', 42, 200, null, null, 1);
          if (historical) sqlite.exec(historicalSql);
        },
      });
      try {
        const ddl = f.sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE name='check_results_legacy'")
          .get()!.sql as string;
        expect(ddl.includes('AUTOINCREMENT')).toBe(!historical);
        const rows = f.sqlite
          .prepare(
            'SELECT monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt FROM check_results_legacy ORDER BY id',
          )
          .all()
          .map(Object.values);
        expect(rows).toEqual([
          [1, 60, 'down', null, 503, '故障 "quoted"\nline', 'HKG', 3],
          [1, 120, 'up', 42, 200, null, null, 1],
        ]);
        await f.db
          .prepare(
            'INSERT INTO check_results(monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt) VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(1, 180, 'unknown', null, null, 'timeout', null, 3)
          .run();
        await f.db
          .prepare(
            'UPDATE monitor_state SET last_checked_at=?,pending_hour=?,pending_samples_json=? WHERE monitor_id=?',
          )
          .bind(240, 0, JSON.stringify([[1, 240, 'up', 23, 204, null, null, 1]]), 1)
          .run();
        const points = await readLatencyPoints(f.db, 1, 0, 240);
        expect(points).toEqual([
          { checked_at: 60, status: 'down', latency_ms: null },
          { checked_at: 120, status: 'up', latency_ms: 42 },
          { checked_at: 180, status: 'unknown', latency_ms: null },
          { checked_at: 240, status: 'up', latency_ms: 23 },
        ]);
        const summary = await loadCheckSummary(
          f.db,
          { id: 1, interval_sec: 60, created_at: 0, last_checked_at: 240 },
          240,
        );
        expect(
          summary.heartbeats.map(([checked_at, status, latency_ms]) => ({
            checked_at,
            status,
            latency_ms,
          })),
        ).toEqual([...points].reverse());
        expect(f.sqlite.prepare('SELECT count(*) n FROM check_results_legacy').get()!.n).toBe(2);
      } finally {
        f.sqlite.close();
      }
    },
  );
});
