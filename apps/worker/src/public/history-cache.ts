import { z } from 'zod';

export const PUBLIC_HISTORY_CACHE_KEY = 'monitor-history:rollups';
type HistoryTuple = [number, number, number, number, number];
export type PublicHistoryRow = {
  monitor_id: number;
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
};
const historySchema = z.custom<HistoryTuple[]>(
  (value: unknown) =>
    Array.isArray(value) &&
    value.length <= 90 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 5 &&
        row.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0),
    ),
);

const validatedHistoryCache = new Map<number, { raw: string; day: number; rows: HistoryTuple[] }>();
type StoredHistoryRow = { fragment_key: string; generated_at: number; body_json: string };

// Completed days change only when daily-rollup writes them. Cache those rows
// once, invalidate after rollup, and read current probe/state data separately.
// The key includes the UTC day, so midnight cannot reuse yesterday's range.
export async function readPublicHistoryRows(
  db: D1Database,
  monitorIds: readonly number[],
  rangeStart: number,
  dayEnd: number,
  preloadedRows?: StoredHistoryRow[],
): Promise<PublicHistoryRow[]> {
  const ids = [...new Set(monitorIds)];
  if (!ids.length) return [];
  const read = async (selected: readonly number[], preloaded?: StoredHistoryRow[]) => {
    const results =
      preloaded ??
      (
        await db
          .prepare(
            `SELECT fragment_key,generated_at,body_json
      FROM public_snapshot_fragments WHERE snapshot_key=?1
        AND fragment_key IN (SELECT 'monitor:' || value FROM json_each(?2))
    `,
          )
          .bind(PUBLIC_HISTORY_CACHE_KEY, JSON.stringify(selected))
          .all<StoredHistoryRow>()
      ).results;
    const valid = new Map<number, HistoryTuple[]>();
    for (const row of results ?? []) {
      if (row.generated_at !== dayEnd) continue;
      const id = Number(row.fragment_key.slice('monitor:'.length));
      if (!ids.includes(id)) continue;
      try {
        const cached = validatedHistoryCache.get(id);
        if (cached?.day === dayEnd && cached.raw === row.body_json) {
          valid.set(id, cached.rows);
          continue;
        }
        const parsed = historySchema.safeParse(JSON.parse(row.body_json));
        if (parsed.success) {
          if (!validatedHistoryCache.has(id) && validatedHistoryCache.size >= 256)
            validatedHistoryCache.delete(validatedHistoryCache.keys().next().value!);
          validatedHistoryCache.set(id, { raw: row.body_json, day: dayEnd, rows: parsed.data });
          valid.set(id, parsed.data);
        }
      } catch {
        /* Invalid DB JSON is rebuilt from canonical rollups. */
      }
    }
    return valid;
  };
  const cached = await read(ids, preloadedRows);
  const missing = ids.filter((id) => !cached.has(id));
  if (missing.length) {
    await db
      .prepare(
        `
      INSERT INTO public_snapshot_fragments(snapshot_key,fragment_key,generated_at,body_json,updated_at)
      SELECT ?1,'monitor:' || m.id,?2,(
        SELECT json_group_array(json_array(day_start_at,total_sec,downtime_sec,unknown_sec,uptime_sec))
        FROM (SELECT day_start_at,total_sec,downtime_sec,unknown_sec,uptime_sec
          FROM monitor_daily_rollups WHERE monitor_id=m.id AND day_start_at>=?2-90*86400
            AND day_start_at<?2 ORDER BY day_start_at)
      ),?4
      FROM monitors m WHERE m.id IN (SELECT value FROM json_each(?3))
      ON CONFLICT(snapshot_key,fragment_key) DO UPDATE SET
        generated_at=excluded.generated_at,body_json=excluded.body_json,updated_at=excluded.updated_at
      WHERE excluded.generated_at>=public_snapshot_fragments.generated_at
         OR public_snapshot_fragments.generated_at>?4+60
    `,
      )
      .bind(
        PUBLIC_HISTORY_CACHE_KEY,
        dayEnd,
        JSON.stringify(missing),
        Math.floor(Date.now() / 1000),
      )
      .run();
    for (const [id, rows] of await read(missing)) cached.set(id, rows);
    if (missing.some((id) => !cached.has(id)))
      throw new Error('Public history cache could not be rebuilt');
  }
  return ids.flatMap((id) =>
    (cached.get(id) ?? [])
      .filter((row) => row[0] >= rangeStart && row[0] < dayEnd)
      .map((row) => ({
        monitor_id: id,
        day_start_at: row[0],
        total_sec: row[1],
        downtime_sec: row[2],
        unknown_sec: row[3],
        uptime_sec: row[4],
      })),
  );
}

export async function invalidatePublicHistoryRows(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM public_snapshot_fragments WHERE snapshot_key=?1')
    .bind(PUBLIC_HISTORY_CACHE_KEY)
    .run();
}
