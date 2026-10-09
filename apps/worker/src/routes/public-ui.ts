import { Hono } from 'hono';
import { z } from 'zod';

import type { Env } from '../env';
import { hasValidAdminTokenRequest } from '../middleware/auth';
import { AppError, handleError, handleNotFound } from '../middleware/errors';
import { cachePublic } from '../middleware/cache-public';
import {
  buildUnknownIntervals,
  mergeIntervals,
  overlapSeconds,
  rangeToSeconds,
  sumIntervals,
  utcDayStart,
} from '../analytics/uptime';
import {
  materializeMonitorRuntimeTotals,
  MONITOR_RUNTIME_MAX_AGE_SECONDS,
  MONITOR_RUNTIME_SNAPSHOT_KEY,
  parsePublicMonitorRuntimeEntryJson,
} from '../public/monitor-runtime';
import {
  buildNumberedPlaceholders,
  chunkPositiveIntegerIds,
  filterStatusPageScopedMonitorIds,
  incidentStatusPageVisibilityPredicate,
  listStatusPageVisibleMonitorIds,
  monitorVisibilityPredicate,
  shouldIncludeStatusPageScopedItem,
} from '../public/visibility';
import { registerPublicUiAnalyticsRoutes } from './public-ui-analytics';
import { Trace, applyTraceToResponse, resolveTraceOptions } from '../observability/trace';

function isAuthorizedStatusAdminRequest(c: {
  env: Pick<Env, 'ADMIN_TOKEN'>;
  req: { header(name: string): string | undefined };
}): boolean {
  return hasValidAdminTokenRequest(c);
}

function appendAuthorizationVary(res: Response): Response {
  const vary = res.headers.get('Vary');
  if (!vary) {
    res.headers.set('Vary', 'Authorization');
  } else if (!vary.split(',').some((part) => part.trim().toLowerCase() === 'authorization')) {
    res.headers.set('Vary', `${vary}, Authorization`);
  }

  return res;
}

function applyPrivateNoStore(res: Response): Response {
  appendAuthorizationVary(res);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function withVisibilityAwareCaching(res: Response, includeHiddenMonitors: boolean): Response {
  return includeHiddenMonitors ? applyPrivateNoStore(res) : appendAuthorizationVary(res);
}

function createTrace(c: { env: Env; req: { header(name: string): string | undefined } }): Trace {
  return new Trace(
    resolveTraceOptions({
      header: (name) => c.req.header(name),
      env: c.env as unknown as Record<string, unknown>,
    }),
  );
}

const publicUiStatementsByDb = new WeakMap<D1Database, Map<string, D1PreparedStatement>>();

function preparePublicUiStatement(db: D1Database, sql: string): D1PreparedStatement {
  let statements = publicUiStatementsByDb.get(db);
  if (!statements) {
    statements = new Map<string, D1PreparedStatement>();
    publicUiStatementsByDb.set(db, statements);
  }

  const cached = statements.get(sql);
  if (cached) {
    return cached;
  }

  const statement = db.prepare(sql);
  statements.set(sql, statement);
  return statement;
}

const latencyRangeSchema = z.enum(['24h']);
const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);
type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  status: string | null;
  message: string;
  created_at: number;
};

type IncidentMonitorLinkRow = {
  incident_id: number;
  monitor_id: number;
};

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

function toIncidentStatus(
  value: string | null,
): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  switch (value) {
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'resolved':
      return value;
    default:
      return 'investigating';
  }
}

function toIncidentImpact(value: string | null): 'none' | 'minor' | 'major' | 'critical' {
  switch (value) {
    case 'none':
    case 'minor':
    case 'major':
    case 'critical':
      return value;
    default:
      return 'minor';
  }
}

function incidentUpdateRowToApi(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status === null ? null : toIncidentStatus(row.status),
    message: row.message,
    created_at: row.created_at,
  };
}

function incidentRowToApi(
  row: IncidentRow,
  updates: IncidentUpdateRow[] = [],
  monitorIds: number[] = [],
) {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    monitor_ids: monitorIds,
    updates: updates.map(incidentUpdateRowToApi),
  };
}

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT id, incident_id, status, message, created_at
          FROM incident_updates
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, created_at, id
        `,
      )
      .bind(...ids)
      .all<IncidentUpdateRow>();

    for (const row of results ?? []) {
      const existing = byIncident.get(row.incident_id) ?? [];
      existing.push(row);
      byIncident.set(row.incident_id, existing);
    }
  }

  return byIncident;
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT incident_id, monitor_id
          FROM incident_monitors
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, monitor_id
        `,
      )
      .bind(...ids)
      .all<IncidentMonitorLinkRow>();

    for (const row of results ?? []) {
      const existing = byIncident.get(row.incident_id) ?? [];
      existing.push(row.monitor_id);
      byIncident.set(row.incident_id, existing);
    }
  }

  return byIncident;
}

function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(windowIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT maintenance_window_id, monitor_id
          FROM maintenance_window_monitors
          WHERE maintenance_window_id IN (${placeholders})
          ORDER BY maintenance_window_id, monitor_id
        `,
      )
      .bind(...ids)
      .all<MaintenanceWindowMonitorLinkRow>();

    for (const row of results ?? []) {
      const existing = byWindow.get(row.maintenance_window_id) ?? [];
      existing.push(row.monitor_id);
      byWindow.set(row.maintenance_window_id, existing);
    }
  }

  return byWindow;
}

async function listPublicMaintenanceWindowsPage(opts: {
  db: D1Database;
  now: number;
  limit: number;
  cursor: number | undefined;
  includeHiddenMonitors: boolean;
}): Promise<{
  maintenance_windows: Array<ReturnType<typeof maintenanceWindowRowToApi>>;
  next_cursor: number | null;
}> {
  const limitPlusOne = opts.limit + 1;
  const batchLimit = Math.max(50, limitPlusOne);
  let seekCursor = opts.cursor;
  const collected: Array<{ row: MaintenanceWindowRow; monitorIds: number[] }> = [];

  while (collected.length < limitPlusOne) {
    const { results: windowRows } = seekCursor
      ? await opts.db
          .prepare(
            `
              SELECT id, title, message, starts_at, ends_at, created_at
              FROM maintenance_windows
              WHERE ends_at <= ?1
                AND id < ?3
              ORDER BY id DESC
              LIMIT ?2
            `,
          )
          .bind(opts.now, batchLimit, seekCursor)
          .all<MaintenanceWindowRow>()
      : await opts.db
          .prepare(
            `
              SELECT id, title, message, starts_at, ends_at, created_at
              FROM maintenance_windows
              WHERE ends_at <= ?1
              ORDER BY id DESC
              LIMIT ?2
            `,
          )
          .bind(opts.now, batchLimit)
          .all<MaintenanceWindowRow>();

    const allWindows = windowRows ?? [];
    if (allWindows.length === 0) {
      break;
    }

    const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
      opts.db,
      allWindows.map((window) => window.id),
    );
    const linkedMonitorIds = [...monitorIdsByWindowId.values()].flat();
    const visibleMonitorIds =
      opts.includeHiddenMonitors || linkedMonitorIds.length === 0
        ? new Set<number>()
        : await listStatusPageVisibleMonitorIds(opts.db, linkedMonitorIds);

    for (const row of allWindows) {
      const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        opts.includeHiddenMonitors,
      );
      if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        continue;
      }
      collected.push({ row, monitorIds: filteredMonitorIds });
      if (collected.length >= limitPlusOne) {
        break;
      }
    }

    const lastRow = allWindows[allWindows.length - 1];
    if (allWindows.length < batchLimit || !lastRow) {
      break;
    }
    seekCursor = lastRow.id;
  }

  return {
    maintenance_windows: collected
      .slice(0, opts.limit)
      .map(({ row, monitorIds }) => maintenanceWindowRowToApi(row, monitorIds)),
    next_cursor: collected.length > opts.limit ? (collected[opts.limit - 1]?.row.id ?? null) : null,
  };
}

function jsonNumberLiteral(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'null';
}

function jsonArrayLiteral(value: string | null | undefined): string {
  if (typeof value !== 'string') return '[]';
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed : '[]';
}

function takeBatchRows<T>(result: { results?: unknown[] | undefined } | null | undefined): T[] {
  return Array.isArray(result?.results) ? (result.results as T[]) : [];
}

function takeBatchFirstRow<T>(
  result: { results?: unknown[] | undefined } | null | undefined,
): T | null {
  const rows = takeBatchRows<T>(result);
  return (rows[0] ?? null) as T | null;
}

function buildNumberMap<K extends number, T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
  valueBuilder?: (row: T) => number,
): Map<K, number[]> {
  const grouped = new Map<K, number[]>();

  for (const row of rows) {
    const groupKey = row[key];
    if (typeof groupKey !== 'number' || !Number.isInteger(groupKey)) continue;
    const existing = grouped.get(groupKey as K) ?? [];
    existing.push(valueBuilder ? valueBuilder(row) : Number(row['monitor_id']));
    grouped.set(groupKey as K, existing);
  }

  return grouped;
}

function buildRowArrayMap<K extends number, T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
): Map<K, T[]> {
  const grouped = new Map<K, T[]>();

  for (const row of rows) {
    const groupKey = row[key];
    if (typeof groupKey !== 'number' || !Number.isInteger(groupKey)) continue;
    const existing = grouped.get(groupKey as K) ?? [];
    existing.push(row);
    grouped.set(groupKey as K, existing);
  }

  return grouped;
}

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

function resolveUptimeRangeStart(
  rangeStart: number,
  rangeEnd: number,
  monitorCreatedAt: number,
  lastCheckedAt: number | null,
  checks: Array<{ checked_at: number; status: string }>,
): number | null {
  const monitorRangeStart = Math.max(rangeStart, monitorCreatedAt);
  if (rangeEnd <= monitorRangeStart) return null;

  if (monitorRangeStart > rangeStart) {
    const firstCheckAt = checks.find(
      (check) => check.checked_at >= monitorRangeStart && check.checked_at < rangeEnd,
    )?.checked_at;
    if (firstCheckAt !== undefined) {
      return firstCheckAt;
    }

    return lastCheckedAt === null ? null : monitorRangeStart;
  }

  return monitorRangeStart;
}

function resolveUptimeRangeStartFromFirstCheck(opts: {
  rangeStart: number;
  rangeEnd: number;
  monitorCreatedAt: number;
  lastCheckedAt: number | null;
  firstCheckAt: number | null;
}): number | null {
  const monitorRangeStart = Math.max(opts.rangeStart, opts.monitorCreatedAt);
  if (opts.rangeEnd <= monitorRangeStart) return null;

  if (monitorRangeStart > opts.rangeStart) {
    if (typeof opts.firstCheckAt === 'number') {
      return opts.firstCheckAt;
    }

    return opts.lastCheckedAt === null ? null : monitorRangeStart;
  }

  return monitorRangeStart;
}

function addUptimeTotals(
  target: { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number },
  source: { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number },
): void {
  target.total_sec += source.total_sec;
  target.downtime_sec += source.downtime_sec;
  target.unknown_sec += source.unknown_sec;
  target.uptime_sec += source.uptime_sec;
}

async function computePartialUptimeTotalsSql(
  db: D1Database,
  monitorId: number,
  intervalSec: number,
  createdAt: number,
  lastCheckedAt: number | null,
  rangeStart: number,
  rangeEnd: number,
): Promise<{ total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }> {
  if (rangeEnd <= rangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const row = await db
    .prepare(
      `
        WITH input(monitor_id, interval_sec, created_at, last_checked_at) AS (
          VALUES (?3, ?4, ?5, ?6)
        ),
        first_checks AS (
          SELECT monitor_id, MIN(checked_at) AS first_check_at
          FROM check_results
          WHERE monitor_id IN (SELECT monitor_id FROM input)
            AND checked_at >= ?1
            AND checked_at < ?2
          GROUP BY monitor_id
        ),
        effective AS (
          SELECT
            i.monitor_id AS monitor_id,
            i.interval_sec AS interval_sec,
            CASE
              WHEN i.created_at >= ?1 THEN
                COALESCE(
                  fc.first_check_at,
                  CASE WHEN i.last_checked_at IS NULL THEN NULL ELSE i.created_at END
                )
              ELSE ?1
            END AS start_at
          FROM input i
          LEFT JOIN first_checks fc ON fc.monitor_id = i.monitor_id
        ),
        downtime_segments AS (
          SELECT
            o.monitor_id AS monitor_id,
            max(o.started_at, e.start_at) AS seg_start,
            min(coalesce(o.ended_at, ?2), ?2) AS seg_end
          FROM outages o
          JOIN effective e ON e.monitor_id = o.monitor_id
          WHERE e.start_at IS NOT NULL
            AND o.started_at < ?2
            AND (o.ended_at IS NULL OR o.ended_at > e.start_at)
        ),
        downtime AS (
          SELECT monitor_id, sum(max(0, seg_end - seg_start)) AS downtime_sec
          FROM downtime_segments
          GROUP BY monitor_id
        ),
        checks AS (
          SELECT
            cr.monitor_id AS monitor_id,
            cr.checked_at AS checked_at,
            cr.status AS status,
            e.interval_sec AS interval_sec,
            e.start_at AS start_at,
            lag(cr.checked_at) OVER (
              PARTITION BY cr.monitor_id
              ORDER BY cr.checked_at
            ) AS prev_at,
            lag(cr.status) OVER (
              PARTITION BY cr.monitor_id
              ORDER BY cr.checked_at
            ) AS prev_status
          FROM check_results cr
          JOIN effective e ON e.monitor_id = cr.monitor_id
          WHERE e.start_at IS NOT NULL
            AND cr.checked_at >= max(0, e.start_at - e.interval_sec * 2)
            AND cr.checked_at < ?2
        ),
        unknown_checks AS (
          SELECT
            monitor_id AS monitor_id,
            CASE
              WHEN prev_at IS NULL THEN start_at
              WHEN prev_status = 'unknown' THEN (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END)
              ELSE max(
                (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END),
                prev_at + interval_sec * 2
              )
            END AS seg_start,
            checked_at AS seg_end
          FROM checks
          WHERE checked_at >= start_at
        ),
        last_any AS (
          SELECT monitor_id, checked_at, status
          FROM (
            SELECT
              monitor_id,
              checked_at,
              status,
              row_number() OVER (
                PARTITION BY monitor_id
                ORDER BY checked_at DESC
              ) AS rn
            FROM checks
          )
          WHERE rn = 1
        ),
        last_in_range AS (
          SELECT monitor_id, checked_at
          FROM (
            SELECT
              monitor_id,
              checked_at,
              row_number() OVER (
                PARTITION BY monitor_id
                ORDER BY checked_at DESC
              ) AS rn
            FROM checks
            WHERE checked_at >= start_at
          )
          WHERE rn = 1
        ),
        unknown_tail AS (
          SELECT
            e.monitor_id AS monitor_id,
            CASE
              WHEN la.checked_at IS NULL THEN coalesce(lir.checked_at, e.start_at)
              WHEN la.status = 'unknown' THEN coalesce(lir.checked_at, e.start_at)
              ELSE max(coalesce(lir.checked_at, e.start_at), la.checked_at + e.interval_sec * 2)
            END AS seg_start,
            ?2 AS seg_end
          FROM effective e
          LEFT JOIN last_any la ON la.monitor_id = e.monitor_id
          LEFT JOIN last_in_range lir ON lir.monitor_id = e.monitor_id
          WHERE e.start_at IS NOT NULL
        ),
        unknown_segments AS (
          SELECT monitor_id, seg_start, seg_end
          FROM unknown_checks
          WHERE seg_end > seg_start
          UNION ALL
          SELECT monitor_id, seg_start, seg_end
          FROM unknown_tail
          WHERE seg_end > seg_start
        ),
        unknown_raw AS (
          SELECT monitor_id, sum(seg_end - seg_start) AS unknown_raw_sec
          FROM unknown_segments
          GROUP BY monitor_id
        ),
        unknown_overlap AS (
          SELECT
            u.monitor_id AS monitor_id,
            sum(
              max(0, min(u.seg_end, d.seg_end) - max(u.seg_start, d.seg_start))
            ) AS overlap_sec
          FROM unknown_segments u
          JOIN downtime_segments d ON d.monitor_id = u.monitor_id
          WHERE u.seg_end > d.seg_start AND d.seg_end > u.seg_start
          GROUP BY u.monitor_id
        )
        SELECT
          e.start_at AS start_at,
          (?2 - e.start_at) AS total_sec,
          coalesce(d.downtime_sec, 0) AS downtime_sec,
          max(0, coalesce(u.unknown_raw_sec, 0) - coalesce(o.overlap_sec, 0)) AS unknown_sec
        FROM effective e
        LEFT JOIN downtime d ON d.monitor_id = e.monitor_id
        LEFT JOIN unknown_raw u ON u.monitor_id = e.monitor_id
        LEFT JOIN unknown_overlap o ON o.monitor_id = e.monitor_id
        WHERE e.start_at IS NOT NULL
      `,
    )
    .bind(rangeStart, rangeEnd, monitorId, intervalSec, createdAt, lastCheckedAt)
    .first<{
      start_at: number | null;
      total_sec: number | null;
      downtime_sec: number | null;
      unknown_sec: number | null;
    }>();

  if (row?.start_at === null || row?.start_at === undefined) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }
  if (
    typeof row.total_sec !== 'number' ||
    typeof row.downtime_sec !== 'number' ||
    typeof row.unknown_sec !== 'number'
  ) {
    throw new Error('uptime partial sql returned invalid row');
  }

  const total_sec = Math.max(0, row.total_sec);
  const downtime_sec = Math.max(0, row.downtime_sec);
  const unknown_sec = Math.max(0, row.unknown_sec);
  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);

  return { total_sec, downtime_sec, unknown_sec, uptime_sec };
}

async function computePartialUptimeTotalsLegacy(
  db: D1Database,
  monitorId: number,
  intervalSec: number,
  createdAt: number,
  lastCheckedAt: number | null,
  rangeStart: number,
  rangeEnd: number,
): Promise<{ total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }> {
  if (rangeEnd <= rangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const checksStart = rangeStart - intervalSec * 2;
  const { results: checkRows } = await db
    .prepare(
      `
        SELECT checked_at, status
        FROM check_results
        WHERE monitor_id = ?1
          AND checked_at >= ?2
          AND checked_at < ?3
        ORDER BY checked_at
      `,
    )
    .bind(monitorId, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const checks = (checkRows ?? []).map((row) => ({
    checked_at: row.checked_at,
    status: toCheckStatus(row.status),
  }));
  const effectiveRangeStart = resolveUptimeRangeStart(
    rangeStart,
    rangeEnd,
    createdAt,
    lastCheckedAt,
    checks,
  );
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const total_sec = rangeEnd - effectiveRangeStart;
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
    .bind(monitorId, rangeEnd, effectiveRangeStart)
    .all<{ started_at: number; ended_at: number | null }>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((row) => ({
        start: Math.max(row.started_at, effectiveRangeStart),
        end: Math.min(row.ended_at ?? rangeEnd, rangeEnd),
      }))
      .filter((interval) => interval.end > interval.start),
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksForUnknown =
    effectiveRangeStart > rangeStart
      ? checks.filter((check) => check.checked_at >= effectiveRangeStart)
      : checks;
  const unknownIntervals = buildUnknownIntervals(
    effectiveRangeStart,
    rangeEnd,
    intervalSec,
    checksForUnknown,
  );
  const unknown_sec = Math.max(
    0,
    sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
  );

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);

  return { total_sec, downtime_sec, unknown_sec, uptime_sec };
}

async function computePartialUptimeTotals(
  db: D1Database,
  monitorId: number,
  intervalSec: number,
  createdAt: number,
  lastCheckedAt: number | null,
  rangeStart: number,
  rangeEnd: number,
): Promise<{ total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }> {
  try {
    return await computePartialUptimeTotalsSql(
      db,
      monitorId,
      intervalSec,
      createdAt,
      lastCheckedAt,
      rangeStart,
      rangeEnd,
    );
  } catch (err) {
    console.warn('uptime: partial SQL failed, falling back to legacy', err);
    return computePartialUptimeTotalsLegacy(
      db,
      monitorId,
      intervalSec,
      createdAt,
      lastCheckedAt,
      rangeStart,
      rangeEnd,
    );
  }
}

async function buildCompactLatencyResponseJson(opts: {
  db: D1Database;
  monitor: { id: number; name: string };
  range: z.infer<typeof latencyRangeSchema>;
  rangeStart: number;
  rangeEnd: number;
}): Promise<string> {
  const row = await opts.db
    .prepare(
      `
        WITH ordered_points AS (
          SELECT
            checked_at,
            CASE status
              WHEN 'up' THEN 'u'
              WHEN 'down' THEN 'd'
              WHEN 'maintenance' THEN 'm'
              ELSE 'x'
            END AS status_code,
            latency_ms
          FROM check_results
          WHERE monitor_id = ?1
            AND checked_at >= ?2
            AND checked_at <= ?3
          ORDER BY checked_at
        ),
        up_latencies AS (
          SELECT
            latency_ms,
            row_number() OVER (ORDER BY latency_ms) AS rn,
            count(*) OVER () AS cnt
          FROM ordered_points
          WHERE status_code = 'u'
            AND latency_ms IS NOT NULL
        )
        SELECT
          COALESCE((SELECT json_group_array(checked_at) FROM ordered_points), '[]') AS checked_at_json,
          COALESCE((SELECT group_concat(status_code, '') FROM ordered_points), '') AS status_codes,
          COALESCE((SELECT json_group_array(latency_ms) FROM ordered_points), '[]') AS latency_ms_json,
          CAST(round((SELECT avg(latency_ms) FROM up_latencies)) AS INTEGER) AS avg_latency_ms,
          (
            SELECT latency_ms
            FROM up_latencies
            WHERE rn = ((95 * cnt + 99) / 100)
            LIMIT 1
          ) AS p95_latency_ms
      `,
    )
    .bind(opts.monitor.id, opts.rangeStart, opts.rangeEnd)
    .first<{
      checked_at_json: string | null;
      status_codes: string | null;
      latency_ms_json: string | null;
      avg_latency_ms: number | null;
      p95_latency_ms: number | null;
    }>();

  const monitorJson = JSON.stringify({
    id: opts.monitor.id,
    name: opts.monitor.name,
  });

  return `{"monitor":${monitorJson},"range":"${opts.range}","range_start_at":${opts.rangeStart},"range_end_at":${opts.rangeEnd},"avg_latency_ms":${jsonNumberLiteral(row?.avg_latency_ms)},"p95_latency_ms":${jsonNumberLiteral(row?.p95_latency_ms)},"points":{"checked_at":${jsonArrayLiteral(row?.checked_at_json)},"status_codes":${JSON.stringify(row?.status_codes ?? '')},"latency_ms":${jsonArrayLiteral(row?.latency_ms_json)}}}`;
}

export const publicUiRoutes = new Hono<{ Bindings: Env }>();
publicUiRoutes.onError(handleError);
publicUiRoutes.notFound(handleNotFound);

publicUiRoutes.use(
  '*',
  cachePublic({
    cacheName: 'uptimer-public',
    maxAgeSeconds: 30,
  }),
);

registerPublicUiAnalyticsRoutes(publicUiRoutes);

publicUiRoutes.get('/incidents', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));
  const resolvedOnly =
    z.coerce
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .default(0)
      .parse(c.req.query('resolved_only')) === 1;
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);

  let active: IncidentRow[] = [];
  let remaining = limit;
  if (!resolvedOnly) {
    const { results } = await c.env.DB.prepare(
      `
          SELECT id, title, status, impact, message, started_at, resolved_at
          FROM incidents
          WHERE status != 'resolved'
            AND ${incidentVisibilitySql}
          ORDER BY started_at DESC, id DESC
          LIMIT ?1
        `,
    )
      .bind(limit)
      .all<IncidentRow>();
    active = results ?? [];
    remaining = Math.max(0, limit - active.length);
  }

  let resolved: IncidentRow[] = [];
  let next_cursor: number | null = null;
  if (remaining > 0) {
    const baseSql = `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status = 'resolved'
        AND ${incidentVisibilitySql}
    `;
    const resolvedLimitPlusOne = remaining + 1;
    const batchLimit = Math.max(50, resolvedLimitPlusOne);
    let seekCursor = cursor;
    const collected: IncidentRow[] = [];

    while (collected.length < resolvedLimitPlusOne) {
      const { results } = seekCursor
        ? await c.env.DB.prepare(
            `
                ${baseSql}
                  AND id < ?2
                ORDER BY id DESC
                LIMIT ?1
              `,
          )
            .bind(batchLimit, seekCursor)
            .all<IncidentRow>()
        : await c.env.DB.prepare(
            `
                ${baseSql}
                ORDER BY id DESC
                LIMIT ?1
              `,
          )
            .bind(batchLimit)
            .all<IncidentRow>();

      const rows = results ?? [];
      if (rows.length === 0) break;
      collected.push(...rows);
      const lastRow = rows[rows.length - 1];
      if (rows.length < batchLimit || !lastRow) break;
      seekCursor = lastRow.id;
    }

    resolved = collected.slice(0, remaining);
    next_cursor = collected.length > remaining ? (resolved[resolved.length - 1]?.id ?? null) : null;
  }

  const combined = [...active, ...resolved];
  const [updatesByIncidentId, monitorIdsByIncidentId] = await Promise.all([
    listIncidentUpdatesByIncidentId(
      c.env.DB,
      combined.map((row) => row.id),
    ),
    listIncidentMonitorIdsByIncidentId(
      c.env.DB,
      combined.map((row) => row.id),
    ),
  ]);

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(c.env.DB, [...monitorIdsByIncidentId.values()].flat());

  return withVisibilityAwareCaching(
    c.json({
      incidents: combined.flatMap((row) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [incidentRowToApi(row, updatesByIncidentId.get(row.id) ?? [], filteredMonitorIds)];
      }),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/maintenance-windows', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));
  const now = Math.floor(Date.now() / 1000);

  return withVisibilityAwareCaching(
    c.json(
      await listPublicMaintenanceWindowsPage({
        db: c.env.DB,
        now,
        limit,
        cursor,
        includeHiddenMonitors,
      }),
    ),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/day-context', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const dayStartAt = z.coerce.number().int().nonnegative().parse(c.req.query('day_start_at'));
  const dayEndAt = dayStartAt + 86400;
  const trace = createTrace(c);
  trace.setLabel('route', 'public/day-context');
  trace.setLabel('monitor_id', id);

  const [monitorResult, maintenanceResult, incidentResult] = await trace.timeAsync(
    'primary_queries',
    async () =>
      await c.env.DB.batch([
        preparePublicUiStatement(
          c.env.DB,
          `
            SELECT id
            FROM monitors
            WHERE id = ?1 AND is_active = 1
              AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
          `,
        ).bind(id),
        preparePublicUiStatement(
          c.env.DB,
          `
            SELECT mw.id, mw.title, mw.message, mw.starts_at, mw.ends_at, mw.created_at
            FROM maintenance_windows mw
            JOIN maintenance_window_monitors mwm ON mwm.maintenance_window_id = mw.id
            WHERE mwm.monitor_id = ?1
              AND mw.starts_at < ?3
              AND mw.ends_at > ?2
            ORDER BY mw.starts_at ASC, mw.id ASC
            LIMIT 50
          `,
        ).bind(id, dayStartAt, dayEndAt),
        preparePublicUiStatement(
          c.env.DB,
          `
            SELECT i.id, i.title, i.status, i.impact, i.message, i.started_at, i.resolved_at
            FROM incidents i
            JOIN incident_monitors im ON im.incident_id = i.id
            WHERE im.monitor_id = ?1
              AND i.started_at < ?3
              AND (i.resolved_at IS NULL OR i.resolved_at > ?2)
            ORDER BY i.started_at ASC, i.id ASC
            LIMIT 50
          `,
        ).bind(id, dayStartAt, dayEndAt),
      ]),
  );
  const monitor = takeBatchFirstRow<{ id: number }>(monitorResult);
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }
  const maintenance = takeBatchRows<MaintenanceWindowRow>(maintenanceResult);
  const incidents = takeBatchRows<IncidentRow>(incidentResult);
  if (maintenance.length === 0 && incidents.length === 0) {
    const res = withVisibilityAwareCaching(
      c.json({
        day_start_at: dayStartAt,
        day_end_at: dayEndAt,
        maintenance_windows: [],
        incidents: [],
      }),
      includeHiddenMonitors,
    );
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  const maintenanceIds = maintenance.map((row) => row.id);
  const incidentIds = incidents.map((row) => row.id);
  const expansionStatements: D1PreparedStatement[] = [];
  const expansionIndexes = {
    windowMonitorIds: -1,
    incidentUpdates: -1,
    incidentMonitorIds: -1,
  };

  if (maintenanceIds.length > 0) {
    expansionIndexes.windowMonitorIds = expansionStatements.length;
    const placeholders = buildNumberedPlaceholders(maintenanceIds.length);
    expansionStatements.push(
      preparePublicUiStatement(
        c.env.DB,
        `
          SELECT maintenance_window_id, monitor_id
          FROM maintenance_window_monitors
          WHERE maintenance_window_id IN (${placeholders})
          ORDER BY maintenance_window_id, monitor_id
        `,
      ).bind(...maintenanceIds),
    );
  }

  if (incidentIds.length > 0) {
    const placeholders = buildNumberedPlaceholders(incidentIds.length);
    expansionIndexes.incidentUpdates = expansionStatements.length;
    expansionStatements.push(
      preparePublicUiStatement(
        c.env.DB,
        `
          SELECT id, incident_id, status, message, created_at
          FROM incident_updates
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, created_at, id
        `,
      ).bind(...incidentIds),
    );

    expansionIndexes.incidentMonitorIds = expansionStatements.length;
    expansionStatements.push(
      preparePublicUiStatement(
        c.env.DB,
        `
          SELECT incident_id, monitor_id
          FROM incident_monitors
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, monitor_id
        `,
      ).bind(...incidentIds),
    );
  }

  const expansionResults =
    expansionStatements.length === 0
      ? []
      : await trace.timeAsync(
          'expansion_queries',
          async () => await c.env.DB.batch(expansionStatements),
        );
  const monitorIdsByWindowId =
    expansionIndexes.windowMonitorIds === -1
      ? new Map<number, number[]>()
      : buildNumberMap<number, MaintenanceWindowMonitorLinkRow>(
          takeBatchRows<MaintenanceWindowMonitorLinkRow>(
            expansionResults[expansionIndexes.windowMonitorIds],
          ),
          'maintenance_window_id',
          (row) => row.monitor_id,
        );
  const updatesByIncidentId =
    expansionIndexes.incidentUpdates === -1
      ? new Map<number, IncidentUpdateRow[]>()
      : buildRowArrayMap<number, IncidentUpdateRow>(
          takeBatchRows<IncidentUpdateRow>(expansionResults[expansionIndexes.incidentUpdates]),
          'incident_id',
        );
  const monitorIdsByIncidentId =
    expansionIndexes.incidentMonitorIds === -1
      ? new Map<number, number[]>()
      : buildNumberMap<number, IncidentMonitorLinkRow>(
          takeBatchRows<IncidentMonitorLinkRow>(
            expansionResults[expansionIndexes.incidentMonitorIds],
          ),
          'incident_id',
          (row) => row.monitor_id,
        );

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await trace.timeAsync('visibility_query', async () => {
        const scopedMonitorIds = [
          ...monitorIdsByWindowId.values(),
          ...monitorIdsByIncidentId.values(),
        ].flat();
        return scopedMonitorIds.length === 0
          ? new Set<number>()
          : listStatusPageVisibleMonitorIds(c.env.DB, scopedMonitorIds);
      });

  const res = withVisibilityAwareCaching(
    c.json({
      day_start_at: dayStartAt,
      day_end_at: dayEndAt,
      maintenance_windows: maintenance.flatMap((row) => {
        const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [maintenanceWindowRowToApi(row, filteredMonitorIds)];
      }),
      incidents: incidents.flatMap((row) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [incidentRowToApi(row, updatesByIncidentId.get(row.id) ?? [], filteredMonitorIds)];
      }),
    }),
    includeHiddenMonitors,
  );
  trace.finish('total');
  applyTraceToResponse({ res, trace, prefix: 'w' });
  return res;
});

publicUiRoutes.get('/monitors/:id/outages', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = z.enum(['30d']).optional().default('30d').parse(c.req.query('range'));
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(200)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const monitor = await c.env.DB.prepare(
    `
        SELECT id, created_at
        FROM monitors
        WHERE id = ?1 AND is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
      `,
  )
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = Math.max(rangeEnd - 30 * 86400, monitor.created_at);
  const take = limit + 1;
  const sqlBase = `
    SELECT id, started_at, ended_at, initial_error, last_error
    FROM outages
    WHERE monitor_id = ?1
      AND started_at < ?2
      AND (ended_at IS NULL OR ended_at > ?3)
  `;

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
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>()
    : await c.env.DB.prepare(
        `
            ${sqlBase}
            ORDER BY id DESC
            LIMIT ?4
          `,
      )
        .bind(id, rangeEnd, rangeStart, take)
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return withVisibilityAwareCaching(
    c.json({
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      outages: page.map((row) => ({
        id: row.id,
        monitor_id: id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        initial_error: row.initial_error,
        last_error: row.last_error,
      })),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/latency', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = latencyRangeSchema.optional().default('24h').parse(c.req.query('range'));
  const format = c.req.query('format');
  if (format !== 'compact-v1') {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Unsupported latency format');
  }

  const monitor = await c.env.DB.prepare(
    `
        SELECT id, name
        FROM monitors
        WHERE id = ?1 AND is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
      `,
  )
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = rangeEnd - 24 * 60 * 60;
  const bodyJson = await buildCompactLatencyResponseJson({
    db: c.env.DB,
    monitor,
    range,
    rangeStart,
    rangeEnd,
  });
  return withVisibilityAwareCaching(
    new Response(bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/uptime', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = uptimeRangeSchema.optional().default('24h').parse(c.req.query('range'));
  const trace = createTrace(c);
  trace.setLabel('route', 'public/monitor-uptime');
  trace.setLabel('monitor_id', id);
  trace.setLabel('range', range);

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const requestedRangeStart = rangeEnd - rangeToSeconds(range);
  const startDay = utcDayStart(requestedRangeStart);
  const endDay = utcDayStart(rangeEnd);
  const windowBatchStatements: D1PreparedStatement[] = [];
  const windowIndexes = {
    monitor: -1,
    firstCheck: -1,
    startPartial: -1,
    singlePartial: -1,
    rollup: -1,
    runtime: -1,
  };

  windowIndexes.monitor = windowBatchStatements.length;
  windowBatchStatements.push(
    preparePublicUiStatement(
      c.env.DB,
      `
        SELECT m.id, m.name, m.interval_sec, m.created_at, s.last_checked_at
        FROM monitors m
        LEFT JOIN monitor_state s ON s.monitor_id = m.id
        WHERE m.id = ?1 AND m.is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      `,
    ).bind(id),
  );

  windowIndexes.firstCheck = windowBatchStatements.length;
  windowBatchStatements.push(
    preparePublicUiStatement(
      c.env.DB,
      `
        SELECT checked_at
        FROM check_results
        WHERE monitor_id = ?1
          AND checked_at >= ?2
          AND checked_at < ?3
        ORDER BY checked_at
        LIMIT 1
      `,
    ).bind(id, requestedRangeStart, rangeEnd),
  );

  if (startDay === endDay) {
    windowIndexes.singlePartial = windowBatchStatements.length;
    windowBatchStatements.push(
      preparePublicUiStatement(
        c.env.DB,
        `
          WITH input(monitor_id, interval_sec, created_at, last_checked_at) AS (
            SELECT m.id, m.interval_sec, m.created_at, s.last_checked_at
            FROM monitors m
            LEFT JOIN monitor_state s ON s.monitor_id = m.id
            WHERE m.id = ?3
          ),
          first_checks AS (
            SELECT monitor_id, MIN(checked_at) AS first_check_at
            FROM check_results
            WHERE monitor_id IN (SELECT monitor_id FROM input)
              AND checked_at >= ?1
              AND checked_at < ?2
            GROUP BY monitor_id
          ),
          effective AS (
            SELECT
              i.monitor_id AS monitor_id,
              i.interval_sec AS interval_sec,
              CASE
                WHEN i.created_at >= ?1 THEN
                  COALESCE(
                    fc.first_check_at,
                    CASE WHEN i.last_checked_at IS NULL THEN NULL ELSE i.created_at END
                  )
                ELSE ?1
              END AS start_at
            FROM input i
            LEFT JOIN first_checks fc ON fc.monitor_id = i.monitor_id
          ),
          downtime_segments AS (
            SELECT
              o.monitor_id AS monitor_id,
              max(o.started_at, e.start_at) AS seg_start,
              min(coalesce(o.ended_at, ?2), ?2) AS seg_end
            FROM outages o
            JOIN effective e ON e.monitor_id = o.monitor_id
            WHERE e.start_at IS NOT NULL
              AND o.started_at < ?2
              AND (o.ended_at IS NULL OR o.ended_at > e.start_at)
          ),
          downtime AS (
            SELECT monitor_id, sum(max(0, seg_end - seg_start)) AS downtime_sec
            FROM downtime_segments
            GROUP BY monitor_id
          ),
          checks AS (
            SELECT
              cr.monitor_id AS monitor_id,
              cr.checked_at AS checked_at,
              cr.status AS status,
              e.interval_sec AS interval_sec,
              e.start_at AS start_at,
              lag(cr.checked_at) OVER (
                PARTITION BY cr.monitor_id
                ORDER BY cr.checked_at
              ) AS prev_at,
              lag(cr.status) OVER (
                PARTITION BY cr.monitor_id
                ORDER BY cr.checked_at
              ) AS prev_status
            FROM check_results cr
            JOIN effective e ON e.monitor_id = cr.monitor_id
            WHERE e.start_at IS NOT NULL
              AND cr.checked_at >= max(0, e.start_at - e.interval_sec * 2)
              AND cr.checked_at < ?2
          ),
          unknown_checks AS (
            SELECT
              monitor_id AS monitor_id,
              CASE
                WHEN prev_at IS NULL THEN start_at
                WHEN prev_status = 'unknown' THEN (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END)
                ELSE max(
                  (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END),
                  prev_at + interval_sec * 2
                )
              END AS seg_start,
              checked_at AS seg_end
            FROM checks
            WHERE checked_at >= start_at
          ),
          last_any AS (
            SELECT monitor_id, checked_at, status
            FROM (
              SELECT
                monitor_id,
                checked_at,
                status,
                row_number() OVER (
                  PARTITION BY monitor_id
                  ORDER BY checked_at DESC
                ) AS rn
              FROM checks
            )
            WHERE rn = 1
          ),
          last_in_range AS (
            SELECT monitor_id, checked_at
            FROM (
              SELECT
                monitor_id,
                checked_at,
                row_number() OVER (
                  PARTITION BY monitor_id
                  ORDER BY checked_at DESC
                ) AS rn
              FROM checks
              WHERE checked_at >= start_at
            )
            WHERE rn = 1
          ),
          unknown_tail AS (
            SELECT
              e.monitor_id AS monitor_id,
              CASE
                WHEN la.checked_at IS NULL THEN coalesce(lir.checked_at, e.start_at)
                WHEN la.status = 'unknown' THEN coalesce(lir.checked_at, e.start_at)
                ELSE max(coalesce(lir.checked_at, e.start_at), la.checked_at + e.interval_sec * 2)
              END AS seg_start,
              ?2 AS seg_end
            FROM effective e
            LEFT JOIN last_any la ON la.monitor_id = e.monitor_id
            LEFT JOIN last_in_range lir ON lir.monitor_id = e.monitor_id
            WHERE e.start_at IS NOT NULL
          ),
          unknown_segments AS (
            SELECT monitor_id, seg_start, seg_end
            FROM unknown_checks
            WHERE seg_end > seg_start
            UNION ALL
            SELECT monitor_id, seg_start, seg_end
            FROM unknown_tail
            WHERE seg_end > seg_start
          ),
          unknown_raw AS (
            SELECT monitor_id, sum(seg_end - seg_start) AS unknown_raw_sec
            FROM unknown_segments
            GROUP BY monitor_id
          ),
          unknown_overlap AS (
            SELECT
              u.monitor_id AS monitor_id,
              sum(
                max(0, min(u.seg_end, d.seg_end) - max(u.seg_start, d.seg_start))
              ) AS overlap_sec
            FROM unknown_segments u
            JOIN downtime_segments d ON d.monitor_id = u.monitor_id
            WHERE u.seg_end > d.seg_start AND d.seg_end > u.seg_start
            GROUP BY u.monitor_id
          )
          SELECT
            e.start_at AS start_at,
            (?2 - e.start_at) AS total_sec,
            coalesce(d.downtime_sec, 0) AS downtime_sec,
            max(0, coalesce(u.unknown_raw_sec, 0) - coalesce(o.overlap_sec, 0)) AS unknown_sec
          FROM effective e
          LEFT JOIN downtime d ON d.monitor_id = e.monitor_id
          LEFT JOIN unknown_raw u ON u.monitor_id = e.monitor_id
          LEFT JOIN unknown_overlap o ON o.monitor_id = e.monitor_id
          WHERE e.start_at IS NOT NULL
        `,
      ).bind(requestedRangeStart, rangeEnd, id),
    );
  } else {
    const startPartialEnd = Math.min(rangeEnd, startDay + 86400);
    windowIndexes.startPartial = windowBatchStatements.length;
    windowBatchStatements.push(
      preparePublicUiStatement(
        c.env.DB,
        `
          WITH input(monitor_id, interval_sec, created_at, last_checked_at) AS (
            SELECT m.id, m.interval_sec, m.created_at, s.last_checked_at
            FROM monitors m
            LEFT JOIN monitor_state s ON s.monitor_id = m.id
            WHERE m.id = ?3
          ),
          first_checks AS (
            SELECT monitor_id, MIN(checked_at) AS first_check_at
            FROM check_results
            WHERE monitor_id IN (SELECT monitor_id FROM input)
              AND checked_at >= ?1
              AND checked_at < ?2
            GROUP BY monitor_id
          ),
          effective AS (
            SELECT
              i.monitor_id AS monitor_id,
              i.interval_sec AS interval_sec,
              CASE
                WHEN i.created_at >= ?1 THEN
                  COALESCE(
                    fc.first_check_at,
                    CASE WHEN i.last_checked_at IS NULL THEN NULL ELSE i.created_at END
                  )
                ELSE ?1
              END AS start_at
            FROM input i
            LEFT JOIN first_checks fc ON fc.monitor_id = i.monitor_id
          ),
          downtime_segments AS (
            SELECT
              o.monitor_id AS monitor_id,
              max(o.started_at, e.start_at) AS seg_start,
              min(coalesce(o.ended_at, ?2), ?2) AS seg_end
            FROM outages o
            JOIN effective e ON e.monitor_id = o.monitor_id
            WHERE e.start_at IS NOT NULL
              AND o.started_at < ?2
              AND (o.ended_at IS NULL OR o.ended_at > e.start_at)
          ),
          downtime AS (
            SELECT monitor_id, sum(max(0, seg_end - seg_start)) AS downtime_sec
            FROM downtime_segments
            GROUP BY monitor_id
          ),
          checks AS (
            SELECT
              cr.monitor_id AS monitor_id,
              cr.checked_at AS checked_at,
              cr.status AS status,
              e.interval_sec AS interval_sec,
              e.start_at AS start_at,
              lag(cr.checked_at) OVER (
                PARTITION BY cr.monitor_id
                ORDER BY cr.checked_at
              ) AS prev_at,
              lag(cr.status) OVER (
                PARTITION BY cr.monitor_id
                ORDER BY cr.checked_at
              ) AS prev_status
            FROM check_results cr
            JOIN effective e ON e.monitor_id = cr.monitor_id
            WHERE e.start_at IS NOT NULL
              AND cr.checked_at >= max(0, e.start_at - e.interval_sec * 2)
              AND cr.checked_at < ?2
          ),
          unknown_checks AS (
            SELECT
              monitor_id AS monitor_id,
              CASE
                WHEN prev_at IS NULL THEN start_at
                WHEN prev_status = 'unknown' THEN (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END)
                ELSE max(
                  (CASE WHEN prev_at >= start_at THEN prev_at ELSE start_at END),
                  prev_at + interval_sec * 2
                )
              END AS seg_start,
              checked_at AS seg_end
            FROM checks
            WHERE checked_at >= start_at
          ),
          last_any AS (
            SELECT monitor_id, checked_at, status
            FROM (
              SELECT
                monitor_id,
                checked_at,
                status,
                row_number() OVER (
                  PARTITION BY monitor_id
                  ORDER BY checked_at DESC
                ) AS rn
              FROM checks
            )
            WHERE rn = 1
          ),
          last_in_range AS (
            SELECT monitor_id, checked_at
            FROM (
              SELECT
                monitor_id,
                checked_at,
                row_number() OVER (
                  PARTITION BY monitor_id
                  ORDER BY checked_at DESC
                ) AS rn
              FROM checks
              WHERE checked_at >= start_at
            )
            WHERE rn = 1
          ),
          unknown_tail AS (
            SELECT
              e.monitor_id AS monitor_id,
              CASE
                WHEN la.checked_at IS NULL THEN coalesce(lir.checked_at, e.start_at)
                WHEN la.status = 'unknown' THEN coalesce(lir.checked_at, e.start_at)
                ELSE max(coalesce(lir.checked_at, e.start_at), la.checked_at + e.interval_sec * 2)
              END AS seg_start,
              ?2 AS seg_end
            FROM effective e
            LEFT JOIN last_any la ON la.monitor_id = e.monitor_id
            LEFT JOIN last_in_range lir ON lir.monitor_id = e.monitor_id
            WHERE e.start_at IS NOT NULL
          ),
          unknown_segments AS (
            SELECT monitor_id, seg_start, seg_end
            FROM unknown_checks
            WHERE seg_end > seg_start
            UNION ALL
            SELECT monitor_id, seg_start, seg_end
            FROM unknown_tail
            WHERE seg_end > seg_start
          ),
          unknown_raw AS (
            SELECT monitor_id, sum(seg_end - seg_start) AS unknown_raw_sec
            FROM unknown_segments
            GROUP BY monitor_id
          ),
          unknown_overlap AS (
            SELECT
              u.monitor_id AS monitor_id,
              sum(
                max(0, min(u.seg_end, d.seg_end) - max(u.seg_start, d.seg_start))
              ) AS overlap_sec
            FROM unknown_segments u
            JOIN downtime_segments d ON d.monitor_id = u.monitor_id
            WHERE u.seg_end > d.seg_start AND d.seg_end > u.seg_start
            GROUP BY u.monitor_id
          )
          SELECT
            e.start_at AS start_at,
            (?2 - e.start_at) AS total_sec,
            coalesce(d.downtime_sec, 0) AS downtime_sec,
            max(0, coalesce(u.unknown_raw_sec, 0) - coalesce(o.overlap_sec, 0)) AS unknown_sec
          FROM effective e
          LEFT JOIN downtime d ON d.monitor_id = e.monitor_id
          LEFT JOIN unknown_raw u ON u.monitor_id = e.monitor_id
          LEFT JOIN unknown_overlap o ON o.monitor_id = e.monitor_id
          WHERE e.start_at IS NOT NULL
        `,
      ).bind(requestedRangeStart, startPartialEnd, id),
    );

    const fullDaysStart = startDay + 86400;
    const fullDaysEnd = endDay;
    if (fullDaysStart < fullDaysEnd) {
      windowIndexes.rollup = windowBatchStatements.length;
      windowBatchStatements.push(
        preparePublicUiStatement(
          c.env.DB,
          `
            SELECT
              SUM(total_sec) AS total_sec,
              SUM(downtime_sec) AS downtime_sec,
              SUM(unknown_sec) AS unknown_sec,
              SUM(uptime_sec) AS uptime_sec
            FROM monitor_daily_rollups
            WHERE monitor_id = ?1
              AND day_start_at >= ?2
              AND day_start_at < ?3
          `,
        ).bind(id, fullDaysStart, fullDaysEnd),
      );
    }

    if (endDay < rangeEnd) {
      windowIndexes.runtime = windowBatchStatements.length;
      windowBatchStatements.push(
        preparePublicUiStatement(
          c.env.DB,
          `
            SELECT
              generated_at,
              CAST(json_extract(body_json, '$.day_start_at') AS INTEGER) AS day_start_at,
              (
                SELECT entry.value
                FROM json_each(public_snapshots.body_json, '$.monitors') AS entry
                WHERE CAST(json_extract(entry.value, '$.monitor_id') AS INTEGER) = ?2
                LIMIT 1
              ) AS monitor_json
            FROM public_snapshots
            WHERE key = ?1
          `,
        ).bind(MONITOR_RUNTIME_SNAPSHOT_KEY, id),
      );
    }
  }

  const windowResults =
    windowBatchStatements.length === 0
      ? []
      : await trace.timeAsync(
          'window_queries',
          async () => await c.env.DB.batch(windowBatchStatements),
        );

  const monitor = takeBatchFirstRow<{
    id: number;
    name: string;
    interval_sec: number;
    created_at: number;
    last_checked_at: number | null;
  }>(windowResults[windowIndexes.monitor]);
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const rangeStart = Math.max(requestedRangeStart, monitor.created_at);
  const firstCheckCandidate =
    takeBatchFirstRow<{ checked_at: number }>(windowResults[windowIndexes.firstCheck])
      ?.checked_at ?? null;
  const firstCheckAt =
    typeof firstCheckCandidate === 'number' && firstCheckCandidate >= monitor.created_at
      ? firstCheckCandidate
      : null;
  const effectiveRangeStart = resolveUptimeRangeStartFromFirstCheck({
    rangeStart,
    rangeEnd,
    monitorCreatedAt: monitor.created_at,
    lastCheckedAt: monitor.last_checked_at,
    firstCheckAt,
  });
  const rangeStartAt = effectiveRangeStart ?? rangeStart;
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    const res = withVisibilityAwareCaching(
      c.json({
        monitor: { id: monitor.id, name: monitor.name },
        range,
        range_start_at: rangeStartAt,
        range_end_at: rangeEnd,
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: 0,
      }),
      includeHiddenMonitors,
    );
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  const totals = {
    total_sec: 0,
    downtime_sec: 0,
    unknown_sec: 0,
    uptime_sec: 0,
  };

  if (startDay === endDay) {
    const singlePartial = takeBatchFirstRow<{
      start_at: number | null;
      total_sec: number | null;
      downtime_sec: number | null;
      unknown_sec: number | null;
    }>(windowResults[windowIndexes.singlePartial]);

    if (singlePartial?.start_at !== null && singlePartial?.start_at !== undefined) {
      const total_sec = Math.max(0, singlePartial.total_sec ?? 0);
      const downtime_sec = Math.max(0, singlePartial.downtime_sec ?? 0);
      const unknown_sec = Math.max(0, singlePartial.unknown_sec ?? 0);
      const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
      addUptimeTotals(totals, {
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec: Math.max(0, total_sec - unavailable_sec),
      });
    }
  } else {
    const startPartial = takeBatchFirstRow<{
      start_at: number | null;
      total_sec: number | null;
      downtime_sec: number | null;
      unknown_sec: number | null;
    }>(windowResults[windowIndexes.startPartial]);

    if (
      startPartial?.start_at !== null &&
      startPartial?.start_at !== undefined &&
      effectiveRangeStart < Math.min(rangeEnd, startDay + 86400)
    ) {
      const total_sec = Math.max(0, startPartial.total_sec ?? 0);
      const downtime_sec = Math.max(0, startPartial.downtime_sec ?? 0);
      const unknown_sec = Math.max(0, startPartial.unknown_sec ?? 0);
      const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
      addUptimeTotals(totals, {
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec: Math.max(0, total_sec - unavailable_sec),
      });
    }

    const rollup = takeBatchFirstRow<{
      total_sec: number | null;
      downtime_sec: number | null;
      unknown_sec: number | null;
      uptime_sec: number | null;
    }>(windowIndexes.rollup === -1 ? null : windowResults[windowIndexes.rollup]);
    if (rollup) {
      addUptimeTotals(totals, {
        total_sec: rollup.total_sec ?? 0,
        downtime_sec: rollup.downtime_sec ?? 0,
        unknown_sec: rollup.unknown_sec ?? 0,
        uptime_sec: rollup.uptime_sec ?? 0,
      });
    }

    const runtimeEntryRow = takeBatchFirstRow<{
      generated_at: number;
      day_start_at: number | null;
      monitor_json: string | null;
    }>(windowIndexes.runtime === -1 ? null : windowResults[windowIndexes.runtime]);
    const runtimeEntry =
      runtimeEntryRow &&
      typeof runtimeEntryRow.generated_at === 'number' &&
      Math.max(0, rangeEnd - runtimeEntryRow.generated_at) <= MONITOR_RUNTIME_MAX_AGE_SECONDS &&
      runtimeEntryRow.day_start_at === utcDayStart(rangeEnd) &&
      typeof runtimeEntryRow.monitor_json === 'string'
        ? parsePublicMonitorRuntimeEntryJson(runtimeEntryRow.monitor_json)
        : null;

    if (runtimeEntry) {
      addUptimeTotals(totals, materializeMonitorRuntimeTotals(runtimeEntry, rangeEnd));
    } else if (endDay < rangeEnd) {
      addUptimeTotals(
        totals,
        await trace.timeAsync(
          'end_partial_fallback',
          async () =>
            await computePartialUptimeTotals(
              c.env.DB,
              monitor.id,
              monitor.interval_sec,
              monitor.created_at,
              monitor.last_checked_at,
              endDay,
              rangeEnd,
            ),
        ),
      );
    }
  }

  const res = withVisibilityAwareCaching(
    c.json({
      monitor: { id: monitor.id, name: monitor.name },
      range,
      range_start_at: rangeStartAt,
      range_end_at: rangeEnd,
      total_sec: totals.total_sec,
      downtime_sec: totals.downtime_sec,
      unknown_sec: totals.unknown_sec,
      uptime_sec: totals.uptime_sec,
      uptime_pct: totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100,
    }),
    includeHiddenMonitors,
  );
  trace.finish('total');
  applyTraceToResponse({ res, trace, prefix: 'w' });
  return res;
});
