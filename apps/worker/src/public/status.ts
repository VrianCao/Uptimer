import type { PublicStatusResponse } from '../schemas/public-status';

import {
  buildUnknownIntervals,
  mergeIntervals,
  overlapSeconds,
  sumIntervals,
} from '../analytics/uptime';
import { readSettings } from '../settings';

type PublicStatusMonitorRow = {
  id: number;
  name: string;
  type: string;
  group_name: string | null;
  group_sort_order: number;
  sort_order: number;
  interval_sec: number;
  created_at: number;
  state_status: string | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
};

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

type UptimeWindowTotals = {
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number | null;
};

type BannerStatus = PublicStatusResponse['banner']['status'];

type Banner = PublicStatusResponse['banner'];

type MonitorStatus = PublicStatusResponse['overall_status'];

type CheckStatus = PublicStatusResponse['monitors'][number]['heartbeats'][number]['status'];

const STATUS_ACTIVE_INCIDENT_LIMIT = 5;
const STATUS_ACTIVE_MAINTENANCE_LIMIT = 3;
const STATUS_UPCOMING_MAINTENANCE_LIMIT = 5;

const UPTIME_DAYS = 30;

const HEARTBEAT_POINTS = 60;

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function toMonitorStatus(value: string | null): MonitorStatus {
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

function toIncidentStatus(
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

function toIncidentImpact(
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
  } satisfies PublicStatusResponse['active_incidents'][number];
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
  } satisfies PublicStatusResponse['maintenance_windows']['active'][number];
}

async function listHeartbeatsByMonitorId(
  db: D1Database,
  monitorIds: number[],
  limitPerMonitor: number,
): Promise<Map<number, PublicStatusResponse['monitors'][number]['heartbeats']>> {
  const byMonitor = new Map<number, PublicStatusResponse['monitors'][number]['heartbeats']>();

  const ids = [...new Set(monitorIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return byMonitor;

  // Use a window function to cap each monitor partition to N rows.
  // NOTE: check_results has an index (monitor_id, checked_at) to keep this efficient.
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

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();
  if (incidentIds.length === 0) return byIncident;

  const placeholders = incidentIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT id, incident_id, status, message, created_at
    FROM incident_updates
    WHERE incident_id IN (${placeholders})
    ORDER BY incident_id, created_at, id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(...incidentIds)
    .all<IncidentUpdateRow>();
  for (const r of results ?? []) {
    appendMapValue(byIncident, r.incident_id, r);
  }

  return byIncident;
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();
  if (incidentIds.length === 0) return byIncident;

  const placeholders = incidentIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT incident_id, monitor_id
    FROM incident_monitors
    WHERE incident_id IN (${placeholders})
    ORDER BY incident_id, monitor_id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(...incidentIds)
    .all<IncidentMonitorLinkRow>();
  for (const r of results ?? []) {
    appendMapValue(byIncident, r.incident_id, r.monitor_id);
  }

  return byIncident;
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();
  if (windowIds.length === 0) return byWindow;

  const placeholders = windowIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT maintenance_window_id, monitor_id
    FROM maintenance_window_monitors
    WHERE maintenance_window_id IN (${placeholders})
    ORDER BY maintenance_window_id, monitor_id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(...windowIds)
    .all<MaintenanceWindowMonitorLinkRow>();
  for (const r of results ?? []) {
    appendMapValue(byWindow, r.maintenance_window_id, r.monitor_id);
  }

  return byWindow;
}

async function listActiveMaintenanceMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(monitorIds)];
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(', ');
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
  return new Set((results ?? []).map((r) => r.monitor_id));
}

function utcDayStart(timestampSec: number): number {
  return Math.floor(timestampSec / 86400) * 86400;
}

async function readUptimeRatingLevel(db: D1Database): Promise<1 | 2 | 3 | 4 | 5> {
  // Stored in D1 settings table. Keep it simple: a single integer (1-5).
  // Default to Level 3 (Production/SaaS) if not set/invalid.
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

async function computeTodayPartialUptimeBatch(
  db: D1Database,
  monitors: Array<{ id: number; interval_sec: number; created_at: number }>,
  rangeStart: number,
  now: number,
): Promise<Map<number, UptimeWindowTotals>> {
  const out = new Map<number, UptimeWindowTotals>();

  const monitorById = new Map<number, { id: number; interval_sec: number; created_at: number }>();
  for (const monitor of monitors) {
    if (!Number.isFinite(monitor.id)) continue;
    monitorById.set(monitor.id, {
      id: monitor.id,
      interval_sec: monitor.interval_sec,
      created_at: monitor.created_at,
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
    if (now <= monitorRangeStart) {
      out.set(id, {
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: null,
      });
      continue;
    }

    const total_sec = now - monitorRangeStart;

    const downtimeIntervals = mergeIntervals(
      (downtimeById.get(id) ?? [])
        .map((it) => ({
          start: Math.max(it.start, monitorRangeStart),
          end: Math.min(it.end, now),
        }))
        .filter((it) => it.end > it.start),
    );
    const downtime_sec = sumIntervals(downtimeIntervals);

    const checks = checksById.get(id) ?? [];
    const checksForUnknown =
      monitorRangeStart > rangeStart
        ? checks.filter((check) => check.checked_at >= monitorRangeStart)
        : checks;
    const unknownIntervals = buildUnknownIntervals(
      monitorRangeStart,
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

function toUptimePct(totalSec: number, uptimeSec: number): number | null {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return null;
  if (!Number.isFinite(uptimeSec)) return null;
  const pct = (uptimeSec / totalSec) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

export async function computePublicStatusPayload(
  db: D1Database,
  now: number,
): Promise<PublicStatusResponse> {
  // 30d bars should reflect today's (partial) uptime too; daily rollups only cover full UTC days.
  const rangeEndFullDays = utcDayStart(now);
  const rangeEnd = now;
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.type,
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
  // Clamp the 30-day window to the earliest monitor creation time so we don't emit
  // misleading 0%-uptime stats for periods before any monitor existed.
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

    // Paused/maintenance are operator-enforced; they should not degrade to "stale/unknown"
    // just because the scheduler isn't (or shouldn't be) running checks.
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
    const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
    const todayStartAt = utcDayStart(now);
    const needsToday = rangeEnd > rangeEndFullDays && todayStartAt >= rangeStart;

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
      ? computeTodayPartialUptimeBatch(
          db,
          rawMonitors.map((monitor) => ({
            id: monitor.id,
            interval_sec: monitor.interval_sec,
            created_at: monitor.created_at,
          })),
          Math.max(todayStartAt, rangeStart),
          rangeEnd,
        )
      : Promise.resolve(new Map<number, UptimeWindowTotals>());

    const [heartbeatsByMonitorId, rollupRows, todayByMonitorId] = await Promise.all([
      listHeartbeatsByMonitorId(db, ids, HEARTBEAT_POINTS),
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

      // Add a synthetic point for the current UTC day so ongoing outages are reflected.
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

  const counts: PublicStatusResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };
  for (const m of monitorsList) {
    counts[m.status]++;
  }

  const overall_status: MonitorStatus =
    counts.down > 0
      ? 'down'
      : counts.unknown > 0
        ? 'unknown'
        : counts.maintenance > 0
          ? 'maintenance'
          : counts.up > 0
            ? 'up'
            : counts.paused > 0
              ? 'paused'
              : 'unknown';

  const [
    { results: activeIncidents },
    { results: activeMaintenanceWindows },
    { results: upcomingMaintenanceWindows },
    settings,
  ] = await Promise.all([
    db
      .prepare(
        `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status != 'resolved'
      ORDER BY started_at DESC, id DESC
      LIMIT ?1
    `,
      )
      .bind(STATUS_ACTIVE_INCIDENT_LIMIT)
      .all<IncidentRow>(),
    db
      .prepare(
        `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at <= ?1 AND ends_at > ?1
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
      ORDER BY starts_at ASC, id ASC
      LIMIT ?2
    `,
      )
      .bind(now, STATUS_UPCOMING_MAINTENANCE_LIMIT)
      .all<MaintenanceWindowRow>(),
    readSettings(db),
  ]);

  const activeIncidentRows = activeIncidents ?? [];
  const activeWindowRows = activeMaintenanceWindows ?? [];
  const upcomingWindowRows = upcomingMaintenanceWindows ?? [];

  const [
    incidentMonitorIdsByIncidentId,
    incidentUpdatesByIncidentId,
    activeWindowMonitorIdsByWindowId,
    upcomingWindowMonitorIdsByWindowId,
  ] = await Promise.all([
    listIncidentMonitorIdsByIncidentId(
      db,
      activeIncidentRows.map((r) => r.id),
    ),
    listIncidentUpdatesByIncidentId(
      db,
      activeIncidentRows.map((r) => r.id),
    ),
    listMaintenanceWindowMonitorIdsByWindowId(
      db,
      activeWindowRows.map((w) => w.id),
    ),
    listMaintenanceWindowMonitorIdsByWindowId(
      db,
      upcomingWindowRows.map((w) => w.id),
    ),
  ]);

  const banner: Banner = (() => {
    const incidents = activeIncidentRows;
    if (incidents.length > 0) {
      const impactRank = (impact: PublicStatusResponse['active_incidents'][number]['impact']) => {
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
      };

      const maxImpact = incidents
        .map((it) => toIncidentImpact(it.impact))
        .reduce((acc, it) => (impactRank(it) > impactRank(acc) ? it : acc), 'none' as const);

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

      const top = incidents[0];
      return {
        source: 'incident',
        status,
        title,
        incident: top
          ? {
              id: top.id,
              title: top.title,
              status: toIncidentStatus(top.status),
              impact: toIncidentImpact(top.impact),
            }
          : null,
      };
    }

    const total = monitorsList.length;
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

    const maint = activeWindowRows;
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
  })();

  return {
    generated_at: now,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    // Uptime color thresholds are configurable (1-5). Default: Level 3 (Production/SaaS).
    uptime_rating_level: uptimeRatingLevel,
    overall_status,
    banner,
    summary: counts,
    monitors: monitorsList,
    active_incidents: activeIncidentRows.map((r) =>
      incidentRowToApi(
        r,
        incidentUpdatesByIncidentId.get(r.id) ?? [],
        incidentMonitorIdsByIncidentId.get(r.id) ?? [],
      ),
    ),
    maintenance_windows: {
      active: activeWindowRows.map((w) =>
        maintenanceWindowRowToApi(w, activeWindowMonitorIdsByWindowId.get(w.id) ?? []),
      ),
      upcoming: upcomingWindowRows.map((w) =>
        maintenanceWindowRowToApi(w, upcomingWindowMonitorIdsByWindowId.get(w.id) ?? []),
      ),
    },
  };
}
