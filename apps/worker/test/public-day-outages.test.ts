import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicRoutes } from '../src/routes/public';
import { publicUiRoutes } from '../src/routes/public-ui';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('selected-day public outage history', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ['full', publicRoutes],
    ['light', publicUiRoutes],
  ] as const)(
    '%s keeps old-day intervals complete across pagination without admitting adjacent days',
    async (_name, router) => {
      const f = createSqliteD1();
      const now = 1800000120,
        today = Math.floor(now / 86400) * 86400,
        day = today - 45 * 86400;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      try {
        f.sqlite
          .prepare(
            "INSERT INTO monitors(id,name,type,target,created_at) VALUES(1,'API','http','https://example.com',?)",
          )
          .run(today - 100 * 86400);
        const insert = f.sqlite.prepare(
          'INSERT INTO outages(monitor_id,started_at,ended_at) VALUES(1,?,?)',
        );
        for (let i = 0; i < 240; i++) insert.run(day + i * 2, day + i * 2 + 1);
        insert.run(day - 60, day + 30); // Crosses midnight, belongs to the selected day.
        insert.run(day - 60, day); // Exact end at the boundary is excluded.
        insert.run(day + 86400, day + 86460); // Next day is excluded.
        const env = { DB: f.db } as Env;
        const get = (query: string) =>
          router.fetch(
            new Request('https://synthetic.example/monitors/1/outages?' + query, {
              headers: { 'Cache-Control': 'no-store' },
            }),
            env,
          );
        const ids: number[] = [];
        let cursor: number | null = null;
        do {
          const r = await get(
            new URLSearchParams({
              day_start_at: String(day),
              ...(cursor ? { cursor: String(cursor) } : {}),
            }).toString(),
          );
          expect(r.status).toBe(200);
          const data = (await r.json()) as {
            range_start_at: number;
            range_end_at: number;
            next_cursor: number | null;
            outages: Array<{ id: number; started_at: number; ended_at: number }>;
          };
          expect(data.range_start_at).toBe(day);
          expect(data.range_end_at).toBe(day + 86400);
          expect(data.outages.every((o) => o.started_at < day + 86400 && o.ended_at > day)).toBe(
            true,
          );
          ids.push(...data.outages.map((o) => o.id));
          cursor = data.next_cursor;
        } while (cursor);
        expect(ids).toHaveLength(241);
        expect(new Set(ids).size).toBe(241);
        const legacy = await get('range=30d');
        expect(((await legacy.json()) as { outages: unknown[] }).outages).toEqual([]);
        for (const invalid of [day + 1, today + 86400, today - 100 * 86400])
          expect((await get('day_start_at=' + invalid)).status).toBe(400);
      } finally {
        f.sqlite.close();
      }
    },
  );
});
