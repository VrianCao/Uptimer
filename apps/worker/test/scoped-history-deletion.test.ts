import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/routes/admin';
import { computePublicHomepagePayload } from '../src/public/homepage';
import {
  incidentStatusPageVisibilityPredicate,
  maintenanceWindowStatusPageVisibilityPredicate,
} from '../src/public/visibility';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('history audience after monitor deletion', () => {
  it('does not publish private history when visibility changes between the read and deletion', async () => {
    const f = createSqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      f.sqlite.exec(`INSERT INTO monitors(id,name,type,target,show_on_status_page)
        VALUES(1,'API','http','https://example.com',1);
        INSERT INTO incidents(id,title,status,impact) VALUES(1,'Private after edit','investigating','minor');
        INSERT INTO incident_monitors(incident_id,monitor_id) VALUES(1,1);`);
      const db = new Proxy(f.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              f.sqlite.prepare('UPDATE monitors SET show_on_status_page=0 WHERE id=?').run(1);
              return target.batch(statements);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const env = {
        DB: db,
        ADMIN_TOKEN: 'test',
        COORDINATOR: { getByName: () => ({ refresh: async () => undefined }) },
      } as unknown as Env;
      const r = await adminRoutes.fetch(
        new Request('https://synthetic.example/monitors/1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer test' },
        }),
        env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as ExecutionContext,
      );
      expect(r.status).toBe(200);
      expect(
        f.sqlite
          .prepare(`SELECT id FROM incidents WHERE ${incidentStatusPageVisibilityPredicate(false)}`)
          .all(),
      ).toEqual([]);
      expect(f.sqlite.prepare('SELECT title FROM incidents WHERE id=1').get()!.title).toBe(
        'Private after edit',
      );
    } finally {
      await Promise.allSettled(pending);
      f.sqlite.close();
    }
  });
  it('preserves legacy global history while keeping deleted monitor history private', async () => {
    const f = createSqliteD1({
      beforeMigration: (sqlite, name) => {
        if (!name.startsWith('0025_')) return;
        sqlite.exec(`
          INSERT INTO monitors(id,name,type,target,show_on_status_page)
          VALUES(1,'Hidden','http','https://example.com',0),
                (2,'Visible','http','https://example.com',1),
                (3,'Hidden again','http','https://example.com',0);
          INSERT INTO incidents(id,title,status,impact,started_at)
          VALUES(1,'Legacy global','investigating','minor',1),
                (2,'Private incident','investigating','critical',1);
          INSERT INTO incident_monitors(incident_id,monitor_id) VALUES(2,1);
          INSERT INTO maintenance_windows(id,title,starts_at,ends_at)
          VALUES(1,'Legacy global',0,2000000000),(2,'Private maintenance',0,2000000000);
          INSERT INTO maintenance_window_monitors(maintenance_window_id,monitor_id) VALUES(2,1);
        `);
      },
    });
    const pending: Promise<unknown>[] = [];
    const env = {
      DB: f.db,
      ADMIN_TOKEN: 'test',
      COORDINATOR: { getByName: () => ({ refresh: async () => undefined }) },
    } as unknown as Env;
    const request = (path: string, method: string, body?: unknown) =>
      adminRoutes.fetch(
        new Request('https://synthetic.example' + path, {
          method,
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as ExecutionContext,
      );
    const visible = () => ({
      incidents: f.sqlite
        .prepare(`SELECT id FROM incidents WHERE ${incidentStatusPageVisibilityPredicate(false)}`)
        .all(),
      maintenance: f.sqlite
        .prepare(
          `SELECT id FROM maintenance_windows WHERE ${maintenanceWindowStatusPageVisibilityPredicate(false)}`,
        )
        .all(),
    });
    try {
      expect(visible()).toEqual({ incidents: [{ id: 1 }], maintenance: [{ id: 1 }] });
      expect((await request('/monitors/1', 'DELETE')).status).toBe(200);
      expect(visible()).toEqual({ incidents: [{ id: 1 }], maintenance: [{ id: 1 }] });
      expect(f.sqlite.prepare('SELECT title FROM incidents WHERE id=2').get()!.title).toBe(
        'Private incident',
      );
      expect(
        f.sqlite.prepare('SELECT title FROM maintenance_windows WHERE id=2').get()!.title,
      ).toBe('Private maintenance');
      const home = await computePublicHomepagePayload(f.db, 1800000000);
      expect(JSON.stringify(home)).not.toContain('Private');
      expect((await request('/maintenance-windows/1', 'PATCH', { monitor_ids: [3] })).status).toBe(
        200,
      );
      expect((await request('/monitors/3', 'DELETE')).status).toBe(200);
      expect(visible().maintenance).toEqual([]);
      const created = await request('/incidents', 'POST', {
        title: 'Public history',
        monitor_ids: [2],
      });
      expect(created.status).toBe(201);
      const { incident } = (await created.json()) as { incident: { id: number } };
      expect((await request('/monitors/2', 'DELETE')).status).toBe(200);
      expect(visible().incidents).toContainEqual({ id: incident.id });
      expect(
        f.sqlite.prepare('SELECT scope FROM incidents WHERE id=?').get(incident.id)!.scope,
      ).toBe('global');
    } finally {
      await Promise.allSettled(pending);
      f.sqlite.close();
    }
  });
});
