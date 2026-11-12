import { describe, expect, it } from 'vitest';
import { utcDayStart } from '../src/analytics/uptime';
import {
  buildPublicMonitorCards,
  computeTodayPartialUptimeBatch,
  listHeartbeatsByMonitorId,
} from '../src/public/data';
import {
  loadCheckSummary,
  parseCheckSummary,
  recoverCheckSummary,
  serializeCheckSummary,
} from '../src/public/check-summary';
import { createSqliteD1 } from './helpers/sqlite-d1';

const now = 1_800_057_600 + 3600;
function fixture(count = 10) {
  const f = createSqliteD1();
  const monitors = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    interval_sec: 60,
    created_at: now - 10 * 86400,
    last_checked_at: i === count - 1 ? now - 8 * 86400 : now - 60,
    check_summary_json: null as string | null,
  }));
  for (const m of monitors) {
    f.sqlite
      .prepare(
        `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
      VALUES(?,?,'http','https://example.com',?,?)`,
      )
      .run(m.id, `API ${m.id}`, m.created_at, now);
    f.sqlite
      .prepare(
        `INSERT INTO monitor_state(monitor_id,status,last_checked_at)
      VALUES(?,?,?)`,
      )
      .run(m.id, m.id === count ? 'paused' : 'up', m.last_checked_at);
    if (m.id !== count)
      for (let n = 0; n < 70; n++) {
        f.sqlite
          .prepare(
            `INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
        VALUES(?,?,?,?)`,
          )
          .run(m.id, now - (70 - n) * 60, n === 45 ? 'unknown' : 'up', 42 + n);
      }
  }
  return { ...f, monitors };
}

describe('per-monitor summary recovery', () => {
  it('repairs an old paused monitor once while preserving canonical heartbeat and uptime data', async () => {
    const f = fixture();
    try {
      for (const m of f.monitors.slice(0, -1)) {
        m.check_summary_json = serializeCheckSummary(m.id, await loadCheckSummary(f.db, m, now));
        f.sqlite
          .prepare('UPDATE monitor_state SET check_summary_json=? WHERE monitor_id=?')
          .run(m.check_summary_json, m.id);
      }
      const heartbeats = await listHeartbeatsByMonitorId(
        f.db,
        f.monitors.map((m) => m.id),
        60,
        f.monitors,
      );
      const today = await computeTodayPartialUptimeBatch(f.db, f.monitors, utcDayStart(now), now);
      const canonical = f.sqlite
        .prepare(
          'SELECT monitor_id,status,last_checked_at,last_latency_ms FROM monitor_state ORDER BY monitor_id',
        )
        .all();
      const first = await buildPublicMonitorCards(f.db, now);
      for (const card of first.monitors) {
        expect(card.heartbeats).toEqual(heartbeats.get(card.id) ?? []);
        expect(card.uptime_days.at(-1)).toMatchObject(today.get(card.id)!);
      }
      expect(
        f.sqlite
          .prepare(
            'SELECT monitor_id,status,last_checked_at,last_latency_ms FROM monitor_state ORDER BY monitor_id',
          )
          .all(),
      ).toEqual(canonical);
      const repaired = f.sqlite
        .prepare('SELECT check_summary_json FROM monitor_state WHERE monitor_id=10')
        .get()!.check_summary_json as string;
      expect(
        parseCheckSummary({ ...f.monitors[9]!, check_summary_json: repaired }, now + 86400),
      ).toMatchObject({ last: null, heartbeats: [] });
      f.queries.length = 0;
      f.writes.length = 0;
      expect(await buildPublicMonitorCards(f.db, now)).toEqual(first);
      expect(f.queries.some((sql) => /\bFROM check_results\b/i.test(sql))).toBe(false);
      expect(f.writes).toEqual([]);
    } finally {
      f.sqlite.close();
    }
  });

  it('bounds cold repair, scans only remaining IDs, and warms the next call without recurring writes', async () => {
    const f = fixture();
    try {
      f.queries.length = 0;
      f.calls.length = 0;
      f.writes.length = 0;
      const first = await buildPublicMonitorCards(f.db, now);
      expect(f.queries.length).toBeLessThanOrEqual(50);
      expect(f.writes.filter((w) => w.sql.includes('SET check_summary_json')).length).toBe(5);
      const fallback = f.calls.filter(
        (c) => c.sql.includes('FROM check_results cr') || c.sql.includes('ROW_NUMBER()'),
      );
      expect(fallback.length).toBeGreaterThan(0);
      for (const c of fallback) expect(c.args).not.toContain(1);
      expect(await buildPublicMonitorCards(f.db, now)).toEqual(first);
      f.queries.length = 0;
      f.writes.length = 0;
      await buildPublicMonitorCards(f.db, now + 86400);
      expect(f.queries.some((sql) => /\bFROM check_results\b/i.test(sql))).toBe(false);
      expect(f.writes).toEqual([]);
    } finally {
      f.sqlite.close();
    }
  });

  it.each(['probe', 'config', 'summary'])(
    'does not overwrite a concurrent %s change',
    async (kind) => {
      const f = fixture(1);
      try {
        const guarded = new Proxy(f.db, {
          get(target, key) {
            if (key === 'prepare')
              return (sql: string) => {
                if (sql.startsWith('UPDATE monitor_state SET check_summary_json')) {
                  if (kind === 'probe')
                    f.sqlite.prepare('UPDATE monitor_state SET last_checked_at=?').run(now);
                  if (kind === 'config') f.sqlite.exec('UPDATE monitors SET interval_sec=300');
                  if (kind === 'summary')
                    f.sqlite.exec("UPDATE monitor_state SET check_summary_json='{}'");
                }
                return target.prepare(sql);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await recoverCheckSummary(guarded, f.monitors[0]!, now);
        expect(
          f.sqlite.prepare('SELECT check_summary_json FROM monitor_state').get()!
            .check_summary_json,
        ).toBe(kind === 'summary' ? '{}' : null);
      } finally {
        f.sqlite.close();
      }
    },
  );
});
