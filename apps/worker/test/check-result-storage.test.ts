import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../migrations/', import.meta.url);
function createDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrations).sort()) {
    if (name.endsWith('.sql')) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  return db;
}

describe('lossless check result storage', () => {
  it('appends a completed pair atomically with one bucket update and preserves every field', () => {
    const db = createDatabase();
    const source = readFileSync(new URL('../src/scheduler/scheduled.ts', import.meta.url), 'utf8');
    const sql = source.match(/db.prepare\(`\s*(INSERT INTO check_result_buckets[\s\S]*?)`\)/)![1]!;
    const first = [
      [1, 3600, 'up', 42, 200, null, null, 1],
      [2, 3600, 'down', null, 503, '故障 "quoted"\nline', 'HKG', 3],
    ];
    const statement = db.prepare(sql.replace(/\?\d+/g, '?'));
    expect(statement.run(JSON.stringify(first)).changes).toBe(1);
    const second = [
      [1, 3660, 'unknown', null, null, 'timeout', null, 2],
      [2, 3660, 'up', 23, 204, null, null, 1],
    ];
    expect(statement.run(JSON.stringify(second)).changes).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({ n: 1 });
    const rows = db
      .prepare(
        `SELECT monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt
      FROM check_results ORDER BY checked_at,monitor_id`,
      )
      .all()
      .map(Object.values);
    expect(rows).toEqual([...first, ...second]);
    db.close();
  });
  it('reads existing history after migration without rewriting it', () => {
    const db = new DatabaseSync(':memory:');
    for (const name of readdirSync(migrations).sort()) {
      if (!name.endsWith('.sql')) continue;
      if (name.startsWith('0016')) {
        db.exec(
          "INSERT INTO check_results(monitor_id,checked_at,status,latency_ms) VALUES (1,60,'up',42)",
        );
      }
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    expect(
      db.prepare('SELECT monitor_id,checked_at,status,latency_ms FROM check_results').get(),
    ).toEqual({ monitor_id: 1, checked_at: 60, status: 'up', latency_ms: 42 });
    expect(db.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({ n: 0 });
    db.close();
  });

  it('keeps every sample, failures, retries and duplicate timestamps in one hourly row', () => {
    const db = createDatabase();
    const insert = db.prepare(`INSERT INTO check_results
      (monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt)
      VALUES (?,?,?,?,?,?,?,?)`);
    const expected = [];
    for (let i = 0; i < 60; i++) {
      const row = [
        1,
        i * 60,
        i % 5 === 0 ? 'down' : 'up',
        10 + i,
        200,
        i % 5 === 0 ? 'timeout' : null,
        null,
        3,
      ];
      insert.run(...row);
      expected.push(row);
    }
    insert.run(1, 3540, 'unknown', null, null, 'unreadable', 'HKG', 1);
    expect(db.prepare('SELECT count(*) AS n FROM check_result_buckets').get()).toEqual({ n: 1 });
    const rows = db
      .prepare(
        `SELECT monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt
      FROM check_results ORDER BY checked_at,id`,
      )
      .all();
    expect(rows.map(Object.values)).toEqual([
      ...expected,
      [1, 3540, 'unknown', null, null, 'unreadable', 'HKG', 1],
    ]);
    expect(
      db.prepare('SELECT samples_json FROM check_result_buckets').get()?.samples_json,
    ).toBeTruthy();
    db.close();
  });

  it('preserves legacy DELETE semantics without shifting later samples', () => {
    const db = createDatabase();
    db.exec(
      "INSERT INTO check_results(monitor_id,checked_at,status) VALUES (1,60,'up'),(1,120,'down'),(1,180,'up'),(2,120,'up')",
    );
    db.exec('DELETE FROM check_results WHERE monitor_id=1 AND checked_at<180');
    expect(
      db.prepare('SELECT monitor_id,checked_at FROM check_results ORDER BY monitor_id').all(),
    ).toEqual([
      { monitor_id: 1, checked_at: 180 },
      { monitor_id: 2, checked_at: 120 },
    ]);
    db.close();
  });

  it('pushes monitor and bucket time bounds into an indexed lookup', () => {
    const db = createDatabase();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT checked_at,status,latency_ms FROM check_results
      WHERE monitor_id=1 AND storage_shard=0 AND bucket_start_at>=3600 AND checked_at>=3600 AND checked_at<7200`,
      )
      .all();
    expect(
      plan.some((row) => String(row.detail).includes('shard_id=? AND bucket_start_at>?')),
    ).toBe(true);
    db.close();
  });

  it('indexes cross-monitor time windows and whole-bucket retention', () => {
    const db = createDatabase();
    for (const sql of [
      'SELECT checked_at FROM check_results WHERE bucket_start_at>=3600 AND checked_at>=3600',
      'DELETE FROM check_result_buckets WHERE bucket_start_at<=7200-3600',
    ]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      expect(plan.some((row) => String(row.detail).includes('idx_check_result_buckets_time'))).toBe(
        true,
      );
    }
    db.close();
  });

  it('does not write an identical fragment again, but accepts a corrected same-generation payload', () => {
    const db = createDatabase();
    const source = readFileSync(
      new URL('../src/snapshots/public-fragments.ts', import.meta.url),
      'utf8',
    );
    const sql = source.match(/const UPSERT_FRAGMENT_SQL = `([\s\S]*?)`;/)![1]!;
    const stmt = db.prepare(sql.replace(/\?\d+/g, '?'));
    expect(stmt.run('homepage:monitors', 'monitor:1', 100, '{"id":1}', 101).changes).toBe(1);
    expect(stmt.run('homepage:monitors', 'monitor:1', 100, '{"id":1}', 200).changes).toBe(0);
    expect(
      stmt.run('homepage:monitors', 'monitor:1', 100, '{"id":1,"status":"down"}', 200).changes,
    ).toBe(1);
    expect(stmt.run('homepage:monitors', 'monitor:1', 99, '{"id":1}', 201).changes).toBe(0);
    db.close();
  });
});
