import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/routes/admin';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('monitor list pagination', () => {
  it('preserves configured ordering and all monitors across page boundaries and deleted cursors', async () => {
    const f = createSqliteD1();
    try {
      const insert = f.sqlite.prepare(
        "INSERT INTO monitors(id,name,type,target,group_name,group_sort_order,sort_order) VALUES(?,?,'http','https://example.com',?,?,?)",
      );
      for (let id = 1; id <= 235; id++)
        insert.run(id, `Monitor ${id}`, id % 3 ? '分组 A' : null, id % 4, id % 7);
      const expected = f.sqlite
        .prepare('SELECT id FROM monitors ORDER BY group_sort_order,group_name,sort_order,id')
        .all()
        .map((r) => r.id);
      const env = { DB: f.db, ADMIN_TOKEN: 'test' } as Env;
      const ids: number[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
        const r = await adminRoutes.fetch(
          new Request('https://synthetic.example/monitors?' + params, {
            headers: { Authorization: 'Bearer test' },
          }),
          env,
        );
        expect(r.status).toBe(200);
        const page = (await r.json()) as {
          monitors: Array<{ id: number }>;
          next_cursor: string | null;
        };
        expect(page.monitors.length).toBeLessThanOrEqual(50);
        ids.push(...page.monitors.map((m) => m.id));
        cursor = page.next_cursor;
        if (ids.length === 50) f.sqlite.prepare('DELETE FROM monitors WHERE id=?').run(ids.at(-1)!);
      } while (cursor);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(235);
    } finally {
      f.sqlite.close();
    }
  });
});
