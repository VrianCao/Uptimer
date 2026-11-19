import { describe, expect, it } from 'vitest';
import { publicRoutes } from '../src/routes/public';
import { publicUiRoutes } from '../src/routes/public-ui';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('maintenance history audience', () => {
  it.each([
    ['full', publicRoutes],
    ['light', publicUiRoutes],
  ] as const)(
    '%s filters scoped orphans before pagination while retaining admin history',
    async (_name, router) => {
      const f = createSqliteD1();
      try {
        f.sqlite.exec(`
        INSERT INTO monitors(id,name,type,target,show_on_status_page)
        VALUES(1,'Visible','http','https://example.com',1),
              (2,'Hidden','http','https://example.com',0);
        INSERT INTO maintenance_windows(id,title,starts_at,ends_at,scope)
        VALUES(1,'Legacy global',0,100,'global'),
              (2,'Visible linked',0,200,'monitors'),
              (3,'Hidden linked',0,300,'monitors'),
              (4,'Deleted hidden monitor',0,400,'monitors'),
              (5,'Preserved public history',0,500,'global');
        INSERT INTO maintenance_window_monitors(maintenance_window_id,monitor_id)
        VALUES(2,1),(3,2);
      `);
        const get = async (query: string, admin = false) => {
          const r = await router.fetch(
            new Request('https://synthetic.example/maintenance-windows?' + query, {
              headers: {
                'Cache-Control': 'no-store',
                ...(admin ? { Authorization: 'Bearer test' } : {}),
              },
            }),
            { DB: f.db, ADMIN_TOKEN: 'test' } as Env,
          );
          expect(r.status).toBe(200);
          return (await r.json()) as {
            maintenance_windows: Array<{ id: number }>;
            next_cursor: number | null;
          };
        };
        const ids: number[] = [];
        let cursor: number | null = null;
        do {
          const data = await get('limit=1' + (cursor ? '&cursor=' + cursor : ''));
          ids.push(...data.maintenance_windows.map((w) => w.id));
          cursor = data.next_cursor;
        } while (cursor);
        expect(ids).toEqual([5, 2, 1]);
        expect((await get('limit=200')).maintenance_windows.map((w) => w.id)).toEqual([5, 2, 1]);
        expect((await get('limit=200', true)).maintenance_windows.map((w) => w.id)).toEqual([
          5, 4, 3, 2, 1,
        ]);
        expect(
          f.sqlite.prepare('SELECT title FROM maintenance_windows WHERE id=4').get()!.title,
        ).toBe('Deleted hidden monitor');
      } finally {
        f.sqlite.close();
      }
    },
  );
});
