import { z } from 'zod';
import { AppError } from '../middleware/errors';

type Sample = [
  number,
  number,
  string,
  number | null,
  number | null,
  string | null,
  string | null,
  number,
];
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const samplesSchema = z.custom<Array<Sample | null>>(
  (value: unknown) =>
    Array.isArray(value) &&
    value.every(
      (s) =>
        s === null ||
        (Array.isArray(s) &&
          s.length === 8 &&
          integer(s[0]) &&
          s[0] > 0 &&
          integer(s[1]) &&
          typeof s[2] === 'string' &&
          (s[3] === null || integer(s[3])) &&
          (s[4] === null || integer(s[4])) &&
          nullableString(s[5]) &&
          nullableString(s[6]) &&
          integer(s[7]) &&
          s[7] > 0),
    ),
);
const pointSchema = z.object({
  checked_at: z.number().int().nonnegative(),
  status: z.string(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type LatencyPoint = z.infer<typeof pointSchema>;

// Expand lossless buckets in the coordinator, not in SQLite's virtual table.
// The D1 read meter then counts indexed hour rows rather than repeatedly
// scanning every JSON element and each aggregate's temporary table.
export async function readLatencyPoints(
  db: D1Database,
  monitorId: number,
  start: number,
  end: number,
): Promise<LatencyPoint[]> {
  const [buckets, legacy] = await db.batch([
    db
      .prepare(
        `
      SELECT samples_json FROM check_result_buckets
      WHERE shard_id=CAST((?1-1)/4 AS INTEGER) AND bucket_start_at>=?2 AND bucket_start_at<=?3
      UNION ALL
      SELECT pending_samples_json AS samples_json FROM monitor_state
      WHERE monitor_id=?1 AND pending_hour>=?2 AND pending_hour<=?3
    `,
      )
      .bind(monitorId, Math.floor(start / 3600) * 3600, end),
    db
      .prepare(
        `SELECT checked_at,status,latency_ms FROM check_results_legacy
      WHERE monitor_id=?1 AND checked_at>=?2 AND checked_at<=?3 ORDER BY checked_at,id`,
      )
      .bind(monitorId, start, end),
  ]);
  const points: LatencyPoint[] = [];
  for (const row of legacy?.results ?? []) points.push(pointSchema.parse(row));
  for (const row of buckets?.results ?? []) {
    const text = z.object({ samples_json: z.string() }).parse(row).samples_json;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError(500, 'INTERNAL', 'Invalid stored check samples');
    }
    const parsed = samplesSchema.safeParse(value);
    if (!parsed.success) throw new AppError(500, 'INTERNAL', 'Invalid stored check samples');
    for (const sample of parsed.data) {
      if (sample && sample[0] === monitorId && sample[1] >= start && sample[1] <= end)
        points.push({ checked_at: sample[1], status: sample[2], latency_ms: sample[3] });
    }
  }
  points.sort((a, b) => a.checked_at - b.checked_at);
  return points;
}
export function latencyStatistics(points: LatencyPoint[]): {
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
} {
  const up = points
    .filter((p) => p.status === 'up' && p.latency_ms !== null)
    .map((p) => p.latency_ms!);
  if (!up.length) return { avg_latency_ms: null, p95_latency_ms: null };
  up.sort((a, b) => a - b);
  return {
    avg_latency_ms: Math.round(up.reduce((sum, n) => sum + n, 0) / up.length),
    p95_latency_ms: up[Math.ceil(up.length * 0.95) - 1]!,
  };
}
