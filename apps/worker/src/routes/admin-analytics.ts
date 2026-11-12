import { Hono } from 'hono';
import { z } from 'zod';

import {
  LATENCY_BUCKETS_MS,
  buildLatencyHistogram,
  mergeLatencyHistograms,
  percentileFromHistogram,
  percentileFromValues,
  avg,
} from '../analytics/latency';
import {
  buildUnknownIntervals,
  mergeIntervals,
  utcDayStart,
  overlapSeconds,
  rangeToSeconds,
  sumIntervals,
  type Interval,
  type UptimeRange,
} from '../analytics/uptime';
import type { Env } from '../env';
import { AppError } from '../middleware/errors';

export const adminAnalyticsRoutes = new Hono<{ Bindings: Env }>();

const overviewRangeSchema = z.enum(['24h', '7d']);
const monitorRangeSchema = z.enum(['24h', '7d', '30d', '90d']);

const HISTOGRAM_SIZE = LATENCY_BUCKETS_MS.length + 1;
const histogramSchema = z.array(z.number().int().nonnegative()).length(HISTOGRAM_SIZE);

type MonitorRow = {
  id: number;
  name: string;
  type: string;
  interval_sec: number;
  created_at: number;
};
type OutageRow = {
  id: number;
  started_at: number;
  ended_at: number | null;
  initial_error: string | null;
  last_error: string | null;
};
type CheckRow = { checked_at: number; status: string; latency_ms: number | null };

type DailyRollupRow = {
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  checks_total: number;
  checks_up: number;
  checks_down: number;
  checks_unknown: number;
  checks_maintenance: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  latency_histogram_json: string | null;
};

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function computeRange(range: UptimeRange): { start: number; end: number } {
  const now = Math.floor(Date.now() / 1000);
  const end = Math.floor(now / 60) * 60;

  if (range === '24h') {
    return { start: end - rangeToSeconds(range), end };
  }

  // For day-based ranges (7d/30d/90d), align to UTC day boundaries and include today's partial day.
  const days = Math.max(1, Math.round(rangeToSeconds(range) / 86400));
  const todayStartAt = utcDayStart(end);
  const start = todayStartAt - (days - 1) * 86400;
  return { start, end };
}

function parseHistogram(value: string | null): number[] | null {
  if (value === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (err) {
    throw new AppError(
      500,
      'INTERNAL',
      `Invalid latency_histogram_json: ${(err as Error).message}`,
    );
  }

  const r = histogramSchema.safeParse(parsed);
  if (!r.success) {
    throw new AppError(500, 'INTERNAL', `Invalid latency_histogram_json: ${r.error.message}`);
  }

  return r.data;
}

function clampOutageIntervals(
  rows: Array<{ started_at: number; ended_at: number | null }>,
  start: number,
  end: number,
): Interval[] {
  return mergeIntervals(
    rows
      .map((r) => {
        const s = Math.max(r.started_at, start);
        const e = Math.min(r.ended_at ?? end, end);
        return { start: s, end: e };
      })
      .filter((it) => it.end > it.start),
  );
}

adminAnalyticsRoutes.get('/overview', async (c) => {
  const range = overviewRangeSchema
    .optional()
    .default('24h')
    .parse(c.req.query('range')) as UptimeRange;
  const { start: rangeStartBase, end: rangeEnd } = computeRange(range);

  const { results: monitorRows } = await c.env.DB.prepare(
    `
      SELECT id, created_at
      FROM monitors
      WHERE is_active = 1
      ORDER BY id
    `,
  ).all<{ id: number; created_at: number }>();

  const monitors = monitorRows ?? [];
  const rangeStartByMonitor = monitors.map((m) => Math.max(rangeStartBase, m.created_at));

  let total_sec = 0;
  for (const s of rangeStartByMonitor) {
    total_sec += Math.max(0, rangeEnd - s);
  }

  const { results: outageRows } = await c.env.DB.prepare(
    `
      SELECT o.monitor_id, o.started_at, o.ended_at
      FROM outages o
      JOIN monitors m ON m.id = o.monitor_id
      WHERE m.is_active = 1
        AND o.started_at < ?1 AND (o.ended_at IS NULL OR o.ended_at > ?2)
      ORDER BY o.monitor_id, o.started_at
    `,
  )
    .bind(rangeEnd, rangeStartBase)
    .all<{ monitor_id: number; started_at: number; ended_at: number | null }>();

  const byMonitor = new Map<number, Interval[]>();
  for (const r of outageRows ?? []) {
    const start = Math.max(r.started_at, rangeStartBase);
    const end = Math.min(r.ended_at ?? rangeEnd, rangeEnd);
    if (end <= start) continue;
    const list = byMonitor.get(r.monitor_id) ?? [];
    list.push({ start, end });
    byMonitor.set(r.monitor_id, list);
  }

  let downtime_sec = 0;
  let longest_outage_sec: number | null = null;
  for (const intervals of byMonitor.values()) {
    const merged = mergeIntervals(intervals);
    for (const it of merged) {
      const dur = Math.max(0, it.end - it.start);
      downtime_sec += dur;
      if (longest_outage_sec === null || dur > longest_outage_sec) {
        longest_outage_sec = dur;
      }
    }
  }
  const uptime_sec = Math.max(0, total_sec - downtime_sec);
  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  const { results: alertCountRows } = await c.env.DB.prepare(
    `
      SELECT COUNT(1) AS count
      FROM outages o
      JOIN monitors m ON m.id = o.monitor_id
      WHERE m.is_active = 1
        AND o.started_at >= ?1 AND o.started_at < ?2
    `,
  )
    .bind(rangeStartBase, rangeEnd)
    .all<{ count: number }>();
  const alert_count = alertCountRows?.[0]?.count ?? 0;

  const { results: mttrRows } = await c.env.DB.prepare(
    `
      SELECT o.started_at, o.ended_at
      FROM outages o
      JOIN monitors m ON m.id = o.monitor_id
      WHERE m.is_active = 1
        AND o.ended_at IS NOT NULL
        AND o.ended_at >= ?1 AND o.ended_at < ?2
    `,
  )
    .bind(rangeStartBase, rangeEnd)
    .all<{ started_at: number; ended_at: number }>();

  const durations = (mttrRows ?? [])
    .map((r) => Math.max(0, r.ended_at - r.started_at))
    .filter((d) => d > 0);
  const mttr_sec =
    durations.length === 0
      ? null
      : Math.round(durations.reduce((acc, v) => acc + v, 0) / durations.length);

  return c.json({
    range,
    range_start_at: rangeStartBase,
    range_end_at: rangeEnd,
    monitors: { total: monitors.length },
    totals: { total_sec, downtime_sec, uptime_sec, uptime_pct },
    alerts: { count: alert_count },
    outages: { longest_sec: longest_outage_sec, mttr_sec },
  });
});

async function computePartialDayRow(
  db: D1Database,
  monitor: { id: number; interval_sec: number },
  start: number,
  end: number,
): Promise<{
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  checks_total: number;
  checks_up: number;
  checks_down: number;
  checks_unknown: number;
  checks_maintenance: number;
  latency_histogram_json: string | null;
}> {
  const total_sec = Math.max(0, end - start);
  if (total_sec === 0) {
    return {
      day_start_at: utcDayStart(end),
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
      uptime_pct: 0,
      avg_latency_ms: null,
      p50_latency_ms: null,
      p95_latency_ms: null,
      checks_total: 0,
      checks_up: 0,
      checks_down: 0,
      checks_unknown: 0,
      checks_maintenance: 0,
      latency_histogram_json: null,
    };
  }

  const { results: outageRows } = await db
    .prepare(
      `
        SELECT started_at, ended_at
        FROM outages
        WHERE monitor_id = ?1
          AND started_at < ?2
          AND (ended_at IS NULL OR ended_at > ?3)
        ORDER BY started_at
      `,
    )
    .bind(monitor.id, end, start)
    .all<{ started_at: number; ended_at: number | null }>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((r) => ({ start: Math.max(r.started_at, start), end: Math.min(r.ended_at ?? end, end) }))
      .filter((it) => it.end > it.start),
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksStart = start - monitor.interval_sec * 2;
  const { results: checkRows } = await db
    .prepare(
      `
        SELECT checked_at, status, latency_ms
        FROM check_results
        WHERE monitor_id = ?1
          AND storage_shard = CAST((?1 - 1) / 4 AS INTEGER)
          AND bucket_start_at >= (?2) - 3599
          AND checked_at >= ?2
          AND checked_at < ?3
        ORDER BY checked_at
      `,
    )
    .bind(monitor.id, checksStart, end)
    .all<CheckRow>();

  const normalizedChecks = (checkRows ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
  }));
  const unknownIntervals = buildUnknownIntervals(
    start,
    end,
    monitor.interval_sec,
    normalizedChecks,
  );
  const unknown_sec = Math.max(
    0,
    sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
  );

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);
  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  let checks_up = 0;
  let checks_down = 0;
  let checks_unknown = 0;
  let checks_maintenance = 0;
  const latencies: number[] = [];

  for (const r of checkRows ?? []) {
    if (r.checked_at < start) continue;
    const st = toCheckStatus(r.status);
    if (st === 'up') {
      checks_up++;
      if (typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms))
        latencies.push(r.latency_ms);
    } else if (st === 'down') {
      checks_down++;
    } else if (st === 'maintenance') {
      checks_maintenance++;
    } else {
      checks_unknown++;
    }
  }

  const checks_total = checks_up + checks_down + checks_unknown + checks_maintenance;

  const avg_latency_ms = avg(latencies);
  const p50_latency_ms = percentileFromValues(latencies, 0.5);
  const p95_latency_ms = percentileFromValues(latencies, 0.95);
  const latency_histogram_json = JSON.stringify(buildLatencyHistogram(latencies));

  return {
    day_start_at: utcDayStart(end),
    total_sec,
    downtime_sec,
    unknown_sec,
    uptime_sec,
    uptime_pct,
    avg_latency_ms,
    p50_latency_ms,
    p95_latency_ms,
    checks_total,
    checks_up,
    checks_down,
    checks_unknown,
    checks_maintenance,
    latency_histogram_json,
  };
}

adminAnalyticsRoutes.get('/monitors/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = monitorRangeSchema
    .optional()
    .default('24h')
    .parse(c.req.query('range')) as UptimeRange;

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name, type, interval_sec, created_at
      FROM monitors
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<MonitorRow>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const { start: rangeStartBase, end: rangeEnd } = computeRange(range);
  const rangeStart = Math.max(rangeStartBase, monitor.created_at);

  if (rangeEnd <= rangeStart) {
    return c.json({
      monitor: { id: monitor.id, name: monitor.name, type: monitor.type },
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
      uptime_pct: 0,
      unknown_pct: 0,
      avg_latency_ms: null,
      p50_latency_ms: null,
      p95_latency_ms: null,
      checks: { total: 0, up: 0, down: 0, unknown: 0, maintenance: 0 },
      points: [],
      daily: [],
    });
  }

  if (range === '24h') {
    const total_sec = Math.max(0, rangeEnd - rangeStart);

    const { results: outageRows } = await c.env.DB.prepare(
      `
        SELECT started_at, ended_at
        FROM outages
        WHERE monitor_id = ?1
          AND started_at < ?2
          AND (ended_at IS NULL OR ended_at > ?3)
        ORDER BY started_at
      `,
    )
      .bind(id, rangeEnd, rangeStart)
      .all<{ started_at: number; ended_at: number | null }>();

    const downtimeIntervals = clampOutageIntervals(outageRows ?? [], rangeStart, rangeEnd);
    const downtime_sec = sumIntervals(downtimeIntervals);

    const checksStart = rangeStart - monitor.interval_sec * 2;
    const { results: checkRows } = await c.env.DB.prepare(
      `
        SELECT checked_at, status, latency_ms
        FROM check_results
        WHERE monitor_id = ?1
          AND storage_shard = CAST((?1 - 1) / 4 AS INTEGER)
          AND bucket_start_at >= (?2) - 3599
          AND checked_at >= ?2
          AND checked_at < ?3
        ORDER BY checked_at
      `,
    )
      .bind(id, checksStart, rangeEnd)
      .all<CheckRow>();

    const normalizedChecks = (checkRows ?? []).map((r) => ({
      checked_at: r.checked_at,
      status: toCheckStatus(r.status),
    }));
    const unknownIntervals = buildUnknownIntervals(
      rangeStart,
      rangeEnd,
      monitor.interval_sec,
      normalizedChecks,
    );
    const unknown_sec = Math.max(
      0,
      sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
    );

    const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
    const uptime_sec = Math.max(0, total_sec - unavailable_sec);
    const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;
    const unknown_pct = total_sec === 0 ? 0 : (unknown_sec / total_sec) * 100;

    let checks_up = 0;
    let checks_down = 0;
    let checks_unknown = 0;
    let checks_maintenance = 0;
    const latencies: number[] = [];
    const points: Array<{ checked_at: number; status: string; latency_ms: number | null }> = [];

    for (const r of checkRows ?? []) {
      if (r.checked_at < rangeStart) continue;
      const st = toCheckStatus(r.status);
      points.push({ checked_at: r.checked_at, status: st, latency_ms: r.latency_ms });

      if (st === 'up') {
        checks_up++;
        if (typeof r.latency_ms === 'number') latencies.push(r.latency_ms);
      } else if (st === 'down') {
        checks_down++;
      } else if (st === 'maintenance') {
        checks_maintenance++;
      } else {
        checks_unknown++;
      }
    }

    const checks_total = checks_up + checks_down + checks_unknown + checks_maintenance;

    return c.json({
      monitor: { id: monitor.id, name: monitor.name, type: monitor.type },
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec,
      downtime_sec,
      unknown_sec,
      uptime_sec,
      uptime_pct,
      unknown_pct,
      avg_latency_ms: avg(latencies),
      p50_latency_ms: percentileFromValues(latencies, 0.5),
      p95_latency_ms: percentileFromValues(latencies, 0.95),
      checks: {
        total: checks_total,
        up: checks_up,
        down: checks_down,
        unknown: checks_unknown,
        maintenance: checks_maintenance,
      },
      points,
      daily: [],
    });
  }

  // day-based rollup ranges: 7d/30d/90d.
  // We keep rollups for full UTC days, and add a synthetic point for the current (partial) day.
  const daysEnd = utcDayStart(rangeEnd);
  const daysStart = rangeStartBase;
  const dayCount = Math.max(0, Math.round((daysEnd - daysStart) / 86400));

  const { results: rollupRows } = await c.env.DB.prepare(
    `
      SELECT
        day_start_at,
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
        checks_total,
        checks_up,
        checks_down,
        checks_unknown,
        checks_maintenance,
        avg_latency_ms,
        p50_latency_ms,
        p95_latency_ms,
        latency_histogram_json
      FROM monitor_daily_rollups
      WHERE monitor_id = ?1
        AND day_start_at >= ?2
        AND day_start_at < ?3
      ORDER BY day_start_at
    `,
  )
    .bind(id, daysStart, daysEnd)
    .all<DailyRollupRow>();

  const byDay = new Map<number, DailyRollupRow>();
  for (const r of rollupRows ?? []) {
    byDay.set(r.day_start_at, r);
  }

  let total_sec = 0;
  let downtime_sec = 0;
  let unknown_sec = 0;
  let uptime_sec = 0;

  let checks_total = 0;
  let checks_up = 0;
  let checks_down = 0;
  let checks_unknown = 0;
  let checks_maintenance = 0;

  let latencyWeightedSum = 0;
  let latencySamples = 0;
  const histograms: number[][] = [];

  const daily: Array<{
    day_start_at: number;
    total_sec: number;
    downtime_sec: number;
    unknown_sec: number;
    uptime_sec: number;
    uptime_pct: number;
    avg_latency_ms: number | null;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    checks_total: number;
    checks_up: number;
    checks_down: number;
    checks_unknown: number;
    checks_maintenance: number;
  }> = [];

  for (let i = 0; i < dayCount; i++) {
    const dayStartAt = daysStart + i * 86400;
    const dayEndAt = dayStartAt + 86400;
    const dayRangeStart = Math.max(dayStartAt, monitor.created_at);
    if (dayRangeStart >= dayEndAt) continue;

    const expectedTotal = dayEndAt - dayRangeStart;
    const row = byDay.get(dayStartAt);

    if (row) {
      total_sec += row.total_sec;
      downtime_sec += row.downtime_sec;
      unknown_sec += row.unknown_sec;
      uptime_sec += row.uptime_sec;

      checks_total += row.checks_total;
      checks_up += row.checks_up;
      checks_down += row.checks_down;
      checks_unknown += row.checks_unknown;
      checks_maintenance += row.checks_maintenance;

      if (typeof row.avg_latency_ms === 'number' && row.checks_up > 0) {
        latencyWeightedSum += row.avg_latency_ms * row.checks_up;
        latencySamples += row.checks_up;
      }

      const h = parseHistogram(row.latency_histogram_json);
      if (h) histograms.push(h);

      daily.push({
        day_start_at: row.day_start_at,
        total_sec: row.total_sec,
        downtime_sec: row.downtime_sec,
        unknown_sec: row.unknown_sec,
        uptime_sec: row.uptime_sec,
        uptime_pct: row.total_sec === 0 ? 0 : (row.uptime_sec / row.total_sec) * 100,
        avg_latency_ms: row.avg_latency_ms,
        p50_latency_ms: row.p50_latency_ms,
        p95_latency_ms: row.p95_latency_ms,
        checks_total: row.checks_total,
        checks_up: row.checks_up,
        checks_down: row.checks_down,
        checks_unknown: row.checks_unknown,
        checks_maintenance: row.checks_maintenance,
      });
      continue;
    }

    // Missing rollup row: treat the whole day slice as unknown (conservative) and keep charts continuous.
    total_sec += expectedTotal;
    unknown_sec += expectedTotal;

    daily.push({
      day_start_at: dayStartAt,
      total_sec: expectedTotal,
      downtime_sec: 0,
      unknown_sec: expectedTotal,
      uptime_sec: 0,
      uptime_pct: 0,
      avg_latency_ms: null,
      p50_latency_ms: null,
      p95_latency_ms: null,
      checks_total: 0,
      checks_up: 0,
      checks_down: 0,
      checks_unknown: 0,
      checks_maintenance: 0,
    });
  }

  // Add the current (partial) UTC day point so ongoing outages show up for 7d/30d/90d.
  if (rangeEnd > daysEnd && rangeEnd > rangeStart) {
    const start = Math.max(daysEnd, rangeStart);
    const partial = await computePartialDayRow(
      c.env.DB,
      { id: monitor.id, interval_sec: monitor.interval_sec },
      start,
      rangeEnd,
    );

    total_sec += partial.total_sec;
    downtime_sec += partial.downtime_sec;
    unknown_sec += partial.unknown_sec;
    uptime_sec += partial.uptime_sec;

    checks_total += partial.checks_total;
    checks_up += partial.checks_up;
    checks_down += partial.checks_down;
    checks_unknown += partial.checks_unknown;
    checks_maintenance += partial.checks_maintenance;

    if (typeof partial.avg_latency_ms === 'number' && partial.checks_up > 0) {
      latencyWeightedSum += partial.avg_latency_ms * partial.checks_up;
      latencySamples += partial.checks_up;
    }

    const h = parseHistogram(partial.latency_histogram_json);
    if (h) histograms.push(h);

    daily.push({
      day_start_at: partial.day_start_at,
      total_sec: partial.total_sec,
      downtime_sec: partial.downtime_sec,
      unknown_sec: partial.unknown_sec,
      uptime_sec: partial.uptime_sec,
      uptime_pct: partial.uptime_pct,
      avg_latency_ms: partial.avg_latency_ms,
      p50_latency_ms: partial.p50_latency_ms,
      p95_latency_ms: partial.p95_latency_ms,
      checks_total: partial.checks_total,
      checks_up: partial.checks_up,
      checks_down: partial.checks_down,
      checks_unknown: partial.checks_unknown,
      checks_maintenance: partial.checks_maintenance,
    });
  }

  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;
  const unknown_pct = total_sec === 0 ? 0 : (unknown_sec / total_sec) * 100;

  const mergedHist = mergeLatencyHistograms(histograms);

  const avg_latency_ms =
    latencySamples === 0 ? null : Math.round(latencyWeightedSum / latencySamples);
  const p50_latency_ms = percentileFromHistogram(mergedHist, 0.5);
  const p95_latency_ms = percentileFromHistogram(mergedHist, 0.95);

  return c.json({
    monitor: { id: monitor.id, name: monitor.name, type: monitor.type },
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    total_sec,
    downtime_sec,
    unknown_sec,
    uptime_sec,
    uptime_pct,
    unknown_pct,
    avg_latency_ms,
    p50_latency_ms,
    p95_latency_ms,
    checks: {
      total: checks_total,
      up: checks_up,
      down: checks_down,
      unknown: checks_unknown,
      maintenance: checks_maintenance,
    },
    points: [],
    daily,
  });
});

adminAnalyticsRoutes.get('/monitors/:id/outages', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = monitorRangeSchema
    .optional()
    .default('7d')
    .parse(c.req.query('range')) as UptimeRange;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const monitor = await c.env.DB.prepare(`SELECT id, created_at FROM monitors WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const { start: rangeStartBase, end: rangeEnd } = computeRange(range);
  const rangeStart = Math.max(rangeStartBase, monitor.created_at);

  const sqlBase = `
      SELECT id, started_at, ended_at, initial_error, last_error
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
  `;

  const take = limit + 1;
  const { results } = cursor
    ? await c.env.DB.prepare(
        `
          ${sqlBase}
            AND id < ?4
          ORDER BY id DESC
          LIMIT ?5
        `,
      )
        .bind(id, rangeEnd, rangeStart, cursor, take)
        .all<OutageRow>()
    : await c.env.DB.prepare(
        `
          ${sqlBase}
          ORDER BY id DESC
          LIMIT ?4
        `,
      )
        .bind(id, rangeEnd, rangeStart, take)
        .all<OutageRow>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return c.json({
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    outages: page.map((r) => ({
      id: r.id,
      monitor_id: id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      initial_error: r.initial_error,
      last_error: r.last_error,
    })),
    next_cursor,
  });
});
