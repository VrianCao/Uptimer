import type { PublicStatusResponse } from '../schemas/public-status';
import { readStatusSnapshotPayloadAnyAge } from '../snapshots/public-status-read';
import type { SettingsResponse } from '../settings';

import {
  fromRuntimeStatusCode,
  materializeMonitorRuntimeTotals,
  normalizeRuntimeUpdateLatencyMs,
  readPublicMonitorRuntimeSnapshot,
  runtimeEntryToHeartbeats,
  snapshotHasMonitorIds,
  toMonitorRuntimeEntryMap,
  type MonitorRuntimeUpdate,
  type PublicMonitorRuntimeEntry,
  type PublicMonitorRuntimeSnapshot,
} from './monitor-runtime';

import { buildPublicStatusBanner, toMonitorStatus, utcDayStart } from './data';
import {
  incidentStatusPageVisibilityPredicate,
  maintenanceWindowStatusPageVisibilityPredicate,
  monitorVisibilityPredicate,
} from './visibility';

const STATUS_FAST_PATCH_BASE_MAX_AGE_SECONDS = 75;
const STATUS_FAST_PATCH_UPDATE_GRACE_SECONDS = 15;
const STATUS_FAST_PATCH_MAX_STALE_SECONDS = 10 * 60;
const UPTIME_DAYS = 60;

type StatusMonitor = PublicStatusResponse['monitors'][number];
type StatusPublicSettings = SettingsResponse['settings'];
type StatusMonitorMetadataStamp = {
  monitorCountTotal: number;
  maxUpdatedAt: number | null;
};
type StatusScheduledFastGuardState = {
  settings: StatusPublicSettings;
  monitorMetadataStamp: StatusMonitorMetadataStamp;
  hasActiveIncidents: boolean;
  hasActiveMaintenance: boolean;
  hasUpcomingMaintenance: boolean;
};
export type PublicStatusScheduledFastGuardState = StatusScheduledFastGuardState;
type StatusStatementCache = Partial<{
  scheduledFastGuard: D1PreparedStatement;
  scheduledFastGuardIncludingHidden: D1PreparedStatement;
}>;

const statusStatementCacheByDb = new WeakMap<D1Database, StatusStatementCache>();

function getStatusStatementCache(db: D1Database): StatusStatementCache {
  const cached = statusStatementCacheByDb.get(db);
  if (cached) {
    return cached;
  }

  const next: StatusStatementCache = {};
  statusStatementCacheByDb.set(db, next);
  return next;
}

function getCachedStatusStatement(
  db: D1Database,
  key: keyof StatusStatementCache,
  create: () => D1PreparedStatement,
): D1PreparedStatement {
  const cache = getStatusStatementCache(db);
  const cached = cache[key];
  if (cached) {
    return cached;
  }

  const statement = create();
  cache[key] = statement;
  return statement;
}

function computeOverallStatus(
  summary: PublicStatusResponse['summary'],
): PublicStatusResponse['overall_status'] {
  return summary.down > 0
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
}

const STATUS_FAST_PUBLIC_LOCALES = new Set<StatusPublicSettings['site_locale']>([
  'auto',
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'es',
]);

function normalizeStatusFastGuardString(
  value: string | null | undefined,
  opts: {
    fallback: string;
    max: number;
    allowEmpty?: boolean;
  },
): string {
  if (typeof value !== 'string') {
    return opts.fallback;
  }
  if (!opts.allowEmpty && value.length === 0) {
    return opts.fallback;
  }
  if (value.length > opts.max) {
    return opts.fallback;
  }
  return value;
}

function normalizeStatusFastGuardSettings(row: {
  site_title_value: string | null | undefined;
  site_description_value: string | null | undefined;
  site_locale_value: string | null | undefined;
  site_timezone_value: string | null | undefined;
  uptime_rating_level_value: string | null | undefined;
}): StatusPublicSettings {
  const parsedUptimeRating = Number.parseInt(row.uptime_rating_level_value ?? '', 10);

  return {
    site_title: normalizeStatusFastGuardString(row.site_title_value, {
      fallback: 'Uptimer',
      max: 100,
    }),
    site_description: normalizeStatusFastGuardString(row.site_description_value, {
      fallback: '',
      max: 500,
      allowEmpty: true,
    }),
    site_locale: STATUS_FAST_PUBLIC_LOCALES.has(
      (row.site_locale_value ?? '') as StatusPublicSettings['site_locale'],
    )
      ? ((row.site_locale_value ?? 'auto') as StatusPublicSettings['site_locale'])
      : 'auto',
    site_timezone: normalizeStatusFastGuardString(row.site_timezone_value, {
      fallback: 'UTC',
      max: 64,
    }),
    retention_check_results_days: 7,
    state_failures_to_down_from_up: 2,
    state_successes_to_up_from_down: 2,
    admin_default_overview_range: '24h',
    admin_default_monitor_range: '24h',
    uptime_rating_level:
      Number.isFinite(parsedUptimeRating) && parsedUptimeRating >= 1 && parsedUptimeRating <= 5
        ? (parsedUptimeRating as 1 | 2 | 3 | 4 | 5)
        : 3,
  };
}

function hasMatchingStatusPublicSettings(
  baseSnapshot: PublicStatusResponse,
  settings: StatusPublicSettings,
): boolean {
  return (
    baseSnapshot.site_title === settings.site_title &&
    baseSnapshot.site_description === settings.site_description &&
    baseSnapshot.site_locale === settings.site_locale &&
    baseSnapshot.site_timezone === settings.site_timezone &&
    baseSnapshot.uptime_rating_level === settings.uptime_rating_level
  );
}

function hasCompatibleBaseStatusSnapshotMonitorMetadataStamp(
  baseSnapshot: PublicStatusResponse | null | undefined,
  metadataStamp: StatusMonitorMetadataStamp | null,
): boolean {
  if (!baseSnapshot || !metadataStamp) {
    return false;
  }

  if (metadataStamp.monitorCountTotal !== baseSnapshot.monitors.length) {
    return false;
  }

  return (metadataStamp.maxUpdatedAt ?? 0) <= baseSnapshot.generated_at;
}

function canPatchStatusFromRuntime(baseSnapshot: PublicStatusResponse): boolean {
  return (
    baseSnapshot.active_incidents.length === 0 &&
    baseSnapshot.maintenance_windows.active.length === 0 &&
    baseSnapshot.maintenance_windows.upcoming.length === 0
  );
}

function toPublicHeartbeatStatus(
  value: string | null | undefined,
): StatusMonitor['heartbeats'][number]['status'] {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
      return value;
    default:
      return 'unknown';
  }
}

function hasReusableRuntimeCreatedAt(
  entry: PublicMonitorRuntimeEntry | undefined,
): entry is PublicMonitorRuntimeEntry & { created_at: number } {
  return typeof entry?.created_at === 'number' && Number.isInteger(entry.created_at);
}

function computeStatusMonitorPresentation(opts: {
  intervalSec: number;
  lastCheckedAt: number | null;
  stateStatus: string | null;
  now: number;
}): Pick<StatusMonitor, 'status' | 'is_stale'> {
  const stateStatus = toMonitorStatus(opts.stateStatus);
  const isStale =
    stateStatus === 'paused' || stateStatus === 'maintenance'
      ? false
      : opts.lastCheckedAt === null
        ? true
        : opts.now - opts.lastCheckedAt > opts.intervalSec * 2;

  return {
    status: isStale ? 'unknown' : stateStatus,
    is_stale: isStale,
  };
}

function computePatchedStatusSegmentTotals(opts: {
  status: StatusMonitor['status'];
  isStale: boolean;
  lastCheckedAt: number | null;
  intervalSec: number;
  segmentStart: number;
  segmentEnd: number;
}): { downtimeSec: number; unknownSec: number } {
  if (opts.segmentEnd <= opts.segmentStart) {
    return { downtimeSec: 0, unknownSec: 0 };
  }

  const totalSec = opts.segmentEnd - opts.segmentStart;
  if (opts.status === 'down') {
    return { downtimeSec: totalSec, unknownSec: 0 };
  }

  if (opts.isStale || opts.status === 'unknown' || opts.lastCheckedAt === null) {
    return { downtimeSec: 0, unknownSec: totalSec };
  }

  const validUntil = opts.lastCheckedAt + Math.max(0, opts.intervalSec) * 2;
  const unknownStart = Math.max(opts.segmentStart, validUntil);
  return {
    downtimeSec: 0,
    unknownSec: opts.segmentEnd > unknownStart ? opts.segmentEnd - unknownStart : 0,
  };
}

function isFastPatchUpdateFresh(now: number, update: MonitorRuntimeUpdate): boolean {
  return now - update.checked_at <= update.interval_sec * 2;
}

function prependCappedArray<T>(value: T, source: readonly T[], maxLength: number): T[] {
  const nextLength = Math.min(Math.max(1, maxLength), source.length + 1);
  const next = new Array<T>(nextLength);
  next[0] = value;
  for (let index = 1; index < nextLength; index += 1) {
    next[index] = source[index - 1] as T;
  }
  return next;
}

function reuseHistoricalStatusUptimeDays(
  baseMonitor: StatusMonitor,
  rangeStart: number,
  todayStartAt: number,
): {
  days: StatusMonitor['uptime_days'];
  totals: {
    totalSec: number;
    downtimeSec: number;
    unknownSec: number;
    uptimeSec: number;
  };
} {
  const days: StatusMonitor['uptime_days'] = [];
  const totals = {
    totalSec: 0,
    downtimeSec: 0,
    unknownSec: 0,
    uptimeSec: 0,
  };

  for (const day of baseMonitor.uptime_days) {
    if (day.day_start_at < rangeStart || day.day_start_at >= todayStartAt) {
      continue;
    }

    days.push({
      day_start_at: day.day_start_at,
      total_sec: day.total_sec,
      downtime_sec: day.downtime_sec,
      unknown_sec: day.unknown_sec,
      uptime_sec: day.uptime_sec,
      uptime_pct: day.uptime_pct,
    });
    totals.totalSec += day.total_sec;
    totals.downtimeSec += day.downtime_sec;
    totals.unknownSec += day.unknown_sec;
    totals.uptimeSec += day.uptime_sec;
  }

  return { days, totals };
}

function buildTodayStatusUptimeDay(
  dayStartAt: number,
  totals: {
    total_sec: number;
    downtime_sec: number;
    unknown_sec: number;
    uptime_sec: number;
    uptime_pct: number | null;
  },
): StatusMonitor['uptime_days'][number] {
  return {
    day_start_at: dayStartAt,
    total_sec: totals.total_sec,
    downtime_sec: totals.downtime_sec,
    unknown_sec: totals.unknown_sec,
    uptime_sec: totals.uptime_sec,
    uptime_pct: totals.uptime_pct,
  };
}

function createStatusUptime30d(
  rangeStart: number,
  rangeEnd: number,
  totals: {
    totalSec: number;
    downtimeSec: number;
    unknownSec: number;
    uptimeSec: number;
  },
): StatusMonitor['uptime_30d'] {
  if (totals.totalSec === 0) {
    return null;
  }

  return {
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    total_sec: totals.totalSec,
    downtime_sec: totals.downtimeSec,
    unknown_sec: totals.unknownSec,
    uptime_sec: totals.uptimeSec,
    uptime_pct: (totals.uptimeSec / totals.totalSec) * 100,
  };
}

export function tryPatchPublicStatusPayloadFromRuntimeUpdates(opts: {
  baseSnapshot: PublicStatusResponse | null;
  now: number;
  updates: MonitorRuntimeUpdate[];
}): PublicStatusResponse | null {
  const { baseSnapshot, now, updates } = opts;
  if (!baseSnapshot || !canPatchStatusFromRuntime(baseSnapshot)) {
    return null;
  }
  if (updates.length === 0 || updates.length !== baseSnapshot.monitors.length) {
    return null;
  }

  const updateById = new Map<number, MonitorRuntimeUpdate>();
  for (const update of updates) {
    if (!Number.isInteger(update.monitor_id) || update.monitor_id <= 0) {
      return null;
    }
    if (!Number.isInteger(update.checked_at) || update.checked_at < update.created_at) {
      return null;
    }
    if (update.checked_at > now || updateById.has(update.monitor_id)) {
      return null;
    }
    if (!isFastPatchUpdateFresh(now, update)) {
      return null;
    }
    updateById.set(update.monitor_id, update);
  }

  if (updateById.size !== baseSnapshot.monitors.length) {
    return null;
  }

  const todayStartAt = utcDayStart(now);
  const summary: PublicStatusResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };
  const patchedMonitors: StatusMonitor[] = [];

  for (const baseMonitor of baseSnapshot.monitors) {
    const update = updateById.get(baseMonitor.id);
    if (!update) {
      return null;
    }
    if (baseMonitor.last_checked_at !== null && update.checked_at <= baseMonitor.last_checked_at) {
      return null;
    }
    if (
      baseMonitor.last_checked_at !== null &&
      update.checked_at - baseMonitor.last_checked_at >
        Math.max(
          STATUS_FAST_PATCH_BASE_MAX_AGE_SECONDS,
          update.interval_sec + STATUS_FAST_PATCH_UPDATE_GRACE_SECONDS,
        )
    ) {
      return null;
    }

    const rangeStart = Math.max(now - UPTIME_DAYS * 86_400, update.created_at);
    const { days, totals } = reuseHistoricalStatusUptimeDays(baseMonitor, rangeStart, todayStartAt);
    const existingToday = baseMonitor.uptime_days.find((day) => day.day_start_at === todayStartAt);
    const currentDowntime = Math.max(0, existingToday?.downtime_sec ?? 0);
    const currentUnknown = Math.max(0, existingToday?.unknown_sec ?? 0);
    const segmentStart = Math.max(todayStartAt, baseSnapshot.generated_at, update.created_at);
    const segmentEnd = Math.max(segmentStart, Math.min(update.checked_at, now));
    const segment = computePatchedStatusSegmentTotals({
      status: baseMonitor.status,
      isStale: baseMonitor.is_stale,
      lastCheckedAt: baseMonitor.last_checked_at,
      intervalSec: update.interval_sec,
      segmentStart,
      segmentEnd,
    });
    const nextPresentation = computeStatusMonitorPresentation({
      intervalSec: update.interval_sec,
      lastCheckedAt: update.checked_at,
      stateStatus: update.next_status,
      now,
    });
    const tail = computePatchedStatusSegmentTotals({
      status: nextPresentation.status,
      isStale: nextPresentation.is_stale,
      lastCheckedAt: update.checked_at,
      intervalSec: update.interval_sec,
      segmentStart: Math.max(segmentEnd, update.checked_at),
      segmentEnd: now,
    });

    const totalSec = Math.max(0, now - Math.max(todayStartAt, update.created_at));
    const nextDowntimeSec = currentDowntime + segment.downtimeSec + tail.downtimeSec;
    const nextUnknownSec = currentUnknown + segment.unknownSec + tail.unknownSec;
    const nextUptimeSec = Math.max(0, totalSec - nextDowntimeSec - nextUnknownSec);
    const today = buildTodayStatusUptimeDay(todayStartAt, {
      total_sec: totalSec,
      downtime_sec: nextDowntimeSec,
      unknown_sec: nextUnknownSec,
      uptime_sec: nextUptimeSec,
      uptime_pct: totalSec === 0 ? null : (nextUptimeSec / totalSec) * 100,
    });
    days.push(today);

    totals.totalSec += today.total_sec;
    totals.downtimeSec += today.downtime_sec;
    totals.unknownSec += today.unknown_sec;
    totals.uptimeSec += today.uptime_sec;

    const nextMonitor: StatusMonitor = {
      ...baseMonitor,
      status: nextPresentation.status,
      is_stale: nextPresentation.is_stale,
      last_checked_at: update.checked_at,
      last_latency_ms: normalizeRuntimeUpdateLatencyMs(update.latency_ms),
      heartbeats: prependCappedArray(
        {
          checked_at: update.checked_at,
          status: toPublicHeartbeatStatus(update.check_status),
          latency_ms: normalizeRuntimeUpdateLatencyMs(update.latency_ms),
        },
        baseMonitor.heartbeats,
        60,
      ),
      uptime_days: days,
      uptime_30d: createStatusUptime30d(rangeStart, now, totals),
    };

    summary[nextMonitor.status] += 1;
    patchedMonitors.push(nextMonitor);
  }

  return {
    ...baseSnapshot,
    generated_at: now,
    overall_status: computeOverallStatus(summary),
    banner: buildPublicStatusBanner({
      counts: summary,
      monitorCount: patchedMonitors.length,
      activeIncidents: [],
      activeMaintenanceWindows: [],
    }),
    summary,
    monitors: patchedMonitors,
  };
}

function tryPatchPublicStatusPayloadFromRuntimeSnapshot(opts: {
  baseSnapshot: PublicStatusResponse | null;
  runtimeSnapshot: PublicMonitorRuntimeSnapshot | null;
  now: number;
}): PublicStatusResponse | null {
  const { baseSnapshot, runtimeSnapshot, now } = opts;
  if (!baseSnapshot || !runtimeSnapshot || !canPatchStatusFromRuntime(baseSnapshot)) {
    return null;
  }

  const todayStartAt = utcDayStart(now);
  if (runtimeSnapshot.generated_at > now || runtimeSnapshot.day_start_at !== todayStartAt) {
    return null;
  }
  if (runtimeSnapshot.generated_at < baseSnapshot.generated_at) {
    return null;
  }

  const monitorIds = baseSnapshot.monitors.map((monitor) => monitor.id);
  if (!snapshotHasMonitorIds(runtimeSnapshot, monitorIds)) {
    return null;
  }

  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);
  const summary: PublicStatusResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };
  const patchedMonitors: StatusMonitor[] = [];

  for (const baseMonitor of baseSnapshot.monitors) {
    const runtimeEntry = runtimeById.get(baseMonitor.id);
    if (!hasReusableRuntimeCreatedAt(runtimeEntry)) {
      return null;
    }
    if (
      baseMonitor.last_checked_at !== null &&
      (runtimeEntry.last_checked_at === null ||
        runtimeEntry.last_checked_at < baseMonitor.last_checked_at)
    ) {
      return null;
    }

    const rangeStart = Math.max(now - UPTIME_DAYS * 86_400, runtimeEntry.created_at);
    const { days, totals } = reuseHistoricalStatusUptimeDays(baseMonitor, rangeStart, todayStartAt);
    const todayTotals = materializeMonitorRuntimeTotals(runtimeEntry, now);
    const today = buildTodayStatusUptimeDay(todayStartAt, todayTotals);
    days.push(today);

    totals.totalSec += today.total_sec;
    totals.downtimeSec += today.downtime_sec;
    totals.unknownSec += today.unknown_sec;
    totals.uptimeSec += today.uptime_sec;

    const heartbeats =
      baseMonitor.last_checked_at === runtimeEntry.last_checked_at
        ? baseMonitor.heartbeats
        : runtimeEntryToHeartbeats(runtimeEntry).map((heartbeat) => ({
            checked_at: heartbeat.checked_at,
            status: toPublicHeartbeatStatus(heartbeat.status),
            latency_ms: heartbeat.latency_ms,
          }));
    const presentation = computeStatusMonitorPresentation({
      intervalSec: runtimeEntry.interval_sec,
      lastCheckedAt: runtimeEntry.last_checked_at,
      stateStatus: fromRuntimeStatusCode(runtimeEntry.last_status_code),
      now,
    });
    const nextMonitor: StatusMonitor = {
      ...baseMonitor,
      status: presentation.status,
      is_stale: presentation.is_stale,
      last_checked_at: runtimeEntry.last_checked_at,
      last_latency_ms: heartbeats[0]?.latency_ms ?? null,
      heartbeats,
      uptime_days: days,
      uptime_30d: createStatusUptime30d(rangeStart, now, totals),
    };

    summary[nextMonitor.status] += 1;
    patchedMonitors.push(nextMonitor);
  }

  return {
    ...baseSnapshot,
    generated_at: now,
    overall_status: computeOverallStatus(summary),
    banner: buildPublicStatusBanner({
      counts: summary,
      monitorCount: patchedMonitors.length,
      activeIncidents: [],
      activeMaintenanceWindows: [],
    }),
    summary,
    monitors: patchedMonitors,
  };
}

async function readStatusScheduledFastGuardState(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<StatusScheduledFastGuardState> {
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);
  const maintenanceVisibilitySql =
    maintenanceWindowStatusPageVisibilityPredicate(includeHiddenMonitors);
  const row = await getCachedStatusStatement(
    db,
    includeHiddenMonitors ? 'scheduledFastGuardIncludingHidden' : 'scheduledFastGuard',
    () =>
      db.prepare(
        `
          SELECT
            (
              SELECT value
              FROM settings
              WHERE key = 'site_title'
            ) AS site_title_value,
            (
              SELECT value
              FROM settings
              WHERE key = 'site_description'
            ) AS site_description_value,
            (
              SELECT value
              FROM settings
              WHERE key = 'site_locale'
            ) AS site_locale_value,
            (
              SELECT value
              FROM settings
              WHERE key = 'site_timezone'
            ) AS site_timezone_value,
            (
              SELECT value
              FROM settings
              WHERE key = 'uptime_rating_level'
            ) AS uptime_rating_level_value,
            (
              SELECT COUNT(*)
              FROM monitors m
              WHERE m.is_active = 1
                AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
            ) AS monitor_count_total,
            (
              SELECT MAX(COALESCE(m.updated_at, m.created_at, 0))
              FROM monitors m
              WHERE m.is_active = 1
                AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
            ) AS max_updated_at,
            EXISTS(
              SELECT 1
              FROM incidents
              WHERE status != 'resolved'
                AND ${incidentVisibilitySql}
              LIMIT 1
            ) AS has_active_incidents,
            EXISTS(
              SELECT 1
              FROM maintenance_windows
              WHERE starts_at <= ?1 AND ends_at > ?1
                AND ${maintenanceVisibilitySql}
              LIMIT 1
            ) AS has_active_maintenance,
            EXISTS(
              SELECT 1
              FROM maintenance_windows
              WHERE starts_at > ?1
                AND ${maintenanceVisibilitySql}
              LIMIT 1
            ) AS has_upcoming_maintenance
        `,
      ),
  )
    .bind(now)
    .first<{
      site_title_value: string | null;
      site_description_value: string | null;
      site_locale_value: string | null;
      site_timezone_value: string | null;
      uptime_rating_level_value: string | null;
      monitor_count_total: number | null;
      max_updated_at: number | null;
      has_active_incidents: number | null;
      has_active_maintenance: number | null;
      has_upcoming_maintenance: number | null;
    }>();

  return {
    settings: normalizeStatusFastGuardSettings({
      site_title_value: row?.site_title_value,
      site_description_value: row?.site_description_value,
      site_locale_value: row?.site_locale_value,
      site_timezone_value: row?.site_timezone_value,
      uptime_rating_level_value: row?.uptime_rating_level_value,
    }),
    monitorMetadataStamp: {
      monitorCountTotal: row?.monitor_count_total ?? 0,
      maxUpdatedAt: row?.max_updated_at ?? null,
    },
    hasActiveIncidents: (row?.has_active_incidents ?? 0) > 0,
    hasActiveMaintenance: (row?.has_active_maintenance ?? 0) > 0,
    hasUpcomingMaintenance: (row?.has_upcoming_maintenance ?? 0) > 0,
  };
}

export async function tryComputePublicStatusPayloadFromScheduledRuntimeUpdates(opts: {
  db: D1Database;
  now: number;
  updates: MonitorRuntimeUpdate[];
  guardState?: StatusScheduledFastGuardState | null;
  baseSnapshot?: PublicStatusResponse | null;
}): Promise<PublicStatusResponse | null> {
  const baseSnapshot = opts.baseSnapshot
    ? { data: opts.baseSnapshot }
    : await readStatusSnapshotPayloadAnyAge(opts.db, opts.now, STATUS_FAST_PATCH_MAX_STALE_SECONDS);
  if (!baseSnapshot || !canPatchStatusFromRuntime(baseSnapshot.data)) {
    return null;
  }

  const includeHiddenMonitors = false;
  const guardState =
    opts.guardState ??
    (await readStatusScheduledFastGuardState(opts.db, opts.now, includeHiddenMonitors));
  if (!hasMatchingStatusPublicSettings(baseSnapshot.data, guardState.settings)) {
    return null;
  }
  if (
    guardState.hasActiveIncidents ||
    guardState.hasActiveMaintenance ||
    guardState.hasUpcomingMaintenance
  ) {
    return null;
  }
  if (
    !hasCompatibleBaseStatusSnapshotMonitorMetadataStamp(
      baseSnapshot.data,
      guardState.monitorMetadataStamp,
    )
  ) {
    return null;
  }

  const directPatched = tryPatchPublicStatusPayloadFromRuntimeUpdates({
    baseSnapshot: baseSnapshot.data,
    now: opts.now,
    updates: opts.updates,
  });
  if (directPatched) {
    return directPatched;
  }

  const runtimeSnapshot = await readPublicMonitorRuntimeSnapshot(opts.db, opts.now);
  return tryPatchPublicStatusPayloadFromRuntimeSnapshot({
    baseSnapshot: baseSnapshot.data,
    runtimeSnapshot,
    now: opts.now,
  });
}
