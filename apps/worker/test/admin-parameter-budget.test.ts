import { describe, it, expect } from 'vitest';
import { adminRoutes } from '../src/routes/admin';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('D1 parameter limits on large administrative requests', () => {
  it('keeps all incident links, exports and bulk monitor assignments below 100 parameters', async () => {
    const f = createSqliteD1();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as ExecutionContext;
    const env = {
      DB: f.db,
      ADMIN_TOKEN: 'test',
      COORDINATOR: { getByName: () => ({ refresh: async () => undefined }) },
    } as unknown as Env;
    const request = (path: string, body?: unknown) =>
      adminRoutes.fetch(
        new Request('https://synthetic.example' + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        ctx,
      );
    try {
      for (let id = 1; id <= 150; id++)
        f.sqlite
          .prepare(
            "INSERT INTO monitors(id,name,type,target)VALUES(?,?,'http','https://example.com')",
          )
          .run(id, 'Monitor ' + id);
      const now = Math.floor(Date.now() / 1000);
      for (let id = 1; id <= 250; id++) {
        f.sqlite
          .prepare(
            "INSERT INTO incidents(id,title,status,impact,started_at)VALUES(?,?,'investigating','minor',?)",
          )
          .run(id, 'Incident ' + id, now - 600 - id);
        f.sqlite
          .prepare('INSERT INTO incident_monitors(incident_id,monitor_id)VALUES(?,1)')
          .run(id);
        f.sqlite
          .prepare('INSERT INTO incident_updates(incident_id,message)VALUES(?,?)')
          .run(id, 'Update ' + id);
      }
      const listed = await request('/incidents?limit=200');
      expect(listed.status).toBe(200);
      const incidents = (
        (await listed.json()) as { incidents: Array<{ updates: unknown[]; monitor_ids: number[] }> }
      ).incidents;
      expect(incidents).toHaveLength(200);
      expect(
        incidents.every((i) => i.updates.length === 1 && i.monitor_ids.join(',') === '1'),
      ).toBe(true);
      const exported = await request('/exports/incidents.csv?range=90d&limit=5000');
      expect(exported.status).toBe(200);
      const lines = (await exported.text()).trim().split('\n');
      expect(lines).toHaveLength(251);
      expect(lines.slice(1).every((line) => line.split(',')[6] === '[1]')).toBe(true);
      const ids = Array.from({ length: 150 }, (_, i) => i + 1);
      const assigned = await request('/monitors/groups/assign', {
        monitor_ids: ids,
        group_name: 'All',
        group_sort_order: 1,
      });
      expect(assigned.status).toBe(200);
      expect(
        f.sqlite.prepare("SELECT count(*) AS n FROM monitors WHERE group_name='All'").get()!.n,
      ).toBe(150);
      const created = await request('/incidents', {
        title: 'Wide scope',
        status: 'investigating',
        impact: 'minor',
        monitor_ids: ids,
      });
      expect(created.status).toBe(201);
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM incident_monitors WHERE incident_id=(SELECT max(id) FROM incidents)',
          )
          .get()!.n,
      ).toBe(150);
      // Reordering many independent groups must stay atomic and bounded too.
      f.sqlite.exec("UPDATE monitors SET group_name='Group ' || id");
      f.sqlite.exec("UPDATE monitors SET group_name='   ' WHERE id=150");
      const reordered = await request('/monitors/groups/reorder', {
        groups: ids.map((id) => ({
          group_name: id === 150 ? null : ` group ${id} `,
          group_sort_order: 1000 - id,
        })),
      });
      expect(reordered.status).toBe(200);
      expect(await reordered.json()).toMatchObject({ updated_groups: 150, affected_monitors: 150 });
      expect(
        f.sqlite.prepare('SELECT count(*) AS n FROM monitors WHERE group_sort_order=1000-id').get()!
          .n,
      ).toBe(150);
      await Promise.all(pending);
      expect(Math.max(...f.calls.map((call) => call.args.length))).toBeLessThanOrEqual(100);
    } finally {
      await Promise.allSettled(pending);
      f.sqlite.close();
    }
  });
});
