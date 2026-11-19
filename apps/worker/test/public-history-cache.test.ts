import { describe, expect, it } from 'vitest';
import {
  invalidatePublicHistoryRows,
  PUBLIC_HISTORY_CACHE_KEY,
  readPublicHistoryRows,
} from '../src/public/history-cache';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('completed-day history cache', () => {
  it.each(['malformed', 'old-day'] as const)(
    'rebuilds %s history supplied with a monitor page',
    async (kind) => {
      const { db, sqlite, queries } = createSqliteD1();
      const day = 1_799_971_200;
      try {
        sqlite.exec(
          "INSERT INTO monitors(id,name,type,target) VALUES (1,'API','http','https://example.com')",
        );
        const result = await readPublicHistoryRows(db, [1], day - 60 * 86400, day, [
          {
            fragment_key: 'monitor:1',
            generated_at: kind === 'old-day' ? day - 86400 : day,
            body_json: kind === 'malformed' ? '[[1,"bad"]]' : '[[1,86400,0,0,86400]]',
          },
        ]);
        expect(result).toEqual([]);
        expect(queries.some((sql) => sql.includes('FROM monitor_daily_rollups'))).toBe(true);
        const before = queries.length;
        expect(
          await readPublicHistoryRows(db, [1], day - 60 * 86400, day, [
            {
              fragment_key: 'monitor:1',
              generated_at: day,
              body_json: '[]',
            },
          ]),
        ).toEqual([]);
        expect(queries.length).toBe(before);
      } finally {
        sqlite.close();
      }
    },
  );
  it('avoids repeating historical row scans and rebuilds after rollup and midnight', async () => {
    const { db, sqlite, queries, writes } = createSqliteD1();
    const day = 1_799_971_200;
    sqlite
      .prepare(
        `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
      VALUES (1,'API','http','https://example.com',?,?)`,
      )
      .run(day - 864000, day);
    sqlite
      .prepare(
        `INSERT INTO monitor_daily_rollups(monitor_id,day_start_at,total_sec,downtime_sec,unknown_sec,uptime_sec,checks_total,checks_up,checks_down,checks_unknown,checks_maintenance)
      VALUES (1,?,86400,0,0,86400,1440,1440,0,0,0)`,
      )
      .run(day - 86400);
    const first = await readPublicHistoryRows(db, [1], day - 60 * 86400, day);
    expect(first).toEqual([
      {
        monitor_id: 1,
        day_start_at: day - 86400,
        total_sec: 86400,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 86400,
      },
    ]);
    const baselineQueries = queries.length,
      baselineWrites = writes.length;
    expect(await readPublicHistoryRows(db, [1], day - 60 * 86400, day)).toEqual(first);
    expect(
      queries.slice(baselineQueries).some((sql) => sql.includes('FROM monitor_daily_rollups')),
    ).toBe(false);
    expect(writes.length).toBe(baselineWrites);
    sqlite.exec('UPDATE monitor_daily_rollups SET downtime_sec=60,uptime_sec=86340');
    await invalidatePublicHistoryRows(db);
    expect((await readPublicHistoryRows(db, [1], day - 60 * 86400, day))[0]?.downtime_sec).toBe(60);
    await readPublicHistoryRows(db, [1], day - 60 * 86400, day + 86400);
    expect(
      sqlite
        .prepare('SELECT generated_at FROM public_snapshot_fragments WHERE snapshot_key=?')
        .get(PUBLIC_HISTORY_CACHE_KEY)?.generated_at,
    ).toBe(day + 86400);
    sqlite.close();
  });
  it('repairs malformed persisted JSON without exposing it as history', async () => {
    const { db, sqlite } = createSqliteD1();
    const day = 1_799_971_200;
    sqlite
      .prepare(
        `INSERT INTO monitors(id,name,type,target) VALUES (1,'API','http','https://example.com')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO public_snapshot_fragments(snapshot_key,fragment_key,generated_at,body_json,updated_at)
      VALUES (?,'monitor:1',?,'[[1,"bad"]]',?)`,
      )
      .run(PUBLIC_HISTORY_CACHE_KEY, day, day);
    expect(await readPublicHistoryRows(db, [1], day - 60 * 86400, day)).toEqual([]);
    expect(
      sqlite
        .prepare('SELECT body_json FROM public_snapshot_fragments WHERE snapshot_key=?')
        .get(PUBLIC_HISTORY_CACHE_KEY)?.body_json,
    ).toBe('[]');
    sqlite.close();
  });
});
