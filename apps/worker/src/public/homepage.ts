import { z } from 'zod';

import {
  publicHomepageResponseSchema,
  type PublicHomepageResponse,
} from '../schemas/public-homepage';
import type { PublicStatusResponse } from '../schemas/public-status';
import type { Trace } from '../observability/trace';
import {
  computeHomepageGuardValidUntil,
  readHomepageGuardCacheState,
  writeHomepageGuardCacheState,
} from './homepage-guard-state';
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

import {
  buildPublicStatusBanner,
  computeTodayPartialUptimeBatch,
  listIncidentMonitorIdsByIncidentId,
  listMaintenanceWindowMonitorIdsByWindowId,
  readVisibleActiveIncidentSummary,
  listVisibleMaintenanceWindows,
  readPublicSiteSettings,
  toIncidentImpact,
  toIncidentStatus,
  toMonitorStatus,
  utcDayStart,
  type IncidentRow,
  type MaintenanceWindowRow,
  type UptimeWindowTotals,
} from './data';
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

const PREVIEW_BATCH_LIMIT = 50;
const UPTIME_DAYS = 60;
const HEARTBEAT_POINTS = 60;
const HOMEPAGE_FAST_PATCH_BASE_MAX_AGE_SECONDS = 75;
const HOMEPAGE_FAST_PATCH_UPDATE_GRACE_SECONDS = 15;

type IncidentSummary = PublicHomepageResponse['active_incidents'][number];
type MaintenancePreview = NonNullable<PublicHomepageResponse['maintenance_history_preview']>;
type HomepageMonitorCard = PublicHomepageResponse['monitors'][number];
type HomepageMonitorStatus = HomepageMonitorCard['status'];
type HomepagePublicSettings = Awaited<ReturnType<typeof readPublicSiteSettings>>;
const HOMEPAGE_FAST_PUBLIC_LOCALES = new Set<HomepagePublicSettings['site_locale']>([
  'auto',
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'es',
]);
const nonNegativeIntegerArraySchema = z.array(z.number().int().nonnegative());
const nullableNonNegativeIntegerArraySchema = z.array(z.number().int().nonnegative().nullable());

type HomepageMonitorRow = {
  id: number;
  name: string;
  type: string;
  display_url: string | null;
  group_name: string | null;
  interval_sec: number;
  created_at: number;
  state_status: string | null;
  last_checked_at: number | null;
};

type HomepageHeartbeatRow = {
  checked_at: number;
  latency_ms: number | null;
  status: string | null;
};

type HomepageUptimeDayStripAggRawRow = [
  monitor_id: number,
  day_start_at_json: string | null,
  downtime_sec_json: string | null,
  unknown_sec_json: string | null,
  uptime_pct_milli_json: string | null,
  total_sec_sum: number | null,
  uptime_sec_sum: number | null,
];

type HomepageMonitorMetadataStamp = {
  monitorCountTotal: number;
  maxUpdatedAt: number | null;
};
type HomepageScheduledFastGuardState = {
  settings: HomepagePublicSettings;
  monitorMetadataStamp: HomepageMonitorMetadataStamp;
  hasActiveIncidents: boolean;
  hasActiveMaintenance: boolean;
  hasUpcomingMaintenance: boolean;
};

type HomepageMonitorDataOptions = {
  cardLimit?: number;
  uptimeRatingLevel?: 1 | 2 | 3 | 4 | 5;
  maintenanceMonitorIdsPromise?: Promise<ReadonlySet<number>>;
  baseSnapshot?: PublicHomepageResponse | null;
  runtimeSnapshot?: PublicMonitorRuntimeSnapshot | null;
  monitorMetadataStamp?: HomepageMonitorMetadataStamp | null;
  trustBaseSnapshotMonitorMetadata?: boolean;
  trace?: Trace;
};

type HomepageStatementCache = Partial<{
  listMonitorRows: D1PreparedStatement;
  listMonitorRowsLimited: D1PreparedStatement;
  listMonitorRowsIncludingHidden: D1PreparedStatement;
  listMonitorRowsIncludingHiddenLimited: D1PreparedStatement;
  monitorMetadataStamp: D1PreparedStatement;
  monitorMetadataStampIncludingHidden: D1PreparedStatement;
  scheduledFastGuard: D1PreparedStatement;
  scheduledFastGuardIncludingHidden: D1PreparedStatement;
}>;

const homepageStatementCacheByDb = new WeakMap<D1Database, HomepageStatementCache>();
const homepageSnapshotMonitorIdsCache = new WeakMap<PublicHomepageResponse, number[]>();
const homepageSnapshotMonitorByIdCache = new WeakMap<
  PublicHomepageResponse,
  ReadonlyMap<number, HomepageMonitorCard>
>();

function getHomepageStatementCache(db: D1Database): HomepageStatementCache {
  const cached = homepageStatementCacheByDb.get(db);
  if (cached) {
    return cached;
  }

  const next: HomepageStatementCache = {};
  homepageStatementCacheByDb.set(db, next);
  return next;
}

function getCachedHomepageStatement(
  db: D1Database,
  key: keyof HomepageStatementCache,
  create: () => D1PreparedStatement,
): D1PreparedStatement {
  const cache = getHomepageStatementCache(db);
  const cached = cache[key];
  if (cached) {
    return cached;
  }

  const statement = create();
  cache[key] = statement;
  return statement;
}

function withTraceSync<T>(trace: Trace | undefined, name: string, fn: () => T): T {
  return trace ? trace.time(name, fn) : fn();
}

async function withTraceAsync<T>(
  trace: Trace | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return trace ? trace.timeAsync(name, fn) : await fn();
}

function safeParseJsonArray<T>(text: string | null, schema: z.ZodType<T[]>): T[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : [];
  } catch {
    return [];
  }
}

function getHomepageSnapshotMonitorIds(snapshot: PublicHomepageResponse): number[] {
  const cached = homepageSnapshotMonitorIdsCache.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = snapshot.monitors.map((monitor) => monitor.id);
  homepageSnapshotMonitorIdsCache.set(snapshot, next);
  return next;
}

function getHomepageSnapshotMonitorById(
  snapshot: PublicHomepageResponse,
): ReadonlyMap<number, HomepageMonitorCard> {
  const cached = homepageSnapshotMonitorByIdCache.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Map<number, HomepageMonitorCard>();
  for (const monitor of snapshot.monitors) {
    next.set(monitor.id, monitor);
  }
  homepageSnapshotMonitorByIdCache.set(snapshot, next);
  return next;
}

export function parseHomepageSnapshotBodyJson(
  bodyJson: string | null | undefined,
): PublicHomepageResponse | null {
  if (!bodyJson) return null;
  try {
    const parsed = JSON.parse(bodyJson) as unknown;
    const validated = publicHomepageResponseSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function canPatchHomepageFromRuntime(snapshot: PublicHomepageResponse): boolean {
  return (
    snapshot.active_incidents.length === 0 &&
    snapshot.maintenance_windows.active.length === 0 &&
    snapshot.maintenance_windows.upcoming.length === 0
  );
}

function hasMatchingHomepagePublicSettings(
  snapshot: PublicHomepageResponse,
  settings: HomepagePublicSettings,
): boolean {
  return (
    snapshot.site_title === settings.site_title &&
    snapshot.site_description === settings.site_description &&
    snapshot.site_locale === settings.site_locale &&
    snapshot.site_timezone === settings.site_timezone &&
    snapshot.uptime_rating_level === settings.uptime_rating_level
  );
}

function normalizeHomepageFastGuardString(
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

function normalizeHomepageFastGuardSettings(row: {
  site_title_value: string | null | undefined;
  site_description_value: string | null | undefined;
  site_locale_value: string | null | undefined;
  site_timezone_value: string | null | undefined;
  uptime_rating_level_value: string | null | undefined;
}): HomepagePublicSettings {
  const parsedUptimeRating = Number.parseInt(row.uptime_rating_level_value ?? '', 10);

  return {
    site_title: normalizeHomepageFastGuardString(row.site_title_value, {
      fallback: 'Uptimer',
      max: 100,
    }),
    site_description: normalizeHomepageFastGuardString(row.site_description_value, {
      fallback: '',
      max: 500,
      allowEmpty: true,
    }),
    site_locale: HOMEPAGE_FAST_PUBLIC_LOCALES.has(
      (row.site_locale_value ?? '') as HomepagePublicSettings['site_locale'],
    )
      ? ((row.site_locale_value ?? 'auto') as HomepagePublicSettings['site_locale'])
      : 'auto',
    site_timezone: normalizeHomepageFastGuardString(row.site_timezone_value, {
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

function hasCompatibleBaseSnapshotMonitorMetadataStamp(
  baseSnapshot: PublicHomepageResponse | null | undefined,
  metadataStamp: HomepageMonitorMetadataStamp | null,
): boolean {
  if (!baseSnapshot || !metadataStamp) {
    return false;
  }

  if (
    metadataStamp.monitorCountTotal !== baseSnapshot.monitor_count_total ||
    baseSnapshot.monitors.length !== metadataStamp.monitorCountTotal
  ) {
    return false;
  }

  return (metadataStamp.maxUpdatedAt ?? 0) <= baseSnapshot.generated_at;
}

function toHeartbeatStatusCode(status: string | null | undefined): string {
  switch (status) {
    case 'up':
      return 'u';
    case 'down':
      return 'd';
    case 'maintenance':
      return 'm';
    case 'unknown':
    default:
      return 'x';
  }
}

function toIncidentSummary(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
  };
}

function incidentSummaryFromStatusIncident(
  incident: PublicStatusResponse['active_incidents'][number],
): IncidentSummary {
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    message: incident.message,
    started_at: incident.started_at,
    resolved_at: incident.resolved_at,
  };
}

function toMaintenancePreview(row: MaintenanceWindowRow, monitorIds: number[]): MaintenancePreview {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    monitor_ids: monitorIds,
  };
}

function maintenancePreviewFromStatusWindow(
  window: PublicStatusResponse['maintenance_windows']['active'][number],
): MaintenancePreview {
  return {
    id: window.id,
    title: window.title,
    message: window.message,
    starts_at: window.starts_at,
    ends_at: window.ends_at,
    monitor_ids: window.monitor_ids,
  };
}

async function readHomepageUptimeRatingLevel(db: D1Database): Promise<1 | 2 | 3 | 4 | 5> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?1')
    .bind('uptime_rating_level')
    .first<{ value: string }>();

  const raw = row?.value ?? '';
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed as 1 | 2 | 3 | 4 | 5;
  }
  return 3;
}

async function listHomepageMaintenanceMonitorIds(
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

function computeOverallStatus(summary: PublicHomepageResponse['summary']): HomepageMonitorStatus {
  if (summary.down > 0) return 'down';
  if (summary.unknown > 0) return 'unknown';
  if (summary.maintenance > 0) return 'maintenance';
  if (summary.up > 0) return 'up';
  if (summary.paused > 0) return 'paused';
  return 'unknown';
}

function toHomepageMonitorType(value: string): HomepageMonitorCard['type'] {
  return value === 'tcp' ? 'tcp' : 'http';
}

function computeHomepageMonitorPresentation(
  row: Pick<HomepageMonitorRow, 'id' | 'interval_sec' | 'last_checked_at' | 'state_status'>,
  now: number,
  maintenanceMonitorIds: ReadonlySet<number>,
): Pick<HomepageMonitorCard, 'status' | 'is_stale'> {
  const isInMaintenance = maintenanceMonitorIds.has(row.id);
  const stateStatus = toMonitorStatus(row.state_status);
  const isStale =
    isInMaintenance || stateStatus === 'paused' || stateStatus === 'maintenance'
      ? false
      : row.last_checked_at === null
        ? true
        : now - row.last_checked_at > row.interval_sec * 2;

  return {
    status: isInMaintenance ? 'maintenance' : isStale ? 'unknown' : stateStatus,
    is_stale: isStale,
  };
}

function toHomepageMonitorCard(
  row: HomepageMonitorRow,
  now: number,
  maintenanceMonitorIds: ReadonlySet<number>,
): HomepageMonitorCard {
  const presentation = computeHomepageMonitorPresentation(row, now, maintenanceMonitorIds);

  return {
    id: row.id,
    name: row.name,
    type: toHomepageMonitorType(row.type),
    display_url: row.display_url ?? null,
    group_name: row.group_name?.trim() ? row.group_name.trim() : null,
    status: presentation.status,
    is_stale: presentation.is_stale,
    last_checked_at: row.last_checked_at,
    heartbeat_strip: {
      checked_at: [],
      status_codes: '',
      latency_ms: [],
    },
    uptime_30d: null,
    uptime_day_strip: {
      day_start_at: [],
      downtime_sec: [],
      unknown_sec: [],
      uptime_pct_milli: [],
    },
  };
}

function addUptimeDay(
  monitor: HomepageMonitorCard,
  totals: { totalSec: number; uptimeSec: number },
  dayStartAt: number,
  uptime: UptimeWindowTotals,
): void {
  monitor.uptime_day_strip.day_start_at.push(dayStartAt);
  monitor.uptime_day_strip.downtime_sec.push(uptime.downtime_sec);
  monitor.uptime_day_strip.unknown_sec.push(uptime.unknown_sec);
  monitor.uptime_day_strip.uptime_pct_milli.push(
    uptime.uptime_pct === null ? null : Math.round(uptime.uptime_pct * 1000),
  );
  totals.totalSec += uptime.total_sec;
  totals.uptimeSec += uptime.uptime_sec;
}

function historicalDayTotalSeconds(opts: {
  dayStartAt: number;
  rangeStart: number;
  rangeEndFullDays: number;
  monitorCreatedAt: number;
}): number {
  const dayStart = Math.max(opts.dayStartAt, opts.rangeStart, opts.monitorCreatedAt);
  const dayEnd = Math.min(opts.dayStartAt + 86_400, opts.rangeEndFullDays);
  return Math.max(0, dayEnd - dayStart);
}

function reuseHistoricalRollupsFromBase(opts: {
  monitor: HomepageMonitorCard;
  baseMonitor: HomepageMonitorCard;
  monitorCreatedAt: number;
  rangeStart: number;
  rangeEndFullDays: number;
  todayStartAt: number;
  totals: { totalSec: number; uptimeSec: number };
}): void {
  const dayStartAt: number[] = [];
  const downtimeSec: number[] = [];
  const unknownSec: number[] = [];
  const uptimePctMilli: Array<number | null> = [];

  const count = Math.min(
    opts.baseMonitor.uptime_day_strip.day_start_at.length,
    opts.baseMonitor.uptime_day_strip.downtime_sec.length,
    opts.baseMonitor.uptime_day_strip.unknown_sec.length,
    opts.baseMonitor.uptime_day_strip.uptime_pct_milli.length,
  );

  for (let index = 0; index < count; index += 1) {
    const day = opts.baseMonitor.uptime_day_strip.day_start_at[index];
    if (typeof day !== 'number' || day >= opts.todayStartAt || day < opts.rangeStart) {
      continue;
    }

    const downtime = Math.max(0, opts.baseMonitor.uptime_day_strip.downtime_sec[index] ?? 0);
    const unknown = Math.max(0, opts.baseMonitor.uptime_day_strip.unknown_sec[index] ?? 0);

    dayStartAt.push(day);
    downtimeSec.push(downtime);
    unknownSec.push(unknown);
    uptimePctMilli.push(opts.baseMonitor.uptime_day_strip.uptime_pct_milli[index] ?? null);

    const totalSec = historicalDayTotalSeconds({
      dayStartAt: day,
      rangeStart: opts.rangeStart,
      rangeEndFullDays: opts.rangeEndFullDays,
      monitorCreatedAt: opts.monitorCreatedAt,
    });
    opts.totals.totalSec += totalSec;
    opts.totals.uptimeSec += Math.max(0, totalSec - downtime - unknown);
  }

  opts.monitor.uptime_day_strip.day_start_at = dayStartAt;
  opts.monitor.uptime_day_strip.downtime_sec = downtimeSec;
  opts.monitor.uptime_day_strip.unknown_sec = unknownSec;
  opts.monitor.uptime_day_strip.uptime_pct_milli = uptimePctMilli;
}

function hasReusableRuntimeCreatedAt(
  entry: PublicMonitorRuntimeEntry | undefined,
): entry is PublicMonitorRuntimeEntry & { created_at: number } {
  return typeof entry?.created_at === 'number' && Number.isInteger(entry.created_at);
}

function canReuseBaseSnapshotMonitorMetadata(opts: {
  baseSnapshot: PublicHomepageResponse | null | undefined;
  metadataStamp: HomepageMonitorMetadataStamp | null;
  runtimeSnapshot: PublicMonitorRuntimeSnapshot | null;
}): boolean {
  const { baseSnapshot, metadataStamp, runtimeSnapshot } = opts;
  if (!baseSnapshot) {
    return false;
  }
  if (
    !hasCompatibleBaseSnapshotMonitorMetadataStamp(baseSnapshot, metadataStamp) ||
    !runtimeSnapshot
  ) {
    return false;
  }
  if (runtimeSnapshot.generated_at < baseSnapshot.generated_at) {
    return false;
  }

  const monitorIds = getHomepageSnapshotMonitorIds(baseSnapshot);
  if (!snapshotHasMonitorIds(runtimeSnapshot, monitorIds)) {
    return false;
  }

  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);
  return baseSnapshot.monitors.every((monitor) =>
    isRuntimeEntryReusableForBaseMonitor(monitor, runtimeById.get(monitor.id)),
  );
}

function canTrustBaseSnapshotMonitorMetadata(opts: {
  baseSnapshot: PublicHomepageResponse | null | undefined;
  runtimeSnapshot: PublicMonitorRuntimeSnapshot | null;
}): boolean {
  const { baseSnapshot, runtimeSnapshot } = opts;
  if (!baseSnapshot || !runtimeSnapshot) {
    return false;
  }

  if (
    baseSnapshot.monitor_count_total !== baseSnapshot.monitors.length ||
    runtimeSnapshot.generated_at < baseSnapshot.generated_at ||
    !snapshotHasMonitorIds(runtimeSnapshot, getHomepageSnapshotMonitorIds(baseSnapshot))
  ) {
    return false;
  }

  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);
  return baseSnapshot.monitors.every((monitor) =>
    isRuntimeEntryReusableForBaseMonitor(monitor, runtimeById.get(monitor.id)),
  );
}

function isRuntimeEntryReusableForBaseMonitor(
  monitor: HomepageMonitorCard,
  entry: PublicMonitorRuntimeEntry | undefined,
): entry is PublicMonitorRuntimeEntry & { created_at: number } {
  if (!hasReusableRuntimeCreatedAt(entry)) {
    return false;
  }
  if (
    monitor.last_checked_at !== null &&
    (entry.last_checked_at === null || entry.last_checked_at < monitor.last_checked_at)
  ) {
    return false;
  }
  if (
    monitor.last_checked_at !== null &&
    entry.last_checked_at === monitor.last_checked_at &&
    !monitor.is_stale &&
    fromRuntimeStatusCode(entry.last_status_code) !== monitor.status
  ) {
    return false;
  }
  return true;
}

function buildHomepageMonitorRowsFromBaseSnapshot(
  baseSnapshot: PublicHomepageResponse,
  runtimeSnapshot: PublicMonitorRuntimeSnapshot,
): HomepageMonitorRow[] {
  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);

  return baseSnapshot.monitors.flatMap((monitor) => {
    const runtimeEntry = runtimeById.get(monitor.id);
    if (!hasReusableRuntimeCreatedAt(runtimeEntry)) {
      return [];
    }

    return [
      {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        display_url: monitor.display_url ?? null,
        group_name: monitor.group_name,
        interval_sec: runtimeEntry.interval_sec,
        created_at: runtimeEntry.created_at,
        state_status: fromRuntimeStatusCode(runtimeEntry.last_status_code),
        last_checked_at: runtimeEntry.last_checked_at,
      },
    ];
  });
}

async function listHomepageMonitorRows(
  db: D1Database,
  includeHiddenMonitors: boolean,
  limit?: number,
): Promise<HomepageMonitorRow[]> {
  const hasLimit = limit !== undefined;
  const stmt = getCachedHomepageStatement(
    db,
    includeHiddenMonitors
      ? hasLimit
        ? 'listMonitorRowsIncludingHiddenLimited'
        : 'listMonitorRowsIncludingHidden'
      : hasLimit
        ? 'listMonitorRowsLimited'
        : 'listMonitorRows',
    () =>
      db.prepare(
        `
      SELECT
        m.id,
        m.name,
        m.type,
        m.display_url,
        m.group_name,
        m.interval_sec,
        m.created_at,
        s.status AS state_status,
        s.last_checked_at
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
        m.id ASC${hasLimit ? '\n      LIMIT ?1' : ''}
    `,
      ),
  );

  const result =
    limit === undefined
      ? await stmt.all<HomepageMonitorRow>()
      : await stmt.bind(limit).all<HomepageMonitorRow>();

  return result.results ?? [];
}

async function readHomepageMonitorMetadataStamp(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<HomepageMonitorMetadataStamp> {
  const row = await getCachedHomepageStatement(
    db,
    includeHiddenMonitors ? 'monitorMetadataStampIncludingHidden' : 'monitorMetadataStamp',
    () =>
      db.prepare(
        `
      SELECT
        COUNT(*) AS monitor_count_total,
        MAX(COALESCE(m.updated_at, m.created_at, 0)) AS max_updated_at
      FROM monitors m
      WHERE m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
    `,
      ),
  ).first<{
    monitor_count_total: number | null;
    max_updated_at: number | null;
  }>();

  return {
    monitorCountTotal: row?.monitor_count_total ?? 0,
    maxUpdatedAt: row?.max_updated_at ?? null,
  };
}

async function readHomepageMonitorSummary(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<{
  monitorCountTotal: number;
  summary: PublicHomepageResponse['summary'];
  overallStatus: HomepageMonitorStatus;
}> {
  const row = await db
    .prepare(
      `
      WITH active_maintenance AS (
        SELECT DISTINCT mwm.monitor_id
        FROM maintenance_window_monitors mwm
        JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
        WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
      ),
      visible_monitors AS (
        SELECT
          m.interval_sec,
          COALESCE(s.status, 'unknown') AS normalized_status,
          s.last_checked_at,
          CASE WHEN am.monitor_id IS NULL THEN 0 ELSE 1 END AS in_maintenance
        FROM monitors m
        LEFT JOIN monitor_state s ON s.monitor_id = m.id
        LEFT JOIN active_maintenance am ON am.monitor_id = m.id
        WHERE m.is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      )
      SELECT
        COUNT(*) AS monitor_count_total,
        SUM(
          CASE
            WHEN in_maintenance = 1 OR normalized_status = 'maintenance' THEN 1
            ELSE 0
          END
        ) AS maintenance,
        SUM(
          CASE
            WHEN in_maintenance = 0 AND normalized_status = 'paused' THEN 1
            ELSE 0
          END
        ) AS paused,
        SUM(
          CASE
            WHEN
              in_maintenance = 0
              AND normalized_status = 'down'
              AND last_checked_at IS NOT NULL
              AND ?1 - last_checked_at <= interval_sec * 2
            THEN 1
            ELSE 0
          END
        ) AS down,
        SUM(
          CASE
            WHEN
              in_maintenance = 0
              AND normalized_status = 'up'
              AND last_checked_at IS NOT NULL
              AND ?1 - last_checked_at <= interval_sec * 2
            THEN 1
            ELSE 0
          END
        ) AS up,
        SUM(
          CASE
            WHEN
              in_maintenance = 1
              OR normalized_status = 'maintenance'
              OR (in_maintenance = 0 AND normalized_status = 'paused')
              OR (
                in_maintenance = 0
                AND normalized_status = 'down'
                AND last_checked_at IS NOT NULL
                AND ?1 - last_checked_at <= interval_sec * 2
              )
              OR (
                in_maintenance = 0
                AND normalized_status = 'up'
                AND last_checked_at IS NOT NULL
                AND ?1 - last_checked_at <= interval_sec * 2
              )
            THEN 0
            ELSE 1
          END
        ) AS unknown
      FROM visible_monitors
    `,
    )
    .bind(now)
    .first<{
      monitor_count_total: number | null;
      up: number | null;
      down: number | null;
      maintenance: number | null;
      paused: number | null;
      unknown: number | null;
    }>();

  const summary: PublicHomepageResponse['summary'] = {
    up: row?.up ?? 0,
    down: row?.down ?? 0,
    maintenance: row?.maintenance ?? 0,
    paused: row?.paused ?? 0,
    unknown: row?.unknown ?? 0,
  };

  return {
    monitorCountTotal: row?.monitor_count_total ?? 0,
    summary,
    overallStatus: computeOverallStatus(summary),
  };
}

async function buildHomepageMonitorCardsFromRows(
  db: D1Database,
  now: number,
  rows: HomepageMonitorRow[],
  maintenanceMonitorIds: ReadonlySet<number>,
  baseSnapshot: PublicHomepageResponse | null | undefined,
  runtimeSnapshot: PublicMonitorRuntimeSnapshot | null | undefined,
  trace?: Trace,
): Promise<HomepageMonitorCard[]> {
  if (rows.length === 0) {
    return [];
  }

  const earliestCreatedAt = rows.reduce(
    (acc, monitor) => Math.min(acc, monitor.created_at),
    Number.POSITIVE_INFINITY,
  );
  const rangeEndFullDays = utcDayStart(now);
  const rangeEnd = now;
  const rangeStart = Number.isFinite(earliestCreatedAt)
    ? Math.max(rangeEnd - UPTIME_DAYS * 86400, earliestCreatedAt)
    : rangeEnd - UPTIME_DAYS * 86400;
  const selectedIds = rows.map((monitor) => monitor.id);
  const placeholders = buildNumberedPlaceholders(selectedIds.length);
  const todayStartAt = utcDayStart(now);
  // Always compute a partial "today" bucket whenever we're inside the current UTC day.
  // This avoids missing uptime strips / 60d uptime immediately after a fresh deployment.
  const needsToday = rangeEnd > rangeEndFullDays;
  const monitors = rows.map((row) => toHomepageMonitorCard(row, now, maintenanceMonitorIds));
  const baseMonitorsById = baseSnapshot ? getHomepageSnapshotMonitorById(baseSnapshot) : null;
  const resolvedRuntimeSnapshot =
    runtimeSnapshot !== undefined
      ? runtimeSnapshot
      : await withTraceAsync(
          trace,
          'homepage_cards_runtime_cache_read',
          async () => await readPublicMonitorRuntimeSnapshot(db, now),
        );
  const runtimeById =
    resolvedRuntimeSnapshot && snapshotHasMonitorIds(resolvedRuntimeSnapshot, selectedIds)
      ? toMonitorRuntimeEntryMap(resolvedRuntimeSnapshot)
      : null;
  const monitorIndexById = new Map<number, number>();
  for (let index = 0; index < monitors.length; index += 1) {
    const monitor = monitors[index];
    if (!monitor) continue;
    monitorIndexById.set(monitor.id, index);
  }

  const heartbeatRowsPromise = runtimeById
    ? Promise.resolve(
        rows.map((monitor) => ({
          monitorId: monitor.id,
          rows: runtimeEntryToHeartbeats(runtimeById.get(monitor.id)!).map((heartbeat) => ({
            checked_at: heartbeat.checked_at,
            latency_ms: heartbeat.latency_ms,
            status: heartbeat.status,
          })),
        })),
      )
    : withTraceAsync(trace, 'homepage_cards_heartbeat_query', async () => {
        const statement = db.prepare(
          `
      SELECT checked_at, latency_ms, status
      FROM check_results
      WHERE monitor_id = ?1
      ORDER BY checked_at DESC, id DESC
      LIMIT ?2
    `,
        );
        const results = await db.batch<HomepageHeartbeatRow>(
          rows.map((monitor) => statement.bind(monitor.id, HEARTBEAT_POINTS)),
        );

        return rows.map((monitor, index) => ({
          monitorId: monitor.id,
          rows: results[index]?.results ?? [],
        }));
      });

  const canReuseHistoricalRollups =
    baseMonitorsById !== null && selectedIds.every((id) => baseMonitorsById.has(id));
  const rollupRowsPromise = canReuseHistoricalRollups
    ? Promise.resolve<HomepageUptimeDayStripAggRawRow[]>([])
    : withTraceAsync(
        trace,
        'homepage_cards_rollup_query',
        async () =>
          await db
            .prepare(
              `
        SELECT
          monitor_id,
          json_group_array(day_start_at) AS day_start_at_json,
          json_group_array(downtime_sec) AS downtime_sec_json,
          json_group_array(unknown_sec) AS unknown_sec_json,
          json_group_array(
            CASE
              WHEN total_sec IS NULL OR total_sec = 0 THEN NULL
              ELSE CAST(round((uptime_sec * 100000.0) / total_sec) AS INTEGER)
            END
          ) AS uptime_pct_milli_json,
          sum(total_sec) AS total_sec_sum,
          sum(uptime_sec) AS uptime_sec_sum
        FROM (
          SELECT monitor_id, day_start_at, total_sec, downtime_sec, unknown_sec, uptime_sec
          FROM monitor_daily_rollups
          WHERE monitor_id IN (${placeholders})
            AND day_start_at >= ?${selectedIds.length + 1}
            AND day_start_at < ?${selectedIds.length + 2}
          ORDER BY monitor_id, day_start_at
        )
        GROUP BY monitor_id
        ORDER BY monitor_id
      `,
            )
            .bind(...selectedIds, rangeStart, rangeEndFullDays)
            .raw<HomepageUptimeDayStripAggRawRow>()
            .then((resultRows) => resultRows ?? []),
      );

  const todayByMonitorIdPromise: Promise<Map<number, UptimeWindowTotals>> = !needsToday
    ? Promise.resolve(new Map<number, UptimeWindowTotals>())
    : runtimeById
      ? Promise.resolve(
          new Map<number, UptimeWindowTotals>(
            rows.map((monitor) => [
              monitor.id,
              materializeMonitorRuntimeTotals(runtimeById.get(monitor.id)!, rangeEnd),
            ]),
          ),
        )
      : withTraceAsync(
          trace,
          'homepage_cards_today_query',
          async () =>
            await computeTodayPartialUptimeBatch(
              db,
              rows.map((monitor) => ({
                id: monitor.id,
                interval_sec: monitor.interval_sec,
                created_at: monitor.created_at,
                last_checked_at: monitor.last_checked_at,
              })),
              Math.max(todayStartAt, rangeStart),
              rangeEnd,
            ),
        );

  const [heartbeatRows, rollupRows, todayByMonitorId] = await Promise.all([
    heartbeatRowsPromise,
    rollupRowsPromise,
    todayByMonitorIdPromise,
  ]);

  withTraceSync(trace, 'homepage_cards_heartbeat_hydrate', () => {
    for (const row of heartbeatRows) {
      const index = monitorIndexById.get(row.monitorId);
      if (index === undefined) continue;

      const monitor = monitors[index];
      if (!monitor) continue;

      monitor.heartbeat_strip.checked_at = row.rows.map((entry) => entry.checked_at);
      monitor.heartbeat_strip.latency_ms = row.rows.map((entry) => entry.latency_ms);
      monitor.heartbeat_strip.status_codes = row.rows
        .map((entry) => toHeartbeatStatusCode(entry.status))
        .join('');
    }
  });

  const totalsByMonitor = Array.from({ length: monitors.length }, () => ({
    totalSec: 0,
    uptimeSec: 0,
  }));
  withTraceSync(trace, 'homepage_cards_rollup_hydrate', () => {
    if (canReuseHistoricalRollups && baseMonitorsById) {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const monitor = monitors[index];
        const totals = totalsByMonitor[index];
        if (!row || !monitor || !totals) continue;

        const baseMonitor = baseMonitorsById.get(row.id);
        if (!baseMonitor) continue;

        reuseHistoricalRollupsFromBase({
          monitor,
          baseMonitor,
          monitorCreatedAt: row.created_at,
          rangeStart,
          rangeEndFullDays,
          todayStartAt,
          totals,
        });
      }
      return;
    }

    for (const row of rollupRows) {
      const index = monitorIndexById.get(row[0]);
      if (index === undefined) continue;

      const monitor = monitors[index];
      const totals = totalsByMonitor[index];
      if (!monitor || !totals) continue;

      monitor.uptime_day_strip.day_start_at = safeParseJsonArray(
        row[1],
        nonNegativeIntegerArraySchema,
      );
      monitor.uptime_day_strip.downtime_sec = safeParseJsonArray(
        row[2],
        nonNegativeIntegerArraySchema,
      );
      monitor.uptime_day_strip.unknown_sec = safeParseJsonArray(
        row[3],
        nonNegativeIntegerArraySchema,
      );
      monitor.uptime_day_strip.uptime_pct_milli = safeParseJsonArray(
        row[4],
        nullableNonNegativeIntegerArraySchema,
      );
      totals.totalSec = row[5] ?? 0;
      totals.uptimeSec = row[6] ?? 0;
    }
  });

  if (needsToday) {
    withTraceSync(trace, 'homepage_cards_today_hydrate', () => {
      for (const [monitorId, today] of todayByMonitorId) {
        const index = monitorIndexById.get(monitorId);
        if (index === undefined) continue;
        const monitor = monitors[index];
        const totals = totalsByMonitor[index];
        if (!monitor || !totals) continue;
        addUptimeDay(monitor, totals, todayStartAt, today);
      }
    });
  }

  withTraceSync(trace, 'homepage_cards_finalize', () => {
    for (let index = 0; index < monitors.length; index += 1) {
      const monitor = monitors[index];
      const totals = totalsByMonitor[index];
      if (!monitor || !totals) continue;

      monitor.uptime_30d =
        totals.totalSec === 0
          ? null
          : {
              uptime_pct: (totals.uptimeSec / totals.totalSec) * 100,
            };
    }
  });

  return monitors;
}

async function buildHomepageMonitorData(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
  opts: HomepageMonitorDataOptions = {},
): Promise<{
  monitors: HomepageMonitorCard[];
  monitorCountTotal: number;
  summary: PublicHomepageResponse['summary'];
  overallStatus: HomepageMonitorStatus;
  uptimeRatingLevel: 1 | 2 | 3 | 4 | 5;
}> {
  const trace = opts.trace;
  const baseSnapshot = opts.baseSnapshot ?? null;
  const runtimeSnapshotPromise =
    opts.runtimeSnapshot !== undefined
      ? withTraceAsync(
          trace,
          'homepage_cards_runtime_cache_reuse',
          async () => opts.runtimeSnapshot,
        )
      : baseSnapshot === null
        ? Promise.resolve<PublicMonitorRuntimeSnapshot | null | undefined>(undefined)
        : withTraceAsync(
            trace,
            'homepage_cards_runtime_cache_read',
            async () => await readPublicMonitorRuntimeSnapshot(db, now),
          );
  const monitorMetadataStampPromise =
    opts.monitorMetadataStamp !== undefined
      ? Promise.resolve(opts.monitorMetadataStamp)
      : baseSnapshot === null || opts.trustBaseSnapshotMonitorMetadata
        ? Promise.resolve<HomepageMonitorMetadataStamp | null>(null)
        : withTraceAsync(
            trace,
            'homepage_monitor_metadata_stamp',
            async () => await readHomepageMonitorMetadataStamp(db, includeHiddenMonitors),
          );
  const [runtimeSnapshot, monitorMetadataStamp] = await Promise.all([
    runtimeSnapshotPromise,
    monitorMetadataStampPromise,
  ]);

  const reuseBaseMonitorRows = opts.trustBaseSnapshotMonitorMetadata
    ? canTrustBaseSnapshotMonitorMetadata({
        baseSnapshot,
        runtimeSnapshot: runtimeSnapshot ?? null,
      })
    : canReuseBaseSnapshotMonitorMetadata({
        baseSnapshot,
        metadataStamp: monitorMetadataStamp,
        runtimeSnapshot: runtimeSnapshot ?? null,
      });
  const rawMonitors =
    reuseBaseMonitorRows &&
    baseSnapshot !== null &&
    runtimeSnapshot !== undefined &&
    runtimeSnapshot !== null
      ? withTraceSync(trace, 'homepage_monitor_rows_reuse', () =>
          buildHomepageMonitorRowsFromBaseSnapshot(baseSnapshot, runtimeSnapshot),
        )
      : await withTraceAsync(
          trace,
          'homepage_monitor_rows',
          async () => await listHomepageMonitorRows(db, includeHiddenMonitors),
        );
  const monitorCountTotal = reuseBaseMonitorRows
    ? (monitorMetadataStamp?.monitorCountTotal ?? rawMonitors.length)
    : rawMonitors.length;
  const ids = rawMonitors.map((monitor) => monitor.id);
  const selectedRows =
    opts.cardLimit === undefined ? rawMonitors : rawMonitors.slice(0, Math.max(0, opts.cardLimit));

  const maintenanceMonitorIdsPromise =
    opts.maintenanceMonitorIdsPromise === undefined
      ? withTraceAsync(
          trace,
          'homepage_maintenance_monitor_ids',
          async () => await listHomepageMaintenanceMonitorIds(db, now, ids),
        )
      : withTraceAsync(
          trace,
          'homepage_maintenance_monitor_ids_reuse',
          async () => new Set(await opts.maintenanceMonitorIdsPromise),
        );

  const [maintenanceMonitorIds, uptimeRatingLevel] = await Promise.all([
    maintenanceMonitorIdsPromise,
    opts.uptimeRatingLevel === undefined
      ? withTraceAsync(
          trace,
          'homepage_uptime_rating_setting',
          async () => await readHomepageUptimeRatingLevel(db),
        )
      : Promise.resolve(opts.uptimeRatingLevel),
  ]);

  const summary: PublicHomepageResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };

  withTraceSync(trace, 'homepage_summary_counts', () => {
    for (let index = 0; index < rawMonitors.length; index += 1) {
      const row = rawMonitors[index];
      if (!row) continue;

      const presentation = computeHomepageMonitorPresentation(row, now, maintenanceMonitorIds);
      summary[presentation.status] += 1;
    }
  });

  if (selectedRows.length === 0) {
    return {
      monitors: [],
      monitorCountTotal,
      summary,
      overallStatus: computeOverallStatus(summary),
      uptimeRatingLevel,
    };
  }

  const monitors = await withTraceAsync(
    trace,
    'homepage_monitor_cards',
    async () =>
      await buildHomepageMonitorCardsFromRows(
        db,
        now,
        selectedRows,
        maintenanceMonitorIds,
        opts.baseSnapshot,
        runtimeSnapshot,
        trace,
      ),
  );

  return {
    monitors,
    monitorCountTotal,
    summary,
    overallStatus: computeOverallStatus(summary),
    uptimeRatingLevel,
  };
}

async function findLatestVisibleResolvedIncident(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<IncidentRow | null> {
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);
  let cursor: { resolvedAt: number; id: number } | null = null;

  while (true) {
    const queryResult: { results: IncidentRow[] | undefined } = cursor
      ? await db
          .prepare(
            `
            SELECT id, title, status, impact, message, started_at, resolved_at
            FROM incidents
            WHERE status = 'resolved'
              AND resolved_at IS NOT NULL
              AND ${incidentVisibilitySql}
              AND (resolved_at < ?2 OR (resolved_at = ?2 AND id < ?3))
            ORDER BY resolved_at DESC, id DESC
            LIMIT ?1
          `,
          )
          .bind(PREVIEW_BATCH_LIMIT, cursor.resolvedAt, cursor.id)
          .all<IncidentRow>()
      : await db
          .prepare(
            `
            SELECT id, title, status, impact, message, started_at, resolved_at
            FROM incidents
            WHERE status = 'resolved'
              AND resolved_at IS NOT NULL
              AND ${incidentVisibilitySql}
            ORDER BY resolved_at DESC, id DESC
            LIMIT ?1
          `,
          )
          .bind(PREVIEW_BATCH_LIMIT)
          .all<IncidentRow>();

    const rows: IncidentRow[] = queryResult.results ?? [];
    if (rows.length === 0) return null;

    const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
      db,
      rows.map((row) => row.id),
    );
    const visibleMonitorIds = includeHiddenMonitors
      ? new Set<number>()
      : await listStatusPageVisibleMonitorIds(db, [...monitorIdsByIncidentId.values()].flat());

    for (const row of rows) {
      const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        includeHiddenMonitors,
      );

      if (shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        return row;
      }
    }

    if (rows.length < PREVIEW_BATCH_LIMIT) {
      return null;
    }

    const nextCursor = rows[rows.length - 1];
    if (nextCursor?.resolved_at === null || nextCursor?.resolved_at === undefined) {
      return null;
    }
    cursor = {
      resolvedAt: nextCursor.resolved_at,
      id: nextCursor.id,
    };
  }
}

async function findLatestVisibleHistoricalMaintenanceWindow(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<{ row: MaintenanceWindowRow; monitorIds: number[] } | null> {
  const maintenanceVisibilitySql =
    maintenanceWindowStatusPageVisibilityPredicate(includeHiddenMonitors);
  let cursor: { endsAt: number; id: number } | null = null;

  while (true) {
    const queryResult: { results: MaintenanceWindowRow[] | undefined } = cursor
      ? await db
          .prepare(
            `
            SELECT id, title, message, starts_at, ends_at, created_at
            FROM maintenance_windows
            WHERE ends_at <= ?1
              AND ${maintenanceVisibilitySql}
              AND (ends_at < ?2 OR (ends_at = ?2 AND id < ?3))
            ORDER BY ends_at DESC, id DESC
            LIMIT ?4
          `,
          )
          .bind(now, cursor.endsAt, cursor.id, PREVIEW_BATCH_LIMIT)
          .all<MaintenanceWindowRow>()
      : await db
          .prepare(
            `
            SELECT id, title, message, starts_at, ends_at, created_at
            FROM maintenance_windows
            WHERE ends_at <= ?1
              AND ${maintenanceVisibilitySql}
            ORDER BY ends_at DESC, id DESC
            LIMIT ?2
          `,
          )
          .bind(now, PREVIEW_BATCH_LIMIT)
          .all<MaintenanceWindowRow>();

    const rows: MaintenanceWindowRow[] = queryResult.results ?? [];
    if (rows.length === 0) return null;

    const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
      db,
      rows.map((row) => row.id),
    );
    const visibleMonitorIds = includeHiddenMonitors
      ? new Set<number>()
      : await listStatusPageVisibleMonitorIds(db, [...monitorIdsByWindowId.values()].flat());

    for (const row of rows) {
      const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        includeHiddenMonitors,
      );

      if (shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        return { row, monitorIds: filteredMonitorIds };
      }
    }

    if (rows.length < PREVIEW_BATCH_LIMIT) {
      return null;
    }

    const nextCursor = rows[rows.length - 1];
    if (!nextCursor) {
      return null;
    }
    cursor = {
      endsAt: nextCursor.ends_at,
      id: nextCursor.id,
    };
  }
}

export async function readHomepageHistoryPreviews(
  db: D1Database,
  now: number,
  trace?: Trace,
): Promise<{
  resolvedIncidentPreview: IncidentSummary | null;
  maintenanceHistoryPreview: MaintenancePreview | null;
}> {
  const includeHiddenMonitors = false;
  const [resolvedIncidentPreview, maintenanceHistoryPreview] = await Promise.all([
    withTraceAsync(
      trace,
      'homepage_history_incident_preview',
      async () => await findLatestVisibleResolvedIncident(db, includeHiddenMonitors),
    ),
    withTraceAsync(
      trace,
      'homepage_history_maintenance_preview',
      async () =>
        await findLatestVisibleHistoricalMaintenanceWindow(db, now, includeHiddenMonitors),
    ),
  ]);

  return {
    resolvedIncidentPreview: resolvedIncidentPreview
      ? toIncidentSummary(resolvedIncidentPreview)
      : null,
    maintenanceHistoryPreview: maintenanceHistoryPreview
      ? toMaintenancePreview(maintenanceHistoryPreview.row, maintenanceHistoryPreview.monitorIds)
      : null,
  };
}

export function homepageFromStatusPayload(
  status: PublicStatusResponse,
  previews: {
    resolvedIncidentPreview?: IncidentSummary | null;
    maintenanceHistoryPreview?: MaintenancePreview | null;
  } = {},
): PublicHomepageResponse {
  return {
    generated_at: status.generated_at,
    bootstrap_mode: 'full',
    monitor_count_total: status.monitors.length,
    site_title: status.site_title,
    site_description: status.site_description,
    site_locale: status.site_locale,
    site_timezone: status.site_timezone,
    uptime_rating_level: status.uptime_rating_level,
    overall_status: status.overall_status,
    banner: status.banner,
    summary: status.summary,
    monitors: status.monitors.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      display_url: monitor.display_url ?? null,
      group_name: monitor.group_name,
      status: monitor.status,
      is_stale: monitor.is_stale,
      last_checked_at: monitor.last_checked_at,
      heartbeat_strip: {
        checked_at: monitor.heartbeats.map((heartbeat) => heartbeat.checked_at),
        status_codes: monitor.heartbeats
          .map((heartbeat) => toHeartbeatStatusCode(heartbeat.status))
          .join(''),
        latency_ms: monitor.heartbeats.map((heartbeat) => heartbeat.latency_ms),
      },
      uptime_30d: monitor.uptime_30d ? { uptime_pct: monitor.uptime_30d.uptime_pct } : null,
      uptime_day_strip: {
        day_start_at: monitor.uptime_days.map((day) => day.day_start_at),
        downtime_sec: monitor.uptime_days.map((day) => day.downtime_sec),
        unknown_sec: monitor.uptime_days.map((day) => day.unknown_sec),
        uptime_pct_milli: monitor.uptime_days.map((day) =>
          day.uptime_pct === null ? null : Math.round(day.uptime_pct * 1000),
        ),
      },
    })),
    active_incidents: status.active_incidents.map(incidentSummaryFromStatusIncident),
    maintenance_windows: {
      active: status.maintenance_windows.active.map(maintenancePreviewFromStatusWindow),
      upcoming: status.maintenance_windows.upcoming.map(maintenancePreviewFromStatusWindow),
    },
    resolved_incident_preview: previews.resolvedIncidentPreview ?? null,
    maintenance_history_preview: previews.maintenanceHistoryPreview ?? null,
  };
}

function sameIncidentSummary(
  left: IncidentSummary | null | undefined,
  right: IncidentSummary | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id &&
    left.title === right.title &&
    left.status === right.status &&
    left.impact === right.impact &&
    left.message === right.message &&
    left.started_at === right.started_at &&
    left.resolved_at === right.resolved_at
  );
}

function sameMaintenancePreview(
  left: MaintenancePreview | null | undefined,
  right: MaintenancePreview | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (
    left.id !== right.id ||
    left.title !== right.title ||
    left.message !== right.message ||
    left.starts_at !== right.starts_at ||
    left.ends_at !== right.ends_at ||
    left.monitor_ids.length !== right.monitor_ids.length
  ) {
    return false;
  }

  for (let index = 0; index < left.monitor_ids.length; index += 1) {
    if (left.monitor_ids[index] !== right.monitor_ids[index]) {
      return false;
    }
  }

  return true;
}

function computePatchedHomepageSegmentTotals(opts: {
  status: HomepageMonitorStatus;
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

function prependCappedArray<T>(value: T, source: readonly T[], maxLength: number): T[] {
  const nextLength = Math.min(Math.max(1, maxLength), source.length + 1);
  const next = new Array<T>(nextLength);
  next[0] = value;
  for (let index = 1; index < nextLength; index += 1) {
    next[index] = source[index - 1] as T;
  }
  return next;
}

function computePatchedHomepageUptimeDayContribution(opts: {
  dayStartAt: number;
  rangeStart: number;
  rangeEnd: number;
  downtimeSec: number;
  unknownSec: number;
}): { totalSec: number; uptimeSec: number } {
  if (opts.dayStartAt >= opts.rangeEnd || opts.dayStartAt + 86400 <= opts.rangeStart) {
    return { totalSec: 0, uptimeSec: 0 };
  }

  const totalSec = Math.max(
    0,
    Math.min(opts.dayStartAt + 86400, opts.rangeEnd) - Math.max(opts.dayStartAt, opts.rangeStart),
  );
  if (totalSec === 0) {
    return { totalSec: 0, uptimeSec: 0 };
  }

  return {
    totalSec,
    uptimeSec: Math.max(0, totalSec - Math.max(0, opts.downtimeSec) - Math.max(0, opts.unknownSec)),
  };
}

function isFastPatchUpdateFresh(now: number, update: MonitorRuntimeUpdate): boolean {
  return now - update.checked_at <= update.interval_sec * 2;
}

function tryPatchPublicHomepagePayloadFromRuntimeSnapshot(opts: {
  baseSnapshot: PublicHomepageResponse | null;
  runtimeSnapshot: PublicMonitorRuntimeSnapshot | null;
  now: number;
  updates: MonitorRuntimeUpdate[];
  trace?: Trace;
}): PublicHomepageResponse | null {
  const { baseSnapshot, runtimeSnapshot, now, updates } = opts;
  if (!baseSnapshot || !runtimeSnapshot || !canPatchHomepageFromRuntime(baseSnapshot)) {
    opts.trace?.setLabel('runtime_snapshot_patch_skip', 'base_ineligible');
    return null;
  }
  if (runtimeSnapshot.generated_at > now || runtimeSnapshot.day_start_at !== utcDayStart(now)) {
    opts.trace?.setLabel('runtime_snapshot_patch_skip', 'runtime_window');
    return null;
  }
  if (runtimeSnapshot.generated_at < baseSnapshot.generated_at) {
    opts.trace?.setLabel('runtime_snapshot_patch_skip', 'runtime_older_than_base');
    return null;
  }

  const monitorIds = getHomepageSnapshotMonitorIds(baseSnapshot);
  const monitorIdSet = new Set(monitorIds);
  if (!snapshotHasMonitorIds(runtimeSnapshot, monitorIds)) {
    opts.trace?.setLabel('runtime_snapshot_patch_skip', 'missing_monitor_ids');
    return null;
  }

  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);
  const earliestCreatedAt = baseSnapshot.monitors.reduce((acc, monitor) => {
    const entry = runtimeById.get(monitor.id);
    if (!hasReusableRuntimeCreatedAt(entry)) {
      return acc;
    }
    return Math.min(acc, entry.created_at);
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(earliestCreatedAt)) {
    opts.trace?.setLabel('runtime_snapshot_patch_skip', 'missing_created_at');
    return null;
  }

  const updateById = new Map<number, MonitorRuntimeUpdate>();
  for (const update of updates) {
    if (!Number.isInteger(update.monitor_id) || update.monitor_id <= 0) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'invalid_update_id');
      return null;
    }
    if (!monitorIdSet.has(update.monitor_id)) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'update_outside_snapshot');
      return null;
    }
    if (!Number.isInteger(update.checked_at) || update.checked_at < update.created_at) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'invalid_update_window');
      return null;
    }
    if (update.checked_at > now) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'future_update');
      return null;
    }
    if (!isFastPatchUpdateFresh(now, update)) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'stale_update_age');
      return null;
    }
    if (updateById.has(update.monitor_id)) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'duplicate_update');
      return null;
    }
    updateById.set(update.monitor_id, update);
  }

  const rangeEndFullDays = utcDayStart(now);
  const rangeStart = Math.max(now - UPTIME_DAYS * 86400, earliestCreatedAt);
  const todayStartAt = utcDayStart(now);
  const needsToday = now > rangeEndFullDays;
  const noMaintenanceMonitorIds = new Set<number>();
  const summary: PublicHomepageResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };

  const patchedMonitors: HomepageMonitorCard[] = [];
  for (const baseMonitor of baseSnapshot.monitors) {
    const runtimeEntry = runtimeById.get(baseMonitor.id);
    if (!hasReusableRuntimeCreatedAt(runtimeEntry)) {
      opts.trace?.setLabel('runtime_snapshot_patch_skip', 'monitor_runtime_missing');
      return null;
    }
    const update = updateById.get(baseMonitor.id);
    const createdAt = update?.created_at ?? runtimeEntry.created_at;
    const intervalSec = update?.interval_sec ?? runtimeEntry.interval_sec;
    const todayIndex = baseMonitor.uptime_day_strip.day_start_at.findIndex(
      (dayStart) => dayStart === todayStartAt,
    );
    const currentDowntime =
      todayIndex < 0 ? 0 : Math.max(0, baseMonitor.uptime_day_strip.downtime_sec[todayIndex] ?? 0);
    const currentUnknown =
      todayIndex < 0 ? 0 : Math.max(0, baseMonitor.uptime_day_strip.unknown_sec[todayIndex] ?? 0);

    let nextMonitor: HomepageMonitorCard;
    let todayTotals: UptimeWindowTotals | null = null;
    if (update) {
      if (
        baseMonitor.last_checked_at !== null &&
        update.checked_at <= baseMonitor.last_checked_at
      ) {
        opts.trace?.setLabel('runtime_snapshot_patch_skip', 'stale_update');
        return null;
      }
      if (
        baseMonitor.last_checked_at !== null &&
        update.checked_at - baseMonitor.last_checked_at >
          Math.max(
            HOMEPAGE_FAST_PATCH_BASE_MAX_AGE_SECONDS,
            update.interval_sec + HOMEPAGE_FAST_PATCH_UPDATE_GRACE_SECONDS,
          )
      ) {
        opts.trace?.setLabel('runtime_snapshot_patch_skip', 'update_gap');
        return null;
      }

      const segmentStart = Math.max(todayStartAt, baseSnapshot.generated_at, createdAt);
      const segmentEnd = Math.max(segmentStart, Math.min(update.checked_at, now));
      const segment = computePatchedHomepageSegmentTotals({
        status: baseMonitor.status,
        isStale: baseMonitor.is_stale,
        lastCheckedAt: baseMonitor.last_checked_at,
        intervalSec,
        segmentStart,
        segmentEnd,
      });
      const nextPresentation = computeHomepageMonitorPresentation(
        {
          id: baseMonitor.id,
          interval_sec: intervalSec,
          last_checked_at: update.checked_at,
          state_status: update.next_status,
        },
        now,
        noMaintenanceMonitorIds,
      );
      const tail = computePatchedHomepageSegmentTotals({
        status: nextPresentation.status,
        isStale: nextPresentation.is_stale,
        lastCheckedAt: update.checked_at,
        intervalSec,
        segmentStart: Math.max(segmentEnd, update.checked_at),
        segmentEnd: now,
      });

      const totalSec = Math.max(0, now - Math.max(todayStartAt, createdAt));
      const nextDowntimeSec = currentDowntime + segment.downtimeSec + tail.downtimeSec;
      const nextUnknownSec = currentUnknown + segment.unknownSec + tail.unknownSec;
      const nextUptimeSec = Math.max(0, totalSec - nextDowntimeSec - nextUnknownSec);
      todayTotals = {
        total_sec: totalSec,
        downtime_sec: nextDowntimeSec,
        unknown_sec: nextUnknownSec,
        uptime_sec: nextUptimeSec,
        uptime_pct: totalSec === 0 ? null : (nextUptimeSec / totalSec) * 100,
      };

      nextMonitor = {
        ...baseMonitor,
        last_checked_at: update.checked_at,
        status: nextPresentation.status,
        is_stale: nextPresentation.is_stale,
        heartbeat_strip: {
          checked_at: [
            update.checked_at,
            ...baseMonitor.heartbeat_strip.checked_at.slice(0, HEARTBEAT_POINTS - 1),
          ],
          latency_ms: [
            normalizeRuntimeUpdateLatencyMs(update.latency_ms),
            ...baseMonitor.heartbeat_strip.latency_ms.slice(0, HEARTBEAT_POINTS - 1),
          ],
          status_codes: `${toHeartbeatStatusCode(update.check_status)}${baseMonitor.heartbeat_strip.status_codes.slice(0, HEARTBEAT_POINTS - 1)}`,
        },
        uptime_30d: null,
        uptime_day_strip: {
          day_start_at: [],
          downtime_sec: [],
          unknown_sec: [],
          uptime_pct_milli: [],
        },
      };
    } else {
      if (
        baseMonitor.last_checked_at !== null &&
        (runtimeEntry.last_checked_at === null ||
          runtimeEntry.last_checked_at < baseMonitor.last_checked_at)
      ) {
        opts.trace?.setLabel('runtime_snapshot_patch_skip', 'runtime_regressed');
        return null;
      }

      const heartbeats =
        baseMonitor.last_checked_at === runtimeEntry.last_checked_at
          ? null
          : runtimeEntryToHeartbeats(runtimeEntry);
      todayTotals = materializeMonitorRuntimeTotals(runtimeEntry, now);
      const presentation = computeHomepageMonitorPresentation(
        {
          id: baseMonitor.id,
          interval_sec: intervalSec,
          last_checked_at: runtimeEntry.last_checked_at,
          state_status: fromRuntimeStatusCode(runtimeEntry.last_status_code),
        },
        now,
        noMaintenanceMonitorIds,
      );
      nextMonitor = {
        ...baseMonitor,
        last_checked_at: runtimeEntry.last_checked_at,
        status: presentation.status,
        is_stale: presentation.is_stale,
        heartbeat_strip: {
          checked_at: heartbeats
            ? heartbeats.map((heartbeat) => heartbeat.checked_at)
            : baseMonitor.heartbeat_strip.checked_at,
          latency_ms: heartbeats
            ? heartbeats.map((heartbeat) => heartbeat.latency_ms)
            : baseMonitor.heartbeat_strip.latency_ms,
          status_codes: heartbeats
            ? heartbeats.map((heartbeat) => toHeartbeatStatusCode(heartbeat.status)).join('')
            : baseMonitor.heartbeat_strip.status_codes,
        },
        uptime_30d: null,
        uptime_day_strip: {
          day_start_at: [],
          downtime_sec: [],
          unknown_sec: [],
          uptime_pct_milli: [],
        },
      };
    }

    const totals = {
      totalSec: 0,
      uptimeSec: 0,
    };
    reuseHistoricalRollupsFromBase({
      monitor: nextMonitor,
      baseMonitor,
      monitorCreatedAt: createdAt,
      rangeStart,
      rangeEndFullDays,
      todayStartAt,
      totals,
    });
    if (needsToday && todayTotals) {
      addUptimeDay(nextMonitor, totals, todayStartAt, todayTotals);
    }
    nextMonitor.uptime_30d =
      totals.totalSec === 0
        ? null
        : {
            uptime_pct: (totals.uptimeSec / totals.totalSec) * 100,
          };

    summary[nextMonitor.status] += 1;
    patchedMonitors.push(nextMonitor);
  }

  opts.trace?.setLabel('runtime_snapshot_patch', '1');
  return {
    ...baseSnapshot,
    generated_at: now,
    monitor_count_total: patchedMonitors.length,
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

export function tryPatchPublicHomepagePayloadFromRuntimeUpdates(opts: {
  baseSnapshot: PublicHomepageResponse | null;
  now: number;
  updates: MonitorRuntimeUpdate[];
}): PublicHomepageResponse | null {
  const { baseSnapshot, now, updates } = opts;
  if (!baseSnapshot || !canPatchHomepageFromRuntime(baseSnapshot)) {
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
    if (update.checked_at > now) {
      return null;
    }
    if (!isFastPatchUpdateFresh(now, update)) {
      return null;
    }
    if (updateById.has(update.monitor_id)) {
      return null;
    }
    updateById.set(update.monitor_id, update);
  }
  if (updateById.size !== baseSnapshot.monitors.length) {
    return null;
  }

  const todayStartAt = utcDayStart(now);
  const patchedMonitors: HomepageMonitorCard[] = [];
  const summary: PublicHomepageResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };

  for (const monitor of baseSnapshot.monitors) {
    const update = updateById.get(monitor.id);
    if (!update) {
      return null;
    }
    if (monitor.last_checked_at !== null && update.checked_at <= monitor.last_checked_at) {
      return null;
    }
    if (
      monitor.last_checked_at !== null &&
      update.checked_at - monitor.last_checked_at >
        Math.max(
          HOMEPAGE_FAST_PATCH_BASE_MAX_AGE_SECONDS,
          update.interval_sec + HOMEPAGE_FAST_PATCH_UPDATE_GRACE_SECONDS,
        )
    ) {
      return null;
    }

    const segmentStart = Math.max(todayStartAt, baseSnapshot.generated_at, update.created_at);
    const segmentEnd = Math.max(segmentStart, Math.min(update.checked_at, now));
    const segment = computePatchedHomepageSegmentTotals({
      status: monitor.status,
      isStale: monitor.is_stale,
      lastCheckedAt: monitor.last_checked_at,
      intervalSec: update.interval_sec,
      segmentStart,
      segmentEnd,
    });
    const nextPresentation = computeHomepageMonitorPresentation(
      {
        id: monitor.id,
        interval_sec: update.interval_sec,
        last_checked_at: update.checked_at,
        state_status: update.next_status,
      },
      now,
      new Set<number>(),
    );
    const tail = computePatchedHomepageSegmentTotals({
      status: nextPresentation.status,
      isStale: nextPresentation.is_stale,
      lastCheckedAt: update.checked_at,
      intervalSec: update.interval_sec,
      segmentStart: Math.max(segmentEnd, update.checked_at),
      segmentEnd: now,
    });

    const nextCheckedAt = prependCappedArray(
      update.checked_at,
      monitor.heartbeat_strip.checked_at,
      HEARTBEAT_POINTS,
    );
    const nextLatencyMs = prependCappedArray(
      normalizeRuntimeUpdateLatencyMs(update.latency_ms),
      monitor.heartbeat_strip.latency_ms,
      HEARTBEAT_POINTS,
    );
    const nextStatusCodes = `${toHeartbeatStatusCode(update.check_status)}${monitor.heartbeat_strip.status_codes.slice(0, HEARTBEAT_POINTS - 1)}`;

    const dayStartAt = monitor.uptime_day_strip.day_start_at.slice();
    const downtimeSec = monitor.uptime_day_strip.downtime_sec.slice();
    const unknownSec = monitor.uptime_day_strip.unknown_sec.slice();
    const uptimePctMilli = monitor.uptime_day_strip.uptime_pct_milli.slice();
    const rangeStart = Math.max(now - UPTIME_DAYS * 86400, update.created_at);
    let uptime30dTotalSec = 0;
    let uptime30dUptimeSec = 0;
    let bucketIndex = -1;
    let currentTodayTotalSec = 0;
    let currentTodayUptimeSec = 0;

    for (let index = 0; index < dayStartAt.length; index += 1) {
      const dayStart = dayStartAt[index];
      if (typeof dayStart !== 'number') {
        continue;
      }

      const currentDowntimeValue = Math.max(0, downtimeSec[index] ?? 0);
      const currentUnknownValue = Math.max(0, unknownSec[index] ?? 0);
      const contribution = computePatchedHomepageUptimeDayContribution({
        dayStartAt: dayStart,
        rangeStart,
        rangeEnd: now,
        downtimeSec: currentDowntimeValue,
        unknownSec: currentUnknownValue,
      });
      uptime30dTotalSec += contribution.totalSec;
      uptime30dUptimeSec += contribution.uptimeSec;

      if (dayStart === todayStartAt) {
        bucketIndex = index;
        currentTodayTotalSec = contribution.totalSec;
        currentTodayUptimeSec = contribution.uptimeSec;
      }
    }

    if (bucketIndex < 0) {
      bucketIndex = dayStartAt.push(todayStartAt) - 1;
      downtimeSec.push(0);
      unknownSec.push(0);
      uptimePctMilli.push(null);
    }

    const currentDowntime = Math.max(0, downtimeSec[bucketIndex] ?? 0);
    const currentUnknown = Math.max(0, unknownSec[bucketIndex] ?? 0);
    const totalSec = Math.max(0, now - Math.max(todayStartAt, update.created_at));
    const nextDowntimeSec = currentDowntime + segment.downtimeSec + tail.downtimeSec;
    const nextUnknownSec = currentUnknown + segment.unknownSec + tail.unknownSec;
    const nextUptimeSec = Math.max(0, totalSec - nextDowntimeSec - nextUnknownSec);

    downtimeSec[bucketIndex] = nextDowntimeSec;
    unknownSec[bucketIndex] = nextUnknownSec;
    uptimePctMilli[bucketIndex] =
      totalSec === 0 ? null : Math.round((nextUptimeSec * 100000) / totalSec);
    uptime30dTotalSec += totalSec - currentTodayTotalSec;
    uptime30dUptimeSec += nextUptimeSec - currentTodayUptimeSec;
    const nextMonitor: HomepageMonitorCard = {
      ...monitor,
      last_checked_at: update.checked_at,
      status: nextPresentation.status,
      is_stale: nextPresentation.is_stale,
      heartbeat_strip: {
        checked_at: nextCheckedAt,
        latency_ms: nextLatencyMs,
        status_codes: nextStatusCodes,
      },
      uptime_30d: null,
      uptime_day_strip: {
        day_start_at: dayStartAt,
        downtime_sec: downtimeSec,
        unknown_sec: unknownSec,
        uptime_pct_milli: uptimePctMilli,
      },
    };
    nextMonitor.uptime_30d =
      uptime30dTotalSec === 0
        ? null
        : {
            uptime_pct: (uptime30dUptimeSec / uptime30dTotalSec) * 100,
          };

    summary[nextMonitor.status] += 1;
    patchedMonitors.push(nextMonitor);
  }

  return {
    ...baseSnapshot,
    generated_at: now,
    monitor_count_total: patchedMonitors.length,
    summary,
    overall_status: computeOverallStatus(summary),
    banner: buildPublicStatusBanner({
      counts: summary,
      monitorCount: patchedMonitors.length,
      activeIncidents: [],
      activeMaintenanceWindows: [],
    }),
    monitors: patchedMonitors,
  };
}

async function readHomepageScheduledFastGuardState(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
  trace?: Trace,
): Promise<{
  settings: HomepagePublicSettings;
  monitorMetadataStamp: HomepageMonitorMetadataStamp;
  hasActiveIncidents: boolean;
  hasActiveMaintenance: boolean;
  hasUpcomingMaintenance: boolean;
  hasResolvedIncidentPreview: boolean;
  hasMaintenanceHistoryPreview: boolean;
}> {
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);
  const maintenanceVisibilitySql =
    maintenanceWindowStatusPageVisibilityPredicate(includeHiddenMonitors);
  const statement = getCachedHomepageStatement(
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
          FROM incidents
          WHERE status = 'resolved'
            AND ${incidentVisibilitySql}
          LIMIT 1
        ) AS has_resolved_incident_preview,
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
        ) AS has_upcoming_maintenance,
        EXISTS(
          SELECT 1
          FROM maintenance_windows
          WHERE ends_at <= ?1
            AND ${maintenanceVisibilitySql}
          LIMIT 1
        ) AS has_maintenance_history_preview
    `,
      ),
  );
  const row = await withTraceAsync(
    trace,
    'homepage_refresh_fast_guard_query',
    async () =>
      await statement.bind(now).first<{
        site_title_value: string | null;
        site_description_value: string | null;
        site_locale_value: string | null;
        site_timezone_value: string | null;
        uptime_rating_level_value: string | null;
        monitor_count_total: number | null;
        max_updated_at: number | null;
        has_active_incidents: number | null;
        has_resolved_incident_preview: number | null;
        has_active_maintenance: number | null;
        has_upcoming_maintenance: number | null;
        has_maintenance_history_preview: number | null;
      }>(),
  );

  return withTraceSync(trace, 'homepage_refresh_fast_guard_normalize', () => ({
    settings: normalizeHomepageFastGuardSettings({
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
    hasResolvedIncidentPreview: (row?.has_resolved_incident_preview ?? 0) > 0,
    hasMaintenanceHistoryPreview: (row?.has_maintenance_history_preview ?? 0) > 0,
  }));
}

export async function tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates(opts: {
  db: D1Database;
  now: number;
  baseSnapshot?: PublicHomepageResponse | null;
  baseSnapshotBodyJson: string | null | undefined;
  updates: MonitorRuntimeUpdate[];
  trace?: Trace;
  onGuardState?: (state: HomepageScheduledFastGuardState) => void;
}): Promise<PublicHomepageResponse | null> {
  const baseSnapshot =
    opts.baseSnapshot ?? parseHomepageSnapshotBodyJson(opts.baseSnapshotBodyJson);
  if (!baseSnapshot || !canPatchHomepageFromRuntime(baseSnapshot)) {
    return null;
  }

  const includeHiddenMonitors = false;
  const guardState = await withTraceAsync(opts.trace, 'homepage_refresh_fast_guard', async () => {
    const cached = await readHomepageGuardCacheState(opts.db, opts.now, opts.trace);
    if (opts.trace?.enabled) {
      opts.trace.setLabel('homepage_guard_state', cached.source);
      if (cached.validUntil !== undefined) {
        opts.trace.setLabel('homepage_guard_valid_until_s', cached.validUntil);
      }
    }
    if (cached.source === 'db_cache') {
      return cached.state;
    }

    if (opts.trace?.enabled) {
      opts.trace.setLabel('homepage_guard_state_refresh_reason', cached.source);
      opts.trace.setLabel('homepage_guard_state', 'refresh');
    }
    const refreshed = await readHomepageScheduledFastGuardState(
      opts.db,
      opts.now,
      includeHiddenMonitors,
      opts.trace,
    );
    if (cached.versions) {
      const validUntil = await computeHomepageGuardValidUntil(opts.db, opts.now);
      if (opts.trace?.enabled) {
        opts.trace.setLabel('homepage_guard_valid_until_s', validUntil);
      }
      await writeHomepageGuardCacheState({
        db: opts.db,
        now: opts.now,
        versions: cached.versions,
        validUntil,
        state: refreshed,
        trace: opts.trace,
      });
    }
    return refreshed;
  });
  opts.onGuardState?.({
    settings: guardState.settings,
    monitorMetadataStamp: guardState.monitorMetadataStamp,
    hasActiveIncidents: guardState.hasActiveIncidents,
    hasActiveMaintenance: guardState.hasActiveMaintenance,
    hasUpcomingMaintenance: guardState.hasUpcomingMaintenance,
  });
  const settings = guardState.settings;

  if (!hasMatchingHomepagePublicSettings(baseSnapshot, settings)) {
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
    guardState.hasResolvedIncidentPreview ||
    guardState.hasMaintenanceHistoryPreview ||
    baseSnapshot.resolved_incident_preview !== null ||
    baseSnapshot.maintenance_history_preview !== null
  ) {
    const historyPreviews = await withTraceAsync(
      opts.trace,
      'homepage_refresh_fast_history_previews',
      async () => await readHomepageHistoryPreviews(opts.db, opts.now, opts.trace),
    );
    if (
      !sameIncidentSummary(
        baseSnapshot.resolved_incident_preview,
        historyPreviews.resolvedIncidentPreview,
      ) ||
      !sameMaintenancePreview(
        baseSnapshot.maintenance_history_preview,
        historyPreviews.maintenanceHistoryPreview,
      )
    ) {
      return null;
    }
  }
  if (
    !hasCompatibleBaseSnapshotMonitorMetadataStamp(baseSnapshot, guardState.monitorMetadataStamp)
  ) {
    return null;
  }

  const patched = withTraceSync(opts.trace, 'homepage_refresh_fast_patch', () =>
    tryPatchPublicHomepagePayloadFromRuntimeUpdates({
      baseSnapshot,
      now: opts.now,
      updates: opts.updates,
    }),
  );
  if (patched) {
    if (opts.trace?.enabled) {
      opts.trace.setLabel('refresh_compute', 'patched_direct');
    }
    return patched;
  }

  const runtimeSnapshot = await withTraceAsync(
    opts.trace,
    'homepage_refresh_fast_runtime_cache',
    async () => await readPublicMonitorRuntimeSnapshot(opts.db, opts.now),
  );
  if (
    !canReuseBaseSnapshotMonitorMetadata({
      baseSnapshot,
      metadataStamp: guardState.monitorMetadataStamp,
      runtimeSnapshot: runtimeSnapshot ?? null,
    })
  ) {
    if (opts.trace?.enabled) {
      opts.trace.setLabel('refresh_compute', 'full_compute_fallback');
    }
    return null;
  }

  const runtimePatched = withTraceSync(opts.trace, 'homepage_refresh_fast_runtime_patch', () =>
    tryPatchPublicHomepagePayloadFromRuntimeSnapshot({
      baseSnapshot,
      runtimeSnapshot,
      now: opts.now,
      updates: opts.updates,
      ...(opts.trace ? { trace: opts.trace } : {}),
    }),
  );
  if (runtimePatched) {
    if (opts.trace?.enabled) {
      opts.trace.setLabel('refresh_compute', 'runtime_snapshot_patch');
    }
    return runtimePatched;
  }

  const monitorData = await withTraceAsync(
    opts.trace,
    'homepage_refresh_fast_monitor_data',
    async () =>
      await buildHomepageMonitorData(opts.db, opts.now, includeHiddenMonitors, {
        uptimeRatingLevel: settings.uptime_rating_level,
        maintenanceMonitorIdsPromise: Promise.resolve(new Set<number>()),
        baseSnapshot,
        runtimeSnapshot,
        monitorMetadataStamp: guardState.monitorMetadataStamp,
        ...(opts.trace ? { trace: opts.trace } : {}),
      }),
  );

  if (opts.trace?.enabled) {
    opts.trace.setLabel('refresh_compute', 'runtime_snapshot');
  }

  return {
    generated_at: opts.now,
    bootstrap_mode: 'full',
    monitor_count_total: monitorData.monitorCountTotal,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: monitorData.uptimeRatingLevel,
    overall_status: monitorData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: monitorData.summary,
      monitorCount: monitorData.monitors.length,
      activeIncidents: [],
      activeMaintenanceWindows: [],
    }),
    summary: monitorData.summary,
    monitors: monitorData.monitors,
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

export async function computePublicHomepagePayload(
  db: D1Database,
  now: number,
  opts: {
    trace?: Trace;
    baseSnapshot?: PublicHomepageResponse | null;
    baseSnapshotBodyJson?: string | null;
    runtimeSnapshot?: PublicMonitorRuntimeSnapshot | null;
    monitorMetadataStamp?: HomepageMonitorMetadataStamp | null;
    trustBaseSnapshotMonitorMetadata?: boolean;
  } = {},
): Promise<PublicHomepageResponse> {
  const trace = opts.trace;
  const includeHiddenMonitors = false;
  const baseSnapshot =
    opts.baseSnapshot ?? parseHomepageSnapshotBodyJson(opts.baseSnapshotBodyJson);
  const settingsPromise = withTraceAsync(
    trace,
    'homepage_settings',
    async () => await readPublicSiteSettings(db),
  );
  const maintenanceWindowsPromise = withTraceAsync(
    trace,
    'homepage_maintenance_windows',
    async () => await listVisibleMaintenanceWindows(db, now, includeHiddenMonitors),
  );

  const [settings, monitorData, activeIncidentSummary, maintenanceWindows, historyPreviews] =
    await Promise.all([
      settingsPromise,
      withTraceAsync(
        trace,
        'homepage_monitor_data',
        async () =>
          await settingsPromise.then((resolvedSettings) =>
            buildHomepageMonitorData(db, now, includeHiddenMonitors, {
              uptimeRatingLevel: resolvedSettings.uptime_rating_level,
              maintenanceMonitorIdsPromise: maintenanceWindowsPromise.then(
                (resolvedMaintenance) => resolvedMaintenance.activeMonitorIds,
              ),
              baseSnapshot,
              ...(opts.monitorMetadataStamp !== undefined
                ? { monitorMetadataStamp: opts.monitorMetadataStamp }
                : {}),
              ...(opts.runtimeSnapshot !== undefined
                ? { runtimeSnapshot: opts.runtimeSnapshot }
                : {}),
              ...(opts.trustBaseSnapshotMonitorMetadata !== undefined
                ? {
                    trustBaseSnapshotMonitorMetadata: opts.trustBaseSnapshotMonitorMetadata,
                  }
                : {}),
              ...(trace ? { trace } : {}),
            }),
          ),
      ),
      withTraceAsync(
        trace,
        'homepage_active_incidents',
        async () => await readVisibleActiveIncidentSummary(db, includeHiddenMonitors),
      ),
      maintenanceWindowsPromise,
      withTraceAsync(
        trace,
        'homepage_history_previews',
        async () => await readHomepageHistoryPreviews(db, now, trace),
      ),
    ]);

  const activeIncidents = activeIncidentSummary.items;
  const activeIncidentSummaries = withTraceSync(trace, 'homepage_present_incidents', () => {
    const summaries = new Array<IncidentSummary>(activeIncidents.length);
    for (let index = 0; index < activeIncidents.length; index += 1) {
      const incident = activeIncidents[index];
      if (!incident) continue;
      summaries[index] = toIncidentSummary(incident.row);
    }
    return summaries;
  });

  const activeMaintenancePreview = withTraceSync(
    trace,
    'homepage_present_active_maintenance',
    () => {
      const preview = new Array<MaintenancePreview>(maintenanceWindows.active.length);
      for (let index = 0; index < maintenanceWindows.active.length; index += 1) {
        const window = maintenanceWindows.active[index];
        if (!window) continue;
        preview[index] = toMaintenancePreview(window.row, window.monitorIds);
      }
      return preview;
    },
  );

  const upcomingMaintenancePreview = withTraceSync(
    trace,
    'homepage_present_upcoming_maintenance',
    () => {
      const preview = new Array<MaintenancePreview>(maintenanceWindows.upcoming.length);
      for (let index = 0; index < maintenanceWindows.upcoming.length; index += 1) {
        const window = maintenanceWindows.upcoming[index];
        if (!window) continue;
        preview[index] = toMaintenancePreview(window.row, window.monitorIds);
      }
      return preview;
    },
  );

  return {
    generated_at: now,
    bootstrap_mode: 'full',
    monitor_count_total: monitorData.monitorCountTotal,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: monitorData.uptimeRatingLevel,
    overall_status: monitorData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: monitorData.summary,
      monitorCount: monitorData.monitors.length,
      activeIncidents,
      activeMaintenanceWindows: maintenanceWindows.active,
      bannerIncident: activeIncidentSummary.bannerIncident,
    }),
    summary: monitorData.summary,
    monitors: monitorData.monitors,
    active_incidents: activeIncidentSummaries,
    maintenance_windows: {
      active: activeMaintenancePreview,
      upcoming: upcomingMaintenancePreview,
    },
    resolved_incident_preview: historyPreviews.resolvedIncidentPreview,
    maintenance_history_preview: historyPreviews.maintenanceHistoryPreview,
  };
}

export async function computePublicHomepageArtifactPayload(
  db: D1Database,
  now: number,
): Promise<PublicHomepageResponse> {
  const includeHiddenMonitors = false;
  const settingsPromise = readPublicSiteSettings(db);
  const bootstrapRowsPromise = listHomepageMonitorRows(db, includeHiddenMonitors);
  const maintenanceWindowsPromise = listVisibleMaintenanceWindows(db, now, includeHiddenMonitors);
  const [
    settings,
    summaryData,
    bootstrapRows,
    activeIncidentSummary,
    maintenanceWindows,
    historyPreviews,
  ] = await Promise.all([
    settingsPromise,
    readHomepageMonitorSummary(db, now, includeHiddenMonitors),
    bootstrapRowsPromise,
    readVisibleActiveIncidentSummary(db, includeHiddenMonitors),
    maintenanceWindowsPromise,
    readHomepageHistoryPreviews(db, now),
  ]);
  const maintenanceMonitorIds = maintenanceWindows.activeMonitorIds;
  const activeIncidents = activeIncidentSummary.items;
  const monitors = await buildHomepageMonitorCardsFromRows(
    db,
    now,
    bootstrapRows,
    maintenanceMonitorIds,
    undefined,
    undefined,
  );

  return {
    generated_at: now,
    bootstrap_mode: 'full',
    monitor_count_total: summaryData.monitorCountTotal,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: settings.uptime_rating_level,
    overall_status: summaryData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: summaryData.summary,
      monitorCount: summaryData.monitorCountTotal,
      activeIncidents,
      activeMaintenanceWindows: maintenanceWindows.active,
      bannerIncident: activeIncidentSummary.bannerIncident,
    }),
    summary: summaryData.summary,
    monitors,
    active_incidents: activeIncidents.map(({ row }) => toIncidentSummary(row)),
    maintenance_windows: {
      active: maintenanceWindows.active.map(({ row, monitorIds }) =>
        toMaintenancePreview(row, monitorIds),
      ),
      upcoming: maintenanceWindows.upcoming.map(({ row, monitorIds }) =>
        toMaintenancePreview(row, monitorIds),
      ),
    },
    resolved_incident_preview: historyPreviews.resolvedIncidentPreview,
    maintenance_history_preview: historyPreviews.maintenanceHistoryPreview,
  };
}
