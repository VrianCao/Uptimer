import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { legacyMaintenanceResponse, withLegacyWriter } from '../src/legacy-upgrade';

describe('legacy upgrade runtime', () => {
  it('authorizes writes within their batch and leaves raw and delayed legacy writes fenced', async () => {
    const { db, sqlite, queries } = createSqliteD1();
    try {
      sqlite.exec(`
        CREATE TABLE fixture_d1 (id INTEGER PRIMARY KEY, text TEXT);
        CREATE TRIGGER fixture_legacy BEFORE INSERT ON fixture_d1
        WHEN (SELECT defer_foreign_keys FROM pragma_defer_foreign_keys) IS NOT 1
        BEGIN SELECT RAISE(ABORT, 'obsolete writer'); END;
      `);
      const guarded = withLegacyWriter({
        DB: db,
        ADMIN_TOKEN: 'unused',
        UPTIMER_D1_LEGACY_FENCE: '1',
      }).DB;
      await expect(db.prepare("INSERT INTO fixture_d1 VALUES (1,'old')").run()).rejects.toThrow(
        'obsolete writer',
      );
      await expect(
        guarded.prepare('SELECT COUNT(*) AS n FROM fixture_d1').first('n'),
      ).resolves.toBe(0);
      expect(queries).not.toContain('PRAGMA defer_foreign_keys = ON');
      const write = guarded.prepare('INSERT INTO fixture_d1 VALUES (?,?) RETURNING id');
      await expect(write.bind(1, 'current').first('id')).resolves.toBe(1);
      await expect(
        guarded.batch([write.bind(2, 'current'), write.bind(3, 'current')]),
      ).resolves.toHaveLength(2);
      await expect(
        db.prepare("INSERT INTO fixture_d1 VALUES (4,'delayed old')").run(),
      ).rejects.toThrow('obsolete writer');
      await expect(
        guarded.prepare('SELECT COUNT(*) AS n FROM fixture_d1').first('n'),
      ).resolves.toBe(3);
    } finally {
      sqlite.close();
    }
  });

  it('serves the last published homepage with its original timestamp and a maintenance message', async () => {
    const { db, sqlite, writes } = createSqliteD1();
    try {
      const generatedAt = 1_728_000_000;
      const data = {
        generated_at: generatedAt,
        bootstrap_mode: 'full',
        monitor_count_total: 0,
        site_title: 'Status Hub',
        site_description: 'Production services',
        site_locale: 'auto',
        site_timezone: 'UTC',
        uptime_rating_level: 3,
        overall_status: 'up',
        banner: { source: 'monitors', status: 'operational', title: 'All Systems Operational' },
        summary: { up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 },
        monitors: [],
        active_incidents: [],
        maintenance_windows: { active: [], upcoming: [] },
        resolved_incident_preview: null,
        maintenance_history_preview: null,
      };
      sqlite.exec(
        'CREATE TABLE uptimer_legacy_upgrade (id INTEGER PRIMARY KEY, public_homepage TEXT, public_status TEXT)',
      );
      sqlite
        .prepare('INSERT INTO uptimer_legacy_upgrade (id,public_homepage) VALUES (1,?)')
        .run(JSON.stringify(data));
      const response = await legacyMaintenanceResponse(
        new Request('https://status.example/api/v1/public/homepage'),
        { DB: db, ADMIN_TOKEN: 'unused' },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Uptimer-Maintenance')).toBe('upgrade');
      expect(await response.json()).toMatchObject({
        generated_at: generatedAt,
        site_title: 'Status Hub',
        site_description: expect.stringContaining('Monitoring is paused'),
      });
      expect(writes).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it('returns maintenance to writers without preparing a D1 statement', async () => {
    const response = await legacyMaintenanceResponse(
      new Request('https://status.example/api/v1/admin/monitors', { method: 'POST' }),
      { DB: {} as D1Database, ADMIN_TOKEN: 'unused' },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Uptimer-Maintenance')).toBe('upgrade');
  });
});
