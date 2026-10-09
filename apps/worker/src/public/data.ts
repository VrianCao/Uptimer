import type { PublicStatusResponse } from '../schemas/public-status';

import {
  buildUnknownIntervals,
  mergeIntervals,
  overlapSeconds,
  sumIntervals,
} from '../analytics/uptime';
import {
  materializeMonitorRuntimeTotals,
  readPublicMonitorRuntimeSnapshot,
  runtimeEntryToHeartbeats,
  snapshotHasMonitorIds,
  toMonitorRuntimeEntryMap,
} from './monitor-runtime';
import { readSettings } from '../settings';
import {
  buildNumberedPlaceholders,
  chunkPositiveIntegerIds,
  filterStatusPageScopedMonitorIds,
  incidentStatusPageVisibilityPredicate,
  listStatusPageVisibleMonitorIds,
  maintenanceWindowStatusPageVisibilityPredicate,
  monitorVisibilityPredicate,
  shouldIncludeStatusPageScopedItem,
} from './visibility';

export type PublicStatusMonitorRow = {
  id: number;
  name: string;
  type: string;
  display_url: string | null;
  group_name: string | null;
  group_sort_order: number;
  sort_order: number;
  interval_sec: number;
  created_at: number;
  state_status: string | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
};

export type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

export type IncidentUpdateRow = {
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

export type MaintenanceWindowRow = {
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

type DailyRollupRow = {
  monitor_id: number;
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
};

type HeartbeatRow = {
  monitor_id: number;
  checked_at: number;
  status: string;
  latency_ms: number | null;
};

export type UptimeWindowTotals = {
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number | null;
};

export type BannerStatus = PublicStatusResponse['banner']['status'];
export type Banner = PublicStatusResponse['banner'];
export type MonitorStatus = PublicStatusResponse['overall_status'];
export type CheckStatus = PublicStatusResponse['monitors'][number]['heartbeats'][number]['status'];

export type FilteredIncidentEntry = {
  row: IncidentRow;
  monitorIds: number[];
};

export type FilteredMaintenanceWindowEntry = {
  row: MaintenanceWindowRow;
  monitorIds: number[];
};

export type VisibleActiveIncidentSummary = {
  items: FilteredIncidentEntry[];
  bannerIncident: FilteredIncidentEntry | null;
};

export const STATUS_ACTIVE_INCIDENT_LIMIT = 5;
export const STATUS_ACTIVE_MAINTENANCE_LIMIT = 3;
export const STATUS_UPCOMING_MAINTENANCE_LIMIT = 5;

const UPTIME_DAYS = 60;
const HEARTBEAT_POINTS = 60;
const D1_MAX_SQL_VARIABLES = 100;
const TODAY_PARTIAL_UPTIME_FIXED_BINDINGS = 2;
const TODAY_PARTIAL_UPTIME_BINDINGS_PER_MONITOR = 4;
const TODAY_PARTIAL_UPTIME_SQL_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    (D1_MAX_SQL_VARIABLES - TODAY_PARTIAL_UPTIME_FIXED_BINDINGS) /
      TODAY_PARTIAL_UPTIME_BINDINGS_PER_MONITOR,
  ),
);

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function incidentImpactRank(
  impact: PublicStatusResponse['active_incidents'][number]['impact'],
): number {
  switch (impact) {
    case 'critical':
      return 3;
    case 'major':
      return 2;
    case 'minor':
      return 1;
    case 'none':
    default:
      return 0;
  }
}

function chooseTopIncidentEntry(
  entries: readonly FilteredIncidentEntry[],
): FilteredIncidentEntry | null {
  let best: FilteredIncidentEntry | null = null;

  for (const entry of entries) {
    if (!best) {
      best = entry;
      continue;
    }

    const candidateRank = incidentImpactRank(toIncidentImpact(entry.row.impact));
    const bestRank = incidentImpactRank(toIncidentImpact(best.row.impact));
    if (candidateRank > bestRank) {
      best = entry;
      continue;
    }
    if (candidateRank < bestRank) {
      continue;
    }

    if (entry.row.started_at > best.row.started_at) {
      best = entry;
      continue;
    }
    if (entry.row.started_at === best.row.started_at && entry.row.id > best.row.id) {
      best = entry;
    }
  }

  return best;
}

async function mapVisibleIncidentEntries(
  db: D1Database,
  rows: IncidentRow[],
  includeHiddenMonitors: boolean,
): Promise<Map<number, FilteredIncidentEntry>> {
  const byId = new Map<number, FilteredIncidentEntry>();
  if (rows.length === 0) {
    return byId;
  }

  const incidentMonitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    db,
    rows.map((row) => row.id),
  );

  const statusPageVisibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(
        db,
        [...incidentMonitorIdsByIncidentId.values()].flat(),
      );

  for (const row of rows) {
    const originalMonitorIds = incidentMonitorIdsByIncidentId.get(row.id) ?? [];
    const visibleMonitorIds = filterStatusPageScopedMonitorIds(
      originalMonitorIds,
      statusPageVisibleMonitorIds,
      includeHiddenMonitors,
    );

    if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, visibleMonitorIds)) {
      continue;
    }

    byId.set(row.id, {
      row,
      monitorIds: visibleMonitorIds,
    });
  }

  return byId;
}

export function toMonitorStatus(value: string | null): MonitorStatus {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function toCheckStatus(value: string | null): CheckStatus {
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

export function toIncidentStatus(
  value: string | null,
): PublicStatusResponse['active_incidents'][number]['status'] {
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

export function toIncidentImpact(
  value: string | null,
): PublicStatusResponse['active_incidents'][number]['impact'] {
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
  } satisfies PublicStatusResponse['active_incidents'][number]['updates'][number];
}

export function incidentRowToApi(
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
  } satisfies PublicStatusResponse['active_incidents'][number];
}

export function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  } satisfies PublicStatusResponse['maintenance_windows']['active'][number];
}

export async function listHeartbeatsByMonitorId(
  db: D1Database,
  monitorIds: number[],
  limitPerMonitor: number,
): Promise<Map<number, PublicStatusResponse['monitors'][number]['heartbeats']>> {
  const byMonitor = new Map<number, PublicStatusResponse['monitors'][number]['heartbeats']>();

  const ids = [...new Set(monitorIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return byMonitor;

  const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(', ');
  const sql = `
    SELECT monitor_id, checked_at, status, latency_ms
    FROM (
      SELECT
        id,
        monitor_id,
        checked_at,
        status,
        latency_ms,
        ROW_NUMBER() OVER (
          PARTITION BY monitor_id
          ORDER BY checked_at DESC, id DESC
        ) AS rn
      FROM check_results
      WHERE monitor_id IN (${placeholders})
    )
    WHERE rn <= ?1
    ORDER BY monitor_id, checked_at DESC, id DESC
  `;

  const { results } = await db
    .prepare(sql)
    .bind(limitPerMonitor, ...ids)
    .all<HeartbeatRow>();
  for (const r of results ?? []) {
    appendMapValue(byMonitor, r.monitor_id, {
      checked_at: r.checked_at,
      status: toCheckStatus(r.status),
      latency_ms: r.latency_ms,
    });
  }

  return byMonitor;
}

export async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT id, incident_id, status, message, created_at
      FROM incident_updates
      WHERE incident_id IN (${placeholders})
      ORDER BY incident_id, created_at, id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<IncidentUpdateRow>();
    for (const r of results ?? []) {
      appendMapValue(byIncident, r.incident_id, r);
    }
  }

  return byIncident;
}

export async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT incident_id, monitor_id
      FROM incident_monitors
      WHERE incident_id IN (${placeholders})
      ORDER BY incident_id, monitor_id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<IncidentMonitorLinkRow>();
    for (const r of results ?? []) {
      appendMapValue(byIncident, r.incident_id, r.monitor_id);
    }
  }

  return byIncident;
}

export async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(windowIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT maintenance_window_id, monitor_id
      FROM maintenance_window_monitors
      WHERE maintenance_window_id IN (${placeholders})
      ORDER BY maintenance_window_id, monitor_id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<MaintenanceWindowMonitorLinkRow>();
    for (const r of results ?? []) {
      appendMapValue(byWindow, r.maintenance_window_id, r.monitor_id);
    }
  }

  return byWindow;
}

async function listActiveMaintenanceMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const activeMonitorIds = new Set<number>();

  for (const ids of chunkPositiveIntegerIds(monitorIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length, 2);
    const sql = `
      SELECT DISTINCT mwm.monitor_id
      FROM maintenance_window_monitors mwm
      JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
      WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
        AND mwm.monitor_id IN (${placeholders})
    `;

    const { results } = await db
      .prepare(sql)
      .bind(at, ...ids)
      .all<{ monitor_id: number }>();
    for (const row of results ?? []) {
      activeMonitorIds.add(row.monitor_id);
    }
  }

  return activeMonitorIds;
}

export function utcDayStart(timestampSec: number): number {
  return Math.floor(timestampSec / 86400) * 86400;
}

async function readUptimeRatingLevel(db: D1Database): Promise<1 | 2 | 3 | 4 | 5> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?1')
    .bind('uptime_rating_level')
    .first<{ value: string }>();

  const raw = row?.value ?? '';
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 5) {
    return n as 1 | 2 | 3 | 4 | 5;
  }
  return 3;
}

export async function computeTodayPartialUptimeBatch(
  db: D1Database,
  monitors: Array<{
    id: number;
    interval_sec: number;
    created_at: number;
    last_checked_at: number | null;
  }>,
  rangeStart: number,
  now: number,
): Promise<Map<number, UptimeWindowTotals>> {
  try {
    return await computeTodayPartialUptimeBatchSql(db, monitors, rangeStart, now);
  } catch (err) {
    console.warn('uptime: today batch SQL failed, falling back to legacy', err);
    return await computeTodayPartialUptimeBatchLegacy(db, monitors, rangeStart, now);
  }
}

async function computeTodayPartialUptimeBatchSql(
  db: D1Database,
  monitors: Array<{
    id: number;
    interval_sec: number;
    created_at: number;
    last_checked_at: number | null;
  }>,
  rangeStart: number,
  now: number,
): Promise<Map<number, UptimeWindowTotals>> {
  const out = new Map<number, UptimeWindowTotals>();

  const monitorById = new Map<number, (typeof monitors)[number]>();
  for (const monitor of monitors) {
    if (!Number.isInteger(monitor.id) || monitor.id <= 0) continue;
    if (monitorById.has(monitor.id)) continue;
    monitorById.set(monitor.id, monitor);
  }

  const normalizedMonitors = [...monitorById.values()];
  if (normalizedMonitors.length === 0) return out;

  const ids = normalizedMonitors.map((monitor) => monitor.id);

  if (now <= rangeStart) {
    for (const id of ids) {
      out.set(id, {
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: null,
      });
    }
    return out;
  }

  for (const id of ids) {
    out.set(id, {
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
      uptime_pct: null,
    });
  }

  for (
    let start = 0;
    start < normalizedMonitors.length;
    start += TODAY_PARTIAL_UPTIME_SQL_CHUNK_SIZE
  ) {
    const chunk = normalizedMonitors.slice(start, start + TODAY_PARTIAL_UPTIME_SQL_CHUNK_SIZE);
    const valuesPlaceholders = chunk
      .map((_, index) => {
        const base = 3 + index * 4;
        return `(?${base}, ?${base + 1}, ?${base + 2}, ?${base + 3})`;
      })
      .join(', ');

    const stmt = db.prepare(
      `
      WITH input(monitor_id, interval_sec, created_at, last_checked_at) AS (
        VALUES ${valuesPlaceholders}
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
        e.monitor_id AS monitor_id,
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
    );

    const args: unknown[] = [rangeStart, now];
    for (const monitor of chunk) {
      args.push(monitor.id, monitor.interval_sec, monitor.created_at, monitor.last_checked_at);
    }

    const { results } = await stmt.bind(...args).all<{
      monitor_id: number;
      start_at: number;
      total_sec: number;
      downtime_sec: number;
      unknown_sec: number;
    }>();

    const rows = results ?? [];
    const shouldReturnAtLeastOneRow = chunk.some(
      (monitor) => monitor.created_at <= rangeStart || monitor.last_checked_at !== null,
    );
    if (shouldReturnAtLeastOneRow && rows.length === 0) {
      throw new Error('uptime: today batch SQL returned no rows');
    }

    for (const row of rows) {
      if (
        !Number.isInteger(row.monitor_id) ||
        row.monitor_id <= 0 ||
        !Number.isFinite(row.total_sec) ||
        !Number.isFinite(row.downtime_sec) ||
        !Number.isFinite(row.unknown_sec)
      ) {
        throw new Error('uptime: today batch SQL returned an invalid row');
      }

      const monitorId = row.monitor_id;
      if (!monitorById.has(monitorId)) continue;

      const total_sec = Math.max(0, row.total_sec ?? 0);
      if (total_sec === 0) continue;

      const downtime_sec = Math.max(0, row.downtime_sec ?? 0);
      const unknown_sec = Math.max(0, row.unknown_sec ?? 0);
      const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
      const uptime_sec = Math.max(0, total_sec - unavailable_sec);
      const uptime_pct = total_sec === 0 ? null : (uptime_sec / total_sec) * 100;

      out.set(monitorId, {
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
        uptime_pct,
      });
    }
  }

  return out;
}

async function computeTodayPartialUptimeBatchLegacy(
  db: D1Database,
  monitors: Array<{
    id: number;
    interval_sec: number;
    created_at: number;
    last_checked_at: number | null;
  }>,
  rangeStart: number,
  now: number,
): Promise<Map<number, UptimeWindowTotals>> {
  const out = new Map<number, UptimeWindowTotals>();

  const monitorById = new Map<
    number,
    { id: number; interval_sec: number; created_at: number; last_checked_at: number | null }
  >();
  for (const monitor of monitors) {
    if (!Number.isFinite(monitor.id)) continue;
    monitorById.set(monitor.id, {
      id: monitor.id,
      interval_sec: monitor.interval_sec,
      created_at: monitor.created_at,
      last_checked_at: monitor.last_checked_at,
    });
  }
  const ids = [...monitorById.keys()];
  if (ids.length === 0) return out;

  if (now <= rangeStart) {
    for (const id of ids) {
      out.set(id, {
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: null,
      });
    }
    return out;
  }

  const placeholders = ids.map((_, idx) => `?${idx + 3}`).join(', ');
  const { results } = await db
    .prepare(
      `
      SELECT monitor_id, started_at, ended_at
      FROM outages
      WHERE monitor_id IN (${placeholders})
        AND started_at < ?1
        AND (ended_at IS NULL OR ended_at > ?2)
      ORDER BY monitor_id, started_at
    `,
    )
    .bind(now, rangeStart, ...ids)
    .all<{ monitor_id: number; started_at: number; ended_at: number | null }>();

  const downtimeById = new Map<number, Array<{ start: number; end: number }>>();
  for (const r of results ?? []) {
    const start = Math.max(r.started_at, rangeStart);
    const end = Math.min(r.ended_at ?? now, now);
    if (end <= start) continue;
    appendMapValue(downtimeById, r.monitor_id, { start, end });
  }

  let maxIntervalSec = 0;
  for (const monitor of monitors) {
    if (monitor.interval_sec > maxIntervalSec) {
      maxIntervalSec = monitor.interval_sec;
    }
  }
  const checksStart = Math.max(0, rangeStart - Math.max(0, maxIntervalSec) * 2);
  const checkPlaceholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
  const { results: checkRows } = await db
    .prepare(
      `
      SELECT monitor_id, checked_at, status
      FROM check_results
      WHERE monitor_id IN (${checkPlaceholders})
        AND checked_at >= ?${ids.length + 1}
        AND checked_at < ?${ids.length + 2}
      ORDER BY monitor_id, checked_at
    `,
    )
    .bind(...ids, checksStart, now)
    .all<{ monitor_id: number; checked_at: number; status: string }>();

  const checksById = new Map<number, Array<{ checked_at: number; status: string }>>();
  for (const row of checkRows ?? []) {
    appendMapValue(checksById, row.monitor_id, {
      checked_at: row.checked_at,
      status: toCheckStatus(row.status),
    });
  }

  for (const id of ids) {
    const monitor = monitorById.get(id);
    if (!monitor) continue;

    const monitorRangeStart = Math.max(rangeStart, monitor.created_at);
    const checks = checksById.get(id) ?? [];
    const isNewWithinRange = monitor.created_at >= rangeStart;
    const checksSinceMonitorStart = isNewWithinRange
      ? checks.filter((check) => check.checked_at >= monitorRangeStart)
      : checks;
    let effectiveRangeStart: number | null = monitorRangeStart;

    if (isNewWithinRange) {
      const firstCheckAt = checksSinceMonitorStart[0]?.checked_at;
      effectiveRangeStart =
        firstCheckAt ?? (monitor.last_checked_at === null ? null : monitorRangeStart);
    }

    if (effectiveRangeStart === null || now <= effectiveRangeStart) {
      out.set(id, {
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: null,
      });
      continue;
    }

    const total_sec = now - effectiveRangeStart;

    const downtimeIntervals = mergeIntervals(
      (downtimeById.get(id) ?? [])
        .map((it) => ({
          start: Math.max(it.start, effectiveRangeStart),
          end: Math.min(it.end, now),
        }))
        .filter((it) => it.end > it.start),
    );
    const downtime_sec = sumIntervals(downtimeIntervals);

    const checksForUnknown =
      effectiveRangeStart > monitorRangeStart
        ? checksSinceMonitorStart.filter((check) => check.checked_at >= effectiveRangeStart)
        : checksSinceMonitorStart;
    const unknownIntervals = buildUnknownIntervals(
      effectiveRangeStart,
      now,
      monitor.interval_sec,
      checksForUnknown,
    );
    const unknown_sec = Math.max(
      0,
      sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
    );

    const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
    const uptime_sec = Math.max(0, total_sec - unavailable_sec);
    const uptime_pct = total_sec === 0 ? null : (uptime_sec / total_sec) * 100;

    out.set(id, {
      total_sec,
      downtime_sec,
      unknown_sec,
      uptime_sec,
      uptime_pct,
    });
  }

  return out;
}

export function toUptimePct(totalSec: number, uptimeSec: number): number | null {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return null;
  if (!Number.isFinite(uptimeSec)) return null;
  const pct = (uptimeSec / totalSec) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

export async function buildPublicMonitorCards(
  db: D1Database,
  now: number,
  opts: { includeHiddenMonitors?: boolean } = {},
): Promise<{
  monitors: PublicStatusResponse['monitors'];
  summary: PublicStatusResponse['summary'];
  overallStatus: PublicStatusResponse['overall_status'];
  uptimeRatingLevel: 1 | 2 | 3 | 4 | 5;
}> {
  const includeHiddenMonitors = opts.includeHiddenMonitors ?? false;
  const rangeEndFullDays = utcDayStart(now);
  const rangeEnd = now;
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.type,
        m.display_url,
        m.group_name,
        m.group_sort_order,
        m.sort_order,
        m.interval_sec,
        m.created_at,
        s.status AS state_status,
        s.last_checked_at,
        s.last_latency_ms
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      ORDER BY
        m.group_sort_order ASC,
        lower(
          CASE
            WHEN m.group_name IS NULL OR trim(m.group_name) = '' THEN 'Ungrouped'
            ELSE trim(m.group_name)
          END
        ) ASC,
        m.sort_order ASC,
        m.id ASC
    `,
    )
    .all<PublicStatusMonitorRow>();

  const rawMonitors = results ?? [];
  const earliestCreatedAt = rawMonitors.reduce(
    (acc, m) => Math.min(acc, m.created_at),
    Number.POSITIVE_INFINITY,
  );
  const rangeStart = Number.isFinite(earliestCreatedAt)
    ? Math.max(rangeEnd - UPTIME_DAYS * 86400, earliestCreatedAt)
    : rangeEnd - UPTIME_DAYS * 86400;
  const rawIds = rawMonitors.map((m) => m.id);
  const [maintenanceMonitorIds, uptimeRatingLevel] = await Promise.all([
    listActiveMaintenanceMonitorIds(db, now, rawIds),
    readUptimeRatingLevel(db),
  ]);

  const monitorsList: PublicStatusResponse['monitors'] = rawMonitors.map((r) => {
    const isInMaintenance = maintenanceMonitorIds.has(r.id);
    const stateStatus = toMonitorStatus(r.state_status);

    const isStale =
      isInMaintenance || stateStatus === 'paused' || stateStatus === 'maintenance'
        ? false
        : r.last_checked_at === null
          ? true
          : now - r.last_checked_at > r.interval_sec * 2;

    const status = isInMaintenance ? 'maintenance' : isStale ? 'unknown' : stateStatus;

    return {
      id: r.id,
      name: r.name,
      type: r.type === 'tcp' ? 'tcp' : 'http',
      display_url: r.display_url ?? null,
      group_name: r.group_name?.trim() ? r.group_name.trim() : null,
      group_sort_order: r.group_sort_order,
      sort_order: r.sort_order,
      uptime_rating_level: uptimeRatingLevel,
      status,
      is_stale: isStale,
      last_checked_at: r.last_checked_at,
      last_latency_ms: isStale ? null : r.last_latency_ms,
      heartbeats: [],
      uptime_30d: null,
      uptime_days: [],
    };
  });

  const ids = monitorsList.map((m) => m.id);
  if (ids.length > 0) {
    const runtimeSnapshot = await readPublicMonitorRuntimeSnapshot(db, now);
    const runtimeById =
      runtimeSnapshot && snapshotHasMonitorIds(runtimeSnapshot, ids)
        ? toMonitorRuntimeEntryMap(runtimeSnapshot)
        : null;
    const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
    const todayStartAt = utcDayStart(now);
    // Always compute a partial "today" bucket whenever we're inside the current UTC day.
    // This keeps new deployments (where rangeStart may be after today's 00:00) from
    // showing empty uptime strips until the next daily rollup.
    const needsToday = rangeEnd > rangeEndFullDays;

    const rollupsPromise = db
      .prepare(
        `
        SELECT monitor_id, day_start_at, total_sec, downtime_sec, unknown_sec, uptime_sec
        FROM monitor_daily_rollups
        WHERE monitor_id IN (${placeholders})
          AND day_start_at >= ?${ids.length + 1}
          AND day_start_at < ?${ids.length + 2}
        ORDER BY monitor_id, day_start_at
      `,
      )
      .bind(...ids, rangeStart, rangeEndFullDays)
      .all<DailyRollupRow>()
      .then(({ results }) => results ?? []);

    const todayByMonitorIdPromise: Promise<Map<number, UptimeWindowTotals>> = needsToday
      ? runtimeById
        ? Promise.resolve(
            new Map<number, UptimeWindowTotals>(
              rawMonitors.map((monitor) => [
                monitor.id,
                materializeMonitorRuntimeTotals(runtimeById.get(monitor.id)!, rangeEnd),
              ]),
            ),
          )
        : computeTodayPartialUptimeBatch(
            db,
            rawMonitors.map((monitor) => ({
              id: monitor.id,
              interval_sec: monitor.interval_sec,
              created_at: monitor.created_at,
              last_checked_at: monitor.last_checked_at,
            })),
            Math.max(todayStartAt, rangeStart),
            rangeEnd,
          )
      : Promise.resolve(new Map<number, UptimeWindowTotals>());

    const [heartbeatsByMonitorId, rollupRows, todayByMonitorId] = await Promise.all([
      runtimeById
        ? Promise.resolve(
            new Map(
              ids.map((id) => [id, runtimeEntryToHeartbeats(runtimeById.get(id)!)]) as Array<
                [number, PublicStatusResponse['monitors'][number]['heartbeats']]
              >,
            ),
          )
        : listHeartbeatsByMonitorId(db, ids, HEARTBEAT_POINTS),
      rollupsPromise,
      todayByMonitorIdPromise,
    ]);

    for (const m of monitorsList) {
      m.heartbeats = heartbeatsByMonitorId.get(m.id) ?? [];
    }

    const byMonitorId = new Map<number, DailyRollupRow[]>();
    for (const r of rollupRows) {
      appendMapValue(byMonitorId, r.monitor_id, r);
    }

    for (const m of monitorsList) {
      const rows = byMonitorId.get(m.id) ?? [];

      const daily = rows.map((r) => ({
        day_start_at: r.day_start_at,
        total_sec: r.total_sec ?? 0,
        downtime_sec: r.downtime_sec ?? 0,
        unknown_sec: r.unknown_sec ?? 0,
        uptime_sec: r.uptime_sec ?? 0,
        uptime_pct: toUptimePct(r.total_sec ?? 0, r.uptime_sec ?? 0),
      }));

      if (needsToday) {
        const today = todayByMonitorId.get(m.id);
        if (today) {
          daily.push({
            day_start_at: todayStartAt,
            total_sec: today.total_sec,
            downtime_sec: today.downtime_sec,
            unknown_sec: today.unknown_sec,
            uptime_sec: today.uptime_sec,
            uptime_pct: today.uptime_pct,
          });
        }
      }

      let total_sec = 0;
      let downtime_sec = 0;
      let unknown_sec = 0;
      let uptime_sec = 0;

      for (const d of daily) {
        total_sec += d.total_sec;
        downtime_sec += d.downtime_sec;
        unknown_sec += d.unknown_sec;
        uptime_sec += d.uptime_sec;
      }

      m.uptime_days = daily;
      m.uptime_30d =
        total_sec === 0
          ? null
          : {
              range_start_at: rangeStart,
              range_end_at: rangeEnd,
              total_sec,
              downtime_sec,
              unknown_sec,
              uptime_sec,
              uptime_pct: (uptime_sec / total_sec) * 100,
            };
    }
  }

  const summary: PublicStatusResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };
  for (const m of monitorsList) {
    summary[m.status]++;
  }

  const overallStatus: MonitorStatus =
    summary.down > 0
      ? 'down'
      : summary.unknown > 0
        ? 'unknown'
        : summary.maintenance > 0
          ? 'maintenance'
          : summary.up > 0
            ? 'up'
            : summary.paused > 0
              ? 'paused'
              : 'unknown';

  return {
    monitors: monitorsList,
    summary,
    overallStatus,
    uptimeRatingLevel,
  };
}

export async function listVisibleActiveIncidents(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<FilteredIncidentEntry[]> {
  return (await readVisibleActiveIncidentSummary(db, includeHiddenMonitors)).items;
}

export async function readVisibleActiveIncidentSummary(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<VisibleActiveIncidentSummary> {
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);
  const { results } = await db
    .prepare(
      `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status != 'resolved'
        AND ${incidentVisibilitySql}
      ORDER BY started_at DESC, id DESC
      LIMIT ?1
    `,
    )
    .bind(STATUS_ACTIVE_INCIDENT_LIMIT)
    .all<IncidentRow>();

  const rows = results ?? [];
  let bannerRow: IncidentRow | null = null;
  if (rows.length >= STATUS_ACTIVE_INCIDENT_LIMIT) {
    bannerRow = await db
      .prepare(
        `
        SELECT id, title, status, impact, message, started_at, resolved_at
        FROM incidents
        WHERE status != 'resolved'
          AND ${incidentVisibilitySql}
        ORDER BY
          CASE impact
            WHEN 'critical' THEN 3
            WHEN 'major' THEN 2
            WHEN 'minor' THEN 1
            ELSE 0
          END DESC,
          started_at DESC,
          id DESC
        LIMIT 1
      `,
      )
      .first<IncidentRow>();
  }

  const visibleEntriesById = await mapVisibleIncidentEntries(
    db,
    bannerRow && !rows.some((row) => row.id === bannerRow?.id) ? [...rows, bannerRow] : rows,
    includeHiddenMonitors,
  );
  const items = rows
    .map((row) => visibleEntriesById.get(row.id) ?? null)
    .filter((entry): entry is FilteredIncidentEntry => entry !== null)
    .slice(0, STATUS_ACTIVE_INCIDENT_LIMIT);

  return {
    items,
    bannerIncident: bannerRow
      ? (visibleEntriesById.get(bannerRow.id) ?? null)
      : chooseTopIncidentEntry(items),
  };
}

export async function listVisibleMaintenanceWindows(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<{
  active: FilteredMaintenanceWindowEntry[];
  upcoming: FilteredMaintenanceWindowEntry[];
  activeMonitorIds: ReadonlySet<number>;
}> {
  const maintenanceVisibilitySql =
    maintenanceWindowStatusPageVisibilityPredicate(includeHiddenMonitors);

  const [{ results: activeResults }, { results: upcomingResults }] = await Promise.all([
    db
      .prepare(
        `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at <= ?1 AND ends_at > ?1
        AND ${maintenanceVisibilitySql}
      ORDER BY starts_at ASC, id ASC
      LIMIT ?2
    `,
      )
      .bind(now, STATUS_ACTIVE_MAINTENANCE_LIMIT)
      .all<MaintenanceWindowRow>(),
    db
      .prepare(
        `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at > ?1
        AND ${maintenanceVisibilitySql}
      ORDER BY starts_at ASC, id ASC
      LIMIT ?2
    `,
      )
      .bind(now, STATUS_UPCOMING_MAINTENANCE_LIMIT)
      .all<MaintenanceWindowRow>(),
  ]);

  const activeRows = activeResults ?? [];
  const upcomingRows = upcomingResults ?? [];

  const [activeWindowMonitorIdsByWindowId, upcomingWindowMonitorIdsByWindowId] = await Promise.all([
    listMaintenanceWindowMonitorIdsByWindowId(
      db,
      activeRows.map((w) => w.id),
    ),
    listMaintenanceWindowMonitorIdsByWindowId(
      db,
      upcomingRows.map((w) => w.id),
    ),
  ]);

  const statusPageVisibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(
        db,
        [
          ...activeWindowMonitorIdsByWindowId.values(),
          ...upcomingWindowMonitorIdsByWindowId.values(),
        ].flat(),
      );

  const active = activeRows
    .map((row) => {
      const originalMonitorIds = activeWindowMonitorIdsByWindowId.get(row.id) ?? [];
      const visibleMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        statusPageVisibleMonitorIds,
        includeHiddenMonitors,
      );

      if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, visibleMonitorIds)) {
        return null;
      }

      return {
        row,
        monitorIds: visibleMonitorIds,
      };
    })
    .filter((entry): entry is FilteredMaintenanceWindowEntry => entry !== null)
    .slice(0, STATUS_ACTIVE_MAINTENANCE_LIMIT);

  const upcoming = upcomingRows
    .map((row) => {
      const originalMonitorIds = upcomingWindowMonitorIdsByWindowId.get(row.id) ?? [];
      const visibleMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        statusPageVisibleMonitorIds,
        includeHiddenMonitors,
      );

      if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, visibleMonitorIds)) {
        return null;
      }

      return {
        row,
        monitorIds: visibleMonitorIds,
      };
    })
    .filter((entry): entry is FilteredMaintenanceWindowEntry => entry !== null)
    .slice(0, STATUS_UPCOMING_MAINTENANCE_LIMIT);

  const activeMonitorIds = new Set<number>();
  if (activeRows.length >= STATUS_ACTIVE_MAINTENANCE_LIMIT) {
    const { results: activeMonitorResults } = await db
      .prepare(
        `
      SELECT DISTINCT mwm.monitor_id
      FROM maintenance_windows mw
      JOIN maintenance_window_monitors mwm ON mwm.maintenance_window_id = mw.id
      WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
        AND ${maintenanceWindowStatusPageVisibilityPredicate(includeHiddenMonitors, 'mw')}
    `,
      )
      .bind(now)
      .all<{ monitor_id: number }>();

    for (const row of activeMonitorResults ?? []) {
      if (
        typeof row.monitor_id === 'number' &&
        Number.isInteger(row.monitor_id) &&
        row.monitor_id > 0
      ) {
        activeMonitorIds.add(row.monitor_id);
      }
    }
  } else {
    for (const monitorIds of activeWindowMonitorIdsByWindowId.values()) {
      for (const monitorId of monitorIds) {
        if (typeof monitorId === 'number' && Number.isInteger(monitorId) && monitorId > 0) {
          activeMonitorIds.add(monitorId);
        }
      }
    }
  }

  return { active, upcoming, activeMonitorIds };
}

export async function readPublicSiteSettings(db: D1Database, opts?: { bypassCache?: boolean }) {
  return readSettings(db, opts);
}

export function buildPublicStatusBanner(opts: {
  counts: PublicStatusResponse['summary'];
  monitorCount: number;
  activeIncidents: FilteredIncidentEntry[];
  activeMaintenanceWindows: FilteredMaintenanceWindowEntry[];
  bannerIncident?: FilteredIncidentEntry | null;
}): Banner {
  const { counts, monitorCount, activeIncidents, activeMaintenanceWindows, bannerIncident } = opts;
  const topIncident = bannerIncident?.row ?? chooseTopIncidentEntry(activeIncidents)?.row ?? null;
  if (topIncident) {
    const maxImpact = topIncident ? toIncidentImpact(topIncident.impact) : ('none' as const);

    const status: BannerStatus =
      maxImpact === 'critical' || maxImpact === 'major'
        ? 'major_outage'
        : maxImpact === 'minor'
          ? 'partial_outage'
          : 'operational';

    const title =
      status === 'major_outage'
        ? 'Major Outage'
        : status === 'partial_outage'
          ? 'Partial Outage'
          : 'Incident';

    return {
      source: 'incident',
      status,
      title,
      incident: topIncident
        ? {
            id: topIncident.id,
            title: topIncident.title,
            status: toIncidentStatus(topIncident.status),
            impact: toIncidentImpact(topIncident.impact),
          }
        : null,
    };
  }

  const total = monitorCount;
  const downRatio = total === 0 ? 0 : counts.down / total;

  if (counts.down > 0) {
    const status: BannerStatus = downRatio >= 0.3 ? 'major_outage' : 'partial_outage';
    return {
      source: 'monitors',
      status,
      title: status === 'major_outage' ? 'Major Outage' : 'Partial Outage',
      down_ratio: downRatio,
    };
  }

  if (counts.unknown > 0) {
    return { source: 'monitors', status: 'unknown', title: 'Status Unknown' };
  }

  const maint = activeMaintenanceWindows.map((entry) => entry.row);
  const hasMaintenance = maint.length > 0 || counts.maintenance > 0;
  if (hasMaintenance) {
    const top = maint[0];
    return top
      ? {
          source: 'maintenance',
          status: 'maintenance',
          title: 'Maintenance',
          maintenance_window: {
            id: top.id,
            title: top.title,
            starts_at: top.starts_at,
            ends_at: top.ends_at,
          },
        }
      : { source: 'monitors', status: 'maintenance', title: 'Maintenance' };
  }

  return { source: 'monitors', status: 'operational', title: 'All Systems Operational' };
}
