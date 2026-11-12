import { describe, expect, it } from 'vitest';
import {
  appendCheck,
  loadCheckSummary,
  parseCheckSummary,
  summaryUptime,
  serializeCheckSummary,
} from '../src/public/check-summary';
import { computeTodayPartialUptimeBatch, listHeartbeatsByMonitorId } from '../src/public/data';
import { utcDayStart } from '../src/analytics/uptime';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('check summary parity with complete canonical history', () => {
  it('keeps validated cache entries immutable and rejects changed invalid DB JSON', async () => {
    const { db, sqlite } = createSqliteD1();
    const at = 1_800_057_600;
    const monitor = {
      id: 1,
      interval_sec: 60,
      created_at: at,
      last_checked_at: null as number | null,
    };
    const empty = await loadCheckSummary(db, monitor, at);
    const original = appendCheck(appendCheck(empty, at, 'unknown', null), at + 60, 'unknown', null);
    const raw = serializeCheckSummary(1, original);
    const { state_checked_at: _stamp, ...legacy } = original;
    expect(
      parseCheckSummary(
        { ...monitor, last_checked_at: at + 60, check_summary_json: JSON.stringify(legacy) },
        at + 61,
      ),
    ).not.toBeNull();
    expect(
      parseCheckSummary(
        {
          ...monitor,
          last_checked_at: at + 60,
          check_summary_json: JSON.stringify({ ...original, state_checked_at: -1 }),
        },
        at + 61,
      ),
    ).toBeNull();
    const next = appendCheck(original, at + 120, 'up', 42);
    expect(JSON.stringify(original)).toBe(raw);
    expect(next.gaps).toEqual([[at, at + 120, 1]]);
    expect(
      parseCheckSummary({ ...monitor, last_checked_at: at + 60, check_summary_json: raw }, at + 61)
        ?.gaps,
    ).toEqual([[at, at + 60, 1]]);
    expect(
      parseCheckSummary(
        {
          ...monitor,
          last_checked_at: at + 60,
          check_summary_json: JSON.stringify({ ...original, heartbeats: [[-1, 'up', 42]] }),
        },
        at + 61,
      ),
    ).toBeNull();
    sqlite.close();
  });
  it.each([false, true])(
    'matches gaps, UNKNOWN, outages, midnight and interval edits; new=%s',
    async (isNew) => {
      const { db, sqlite } = createSqliteD1();
      const day = 1_800_057_600;
      const monitor = {
        id: 1,
        interval_sec: 60,
        created_at: isNew ? day + 120 : day - 86400 * 10,
        last_checked_at: null as number | null,
        check_summary_json: null as string | null,
      };
      sqlite
        .prepare(
          "INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES (1,'API','http','https://example.com',?,?)",
        )
        .run(monitor.created_at, monitor.created_at);
      sqlite
        .prepare('INSERT INTO outages(monitor_id,started_at,ended_at) VALUES (1,?,?)')
        .run(day + 350, day + 1400);
      const insert = sqlite.prepare(
        'INSERT INTO check_results(monitor_id,checked_at,status,latency_ms) VALUES (1,?,?,?)',
      );
      let at = isNew ? day + 120 : day - 180;
      let summary = await loadCheckSummary(db, monitor, at);
      for (let n = 0; n < 70; n++) {
        at += n === 20 ? 86400 : [60, 60, 180, 300, 60, 900][n % 6]!;
        if (n === 40) {
          monitor.interval_sec = 300;
          summary = await loadCheckSummary(db, monitor, at);
        }
        const status = n % 7 < 3 ? 'unknown' : n % 5 === 0 ? 'down' : 'up';
        summary = appendCheck(summary, at, status, 40 + n);
        insert.run(at, status, 40 + n);
        monitor.last_checked_at = at;
        monitor.check_summary_json = JSON.stringify(summary);
        for (const offset of [0, 1, 80, 900]) {
          const now = at + offset;
          const current = parseCheckSummary(monitor, now)!;
          const actual = await summaryUptime(
            db,
            [monitor],
            new Map([[1, current]]),
            utcDayStart(now),
            now,
          );
          const expected = await computeTodayPartialUptimeBatch(
            db,
            [monitor],
            utcDayStart(now),
            now,
          );
          expect(actual.get(1), `probe=${n} offset=${offset}`).toEqual(expected.get(1));
        }
        expect(
          summary.heartbeats.map(([checked_at, status, latency_ms]) => ({
            checked_at,
            status,
            latency_ms,
          })),
        ).toEqual((await listHeartbeatsByMonitorId(db, [1], 60, [monitor])).get(1));
      }
      expect(parseCheckSummary({ ...monitor, check_summary_json: '{"version":1}' }, at)).toBeNull();
      expect(parseCheckSummary({ ...monitor, interval_sec: 600 }, at)).toBeNull();
      sqlite.close();
    },
  );
});
