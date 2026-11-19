import { z } from 'zod';
import {
  mergeIntervals,
  overlapSeconds,
  sumIntervals,
  utcDayStart,
  type Interval,
} from '../analytics/uptime';

type Status = 'up' | 'down' | 'maintenance' | 'unknown';
type Check = [number, Status, number | null];
type Gap = [number, number, 0 | 1];
export type CheckSummary = {
  version: 1;
  day: number;
  interval: number;
  created: number;
  // Canonical state covered by recovery, even when retention removed every sample.
  state_checked_at?: number | null;
  first: number | null;
  before: [number, Status] | null;
  last: [number, Status] | null;
  gaps: Gap[];
  heartbeats: Check[];
};
type Monitor = {
  id: number;
  interval_sec: number;
  created_at: number;
  last_checked_at: number | null;
  check_summary_json?: string | null;
};
const statuses = new Set(['up', 'down', 'maintenance', 'unknown']);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const pair = (v: unknown) =>
  v === null || (Array.isArray(v) && v.length === 2 && integer(v[0]) && statuses.has(v[1]));
const summarySchema = z.custom<CheckSummary>((v: unknown) => {
  if (!v || typeof v !== 'object') return false;
  const s = v as CheckSummary;
  return (
    s.version === 1 &&
    integer(s.day) &&
    s.day % 86400 === 0 &&
    integer(s.interval) &&
    s.interval >= 60 &&
    integer(s.created) &&
    (s.state_checked_at === undefined ||
      s.state_checked_at === null ||
      integer(s.state_checked_at)) &&
    (s.first === null || integer(s.first)) &&
    pair(s.before) &&
    pair(s.last) &&
    Array.isArray(s.gaps) &&
    s.gaps.length <= 1500 &&
    s.gaps.every(
      (g) =>
        Array.isArray(g) &&
        g.length === 3 &&
        integer(g[0]) &&
        integer(g[1]) &&
        g[1] >= g[0] &&
        (g[2] === 0 || g[2] === 1),
    ) &&
    Array.isArray(s.heartbeats) &&
    s.heartbeats.length <= 60 &&
    s.heartbeats.every(
      (c) =>
        Array.isArray(c) &&
        c.length === 3 &&
        integer(c[0]) &&
        statuses.has(c[1]) &&
        (c[2] === null || integer(c[2])),
    )
  );
});
const validatedSummaryCache = new Map<number, { raw: string; data: CheckSummary }>();
function rememberSummary(id: number, raw: string, data: CheckSummary): void {
  if (!validatedSummaryCache.has(id) && validatedSummaryCache.size >= 256)
    validatedSummaryCache.delete(validatedSummaryCache.keys().next().value!);
  validatedSummaryCache.set(id, { raw, data });
}
export function serializeCheckSummary(id: number, summary: CheckSummary): string {
  const data = summarySchema.parse(summary);
  const raw = JSON.stringify(data);
  rememberSummary(id, raw, data);
  return raw;
}

export function parseCheckSummary(monitor: Monitor, now: number): CheckSummary | null {
  try {
    const raw = monitor.check_summary_json;
    if (typeof raw !== 'string') return null;
    const cached = validatedSummaryCache.get(monitor.id);
    let s: CheckSummary;
    if (cached?.raw === raw) s = cached.data;
    else {
      const parsed = summarySchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      s = parsed.data;
      rememberSummary(monitor.id, raw, s);
    }
    if (
      s.interval !== monitor.interval_sec ||
      s.created !== monitor.created_at ||
      (s.state_checked_at !== undefined ? s.state_checked_at : (s.last?.[0] ?? null)) !==
        monitor.last_checked_at ||
      s.day > utcDayStart(now)
    )
      return null;
    return rollDay(s, now);
  } catch {
    return null;
  }
}
function rollDay(summary: CheckSummary, now: number): CheckSummary {
  const day = utcDayStart(now);
  return summary.day === day
    ? summary
    : { ...summary, day, first: null, before: summary.last, gaps: [] };
}
export function appendCheck(
  summary: CheckSummary,
  at: number,
  status: Status,
  latency: number | null,
): CheckSummary {
  const s = rollDay(summary, at);
  if (s.last && at < s.last[0]) return s;
  const gaps = [...s.gaps];
  if (s.last && (s.last[1] === 'unknown' || at - s.last[0] > 120)) {
    const gap: Gap = [s.last[0], at, s.last[1] === 'unknown' ? 1 : 0];
    const prev = gaps.at(-1);
    if (gap[2] === 1 && prev?.[2] === 1 && prev[1] === gap[0])
      gaps[gaps.length - 1] = [prev[0], at, 1];
    else gaps.push(gap);
  }
  return {
    ...s,
    state_checked_at: at,
    first: s.first ?? at,
    last: [at, status],
    gaps,
    heartbeats: [[at, status, latency], ...s.heartbeats].slice(0, 60) as Check[],
  };
}

// Cold/recovery only: SQLite returns compact gap segments, not thousands of
// raw rows for the Worker to parse. Normal probes only append in memory.
export async function loadCheckSummary(
  db: D1Database,
  monitor: Monitor,
  now: number,
): Promise<CheckSummary> {
  const cached = parseCheckSummary(monitor, now);
  if (cached) return cached;
  const day = utcDayStart(now);
  const row = await db
    .prepare(
      `
    WITH checks AS MATERIALIZED (
      SELECT checked_at,status,
        lag(checked_at) OVER (ORDER BY checked_at,id) AS prev_at,
        lag(status) OVER (ORDER BY checked_at,id) AS prev_status
      FROM check_results WHERE monitor_id=?1 AND storage_shard=CAST((?1-1)/4 AS INTEGER)
        AND bucket_start_at>=?2-?3*2-3599 AND checked_at>=?2-?3*2 AND checked_at<=?4
    )
    SELECT min(CASE WHEN checked_at>=?2 THEN checked_at END) AS first_at,
      (SELECT checked_at FROM checks WHERE checked_at<?2 ORDER BY checked_at DESC LIMIT 1) AS before_at,
      (SELECT status FROM checks WHERE checked_at<?2 ORDER BY checked_at DESC LIMIT 1) AS before_status,
      json_group_array(json_array(prev_at,checked_at,CASE WHEN prev_status='unknown' THEN 1 ELSE 0 END))
        FILTER (WHERE checked_at>=?2 AND prev_at IS NOT NULL AND (prev_status='unknown' OR checked_at-prev_at>120)) AS gaps_json
    FROM checks
  `,
    )
    .bind(monitor.id, day, monitor.interval_sec, now)
    .first<{
      first_at: number | null;
      before_at: number | null;
      before_status: Status | null;
      gaps_json: string;
    }>();
  const readTail = async (since: number | null) =>
    (
      await db
        .prepare(
          `
    SELECT checked_at,status,latency_ms FROM check_results
    WHERE monitor_id=?1 AND storage_shard=CAST((?1-1)/4 AS INTEGER)
      ${since === null ? '' : 'AND bucket_start_at>=?2-3599 AND checked_at>=?2'}
    ORDER BY checked_at DESC,id DESC LIMIT 60
  `,
        )
        .bind(monitor.id, ...(since === null ? [] : [since]))
        .all<{ checked_at: number; status: Status; latency_ms: number | null }>()
    ).results ?? [];
  let tail = await readTail(
    Math.max(0, (monitor.last_checked_at ?? now) - monitor.interval_sec * 120),
  );
  if (tail.length < 60) tail = await readTail(null);
  const summary = {
    version: 1,
    day,
    interval: monitor.interval_sec,
    created: monitor.created_at,
    state_checked_at: monitor.last_checked_at,
    first: row?.first_at ?? null,
    before: row?.before_at == null ? null : [row.before_at, row.before_status],
    last: tail[0] ? [tail[0].checked_at, tail[0].status] : null,
    gaps: JSON.parse(row?.gaps_json ?? '[]') as unknown,
    heartbeats: tail.map((c) => [c.checked_at, c.status, c.latency_ms]),
  };
  return summarySchema.parse(summary);
}

// Repair only derived JSON. A concurrent probe/config edit wins; never overwrite
// its summary or change canonical monitor state while warming the read path.
export async function recoverCheckSummary(
  db: D1Database,
  monitor: Monitor,
  now: number,
): Promise<CheckSummary> {
  const summary = await loadCheckSummary(db, monitor, now);
  const raw = serializeCheckSummary(monitor.id, summary);
  await db
    .prepare(
      `UPDATE monitor_state SET check_summary_json=?1
      WHERE monitor_id=?2 AND last_checked_at IS ?3 AND check_summary_json IS ?4
        AND EXISTS(SELECT 1 FROM monitors WHERE id=?2 AND interval_sec=?5 AND created_at=?6)`,
    )
    .bind(
      raw,
      monitor.id,
      monitor.last_checked_at,
      monitor.check_summary_json ?? null,
      monitor.interval_sec,
      monitor.created_at,
    )
    .run();
  return summary;
}

type SummaryOutage = { monitor_id: number; started_at: number; ended_at: number | null };
const outageTuplesSchema = z.array(
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative().nullable()]),
);

export function decodeSummaryOutages(
  monitors: readonly { id: number; day_outages_json?: string | null }[],
): SummaryOutage[] | undefined {
  try {
    return monitors.flatMap((monitor) =>
      outageTuplesSchema
        .parse(JSON.parse(monitor.day_outages_json ?? 'null'))
        .map(([started_at, ended_at]) => ({ monitor_id: monitor.id, started_at, ended_at })),
    );
  } catch {
    return undefined;
  }
}

export async function summaryUptime(
  db: D1Database,
  monitors: Monitor[],
  summaries: Map<number, CheckSummary>,
  rangeStart: number,
  now: number,
  preloadedOutages?: SummaryOutage[],
) {
  const ids = monitors.map((m) => m.id);
  const rows =
    preloadedOutages ??
    (ids.length
      ? ((
          await db
            .prepare(
              `SELECT monitor_id,started_at,ended_at FROM outages
    WHERE monitor_id IN (SELECT value FROM json_each(?1)) AND ended_at IS NULL AND started_at<?2
    UNION ALL
    SELECT monitor_id,started_at,ended_at FROM outages
    WHERE monitor_id IN (SELECT value FROM json_each(?1)) AND ended_at>?3 AND started_at<?2
    ORDER BY monitor_id,started_at
  `,
            )
            .bind(JSON.stringify(ids), now, rangeStart)
            .all<{ monitor_id: number; started_at: number; ended_at: number | null }>()
        ).results ?? [])
      : []);
  const result = new Map<
    number,
    {
      total_sec: number;
      downtime_sec: number;
      unknown_sec: number;
      uptime_sec: number;
      uptime_pct: number | null;
    }
  >();
  for (const m of monitors) {
    const s = summaries.get(m.id)!;
    const start =
      m.created_at >= rangeStart
        ? s.first !== null && s.first < now
          ? s.first
          : m.last_checked_at === null
            ? now
            : m.created_at
        : rangeStart;
    const total_sec = Math.max(0, now - start);
    const down = mergeIntervals(
      rows
        .filter((r) => r.monitor_id === m.id)
        .map((r) => ({
          start: Math.max(start, r.started_at),
          end: Math.min(now, r.ended_at ?? now),
        }))
        .filter((g) => g.end > g.start),
    );
    const unknown: Interval[] = [];
    const add = (a: number, b: number) => {
      const g = { start: Math.max(start, a), end: Math.min(now, b) };
      if (g.end > g.start) unknown.push(g);
    };
    if (s.first !== null && !s.before) add(start, s.first);
    for (const [a, b, x] of s.gaps) add(x ? a : a + m.interval_sec * 2, b);
    const last = s.last;
    if (!last) add(start, now);
    else add(last[1] === 'unknown' ? last[0] : last[0] + m.interval_sec * 2, now);
    const merged = mergeIntervals(unknown);
    const downtime_sec = sumIntervals(down),
      unknown_sec = Math.max(0, sumIntervals(merged) - overlapSeconds(merged, down));
    const uptime_sec = Math.max(0, total_sec - Math.min(total_sec, downtime_sec + unknown_sec));
    result.set(m.id, {
      total_sec,
      downtime_sec,
      unknown_sec,
      uptime_sec,
      uptime_pct: total_sec ? (uptime_sec / total_sec) * 100 : null,
    });
  }
  return result;
}
