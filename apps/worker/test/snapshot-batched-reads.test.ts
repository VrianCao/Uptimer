import { describe, expect, it, vi } from 'vitest';
import { batchSnapshotReads } from '../src/public/batched-reads';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('snapshot read round trips', () => {
  it('combines independent reads, preserves binding/first semantics, and leaves writes explicit', async () => {
    const f = createSqliteD1();
    const batches = vi.spyOn(f.db, 'batch');
    const db = batchSnapshotReads(f.db);
    expect(batchSnapshotReads(db)).toBe(db);
    try {
      const results = await Promise.all([
        db.prepare('SELECT ?1 AS value').bind(42).all(),
        db.prepare('SELECT ?1 AS value').bind('hello').first('value'),
        db.prepare('SELECT 1 AS value WHERE 0').first(),
      ]);
      expect(results[0].results).toEqual([{ value: 42 }]);
      expect(results.slice(1)).toEqual(['hello', null]);
      expect(batches).toHaveBeenCalledTimes(1);
      await db.prepare("INSERT INTO settings(key,value) VALUES ('batched-test','value')").run();
      expect(batches).toHaveBeenCalledTimes(1);
      expect(
        await db.prepare("SELECT value FROM settings WHERE key='batched-test'").first('value'),
      ).toBe('value');
      expect(batches).toHaveBeenCalledTimes(1);
      await expect(db.prepare('SELECT 1 AS value').first('missing')).rejects.toThrow(
        'column not found',
      );
      await db.batch([
        db.prepare("UPDATE settings SET value=?1 WHERE key='batched-test'").bind('updated'),
      ]);
      expect(f.sqlite.prepare("SELECT value FROM settings WHERE key='batched-test'").get()).toEqual(
        { value: 'updated' },
      );
    } finally {
      f.sqlite.close();
    }
  });
  it('rejects every read on batch failure and keeps queues isolated between computations', async () => {
    const f = createSqliteD1();
    const batches = vi.spyOn(f.db, 'batch');
    try {
      const db = batchSnapshotReads(f.db);
      const results = await Promise.allSettled([
        db.prepare('SELECT 1 AS value').all(),
        db.prepare('SELECT * FROM missing_table').all(),
      ]);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      const other = batchSnapshotReads(f.db);
      expect(
        await Promise.all([
          db.prepare('SELECT 2 AS value').first('value'),
          other.prepare('SELECT 3 AS value').first('value'),
        ]),
      ).toEqual([2, 3]);
      expect(batches).toHaveBeenCalledTimes(1);
    } finally {
      f.sqlite.close();
    }
  });
});
