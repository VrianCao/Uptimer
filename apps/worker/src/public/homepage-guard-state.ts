import { z } from 'zod';

import type { Trace } from '../observability/trace';
import { maintenanceWindowStatusPageVisibilityPredicate } from './visibility';

const SETTINGS_KEY = 'homepage:settings';
const MONITOR_METADATA_KEY = 'homepage:monitor-metadata';
const INCIDENTS_KEY = 'homepage:incidents';
const MAINTENANCE_KEY = 'homepage:maintenance';
const GUARD_KEY = 'homepage:guard';
const HOMEPAGE_GUARD_MAX_VALID_SECONDS = 900;

export const HOMEPAGE_GUARD_COMPONENT_KEYS = {
  settings: SETTINGS_KEY,
  monitorMetadata: MONITOR_METADATA_KEY,
  incidents: INCIDENTS_KEY,
  maintenance: MAINTENANCE_KEY,
} as const;

type HomepageGuardComponentKey =
  | typeof SETTINGS_KEY
  | typeof MONITOR_METADATA_KEY
  | typeof INCIDENTS_KEY
  | typeof MAINTENANCE_KEY;

export type HomepageGuardVersions = {
  settings: number;
  monitorMetadata: number;
  incidents: number;
  maintenance: number;
};

export type CachedHomepageScheduledFastGuardState = {
  settings: {
    site_title: string;
    site_description: string;
    site_locale: 'auto' | 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'es';
    site_timezone: string;
    retention_check_results_days: number;
    state_failures_to_down_from_up: number;
    state_successes_to_up_from_down: number;
    admin_default_overview_range: '24h' | '7d';
    admin_default_monitor_range: '24h' | '7d' | '30d' | '90d';
    uptime_rating_level: 1 | 2 | 3 | 4 | 5;
  };
  monitorMetadataStamp: {
    monitorCountTotal: number;
    maxUpdatedAt: number | null;
  };
  hasActiveIncidents: boolean;
  hasActiveMaintenance: boolean;
  hasUpcomingMaintenance: boolean;
  hasResolvedIncidentPreview: boolean;
  hasMaintenanceHistoryPreview: boolean;
};

export type HomepageGuardCacheReadResult =
  | {
      source: 'db_cache';
      state: CachedHomepageScheduledFastGuardState;
      versions: HomepageGuardVersions;
      validUntil: number;
    }
  | {
      source: 'miss' | 'expired' | 'invalid' | 'version_mismatch' | 'error';
      versions: HomepageGuardVersions | null;
      validUntil?: number;
    };

const homepageGuardStateJsonSchema = z.object({
  schema_version: z.literal(1),
  include_hidden_monitors: z.literal(false),
  generated_at: z.number().int().nonnegative(),
  valid_until: z.number().int().nonnegative(),
  versions: z.object({
    settings: z.number().int().nonnegative(),
    monitor_metadata: z.number().int().nonnegative(),
    incidents: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
  }),
  guard_state: z.object({
    settings: z.object({
      site_title: z.string().max(100),
      site_description: z.string().max(500),
      site_locale: z.enum(['auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'es']),
      site_timezone: z.string().max(64),
      retention_check_results_days: z.number().int().min(1).max(365),
      state_failures_to_down_from_up: z.number().int().min(1).max(10),
      state_successes_to_up_from_down: z.number().int().min(1).max(10),
      admin_default_overview_range: z.enum(['24h', '7d']),
      admin_default_monitor_range: z.enum(['24h', '7d', '30d', '90d']),
      uptime_rating_level: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ]),
    }),
    monitor_metadata_stamp: z.object({
      monitor_count_total: z.number().int().nonnegative(),
      max_updated_at: z.number().int().nonnegative().nullable(),
    }),
    has_active_incidents: z.boolean(),
    has_active_maintenance: z.boolean(),
    has_upcoming_maintenance: z.boolean(),
    has_resolved_incident_preview: z.boolean(),
    has_maintenance_history_preview: z.boolean(),
  }),
});

type HomepageGuardStateJson = z.infer<typeof homepageGuardStateJsonSchema>;

type VersionRow = {
  key: string;
  version: number | null;
  state_json: string | null;
};

const READ_GUARD_ROWS_SQL = `
  SELECT key, version, state_json
  FROM public_snapshot_guard_versions
  WHERE key IN (
    'homepage:settings',
    'homepage:monitor-metadata',
    'homepage:incidents',
    'homepage:maintenance',
    'homepage:guard'
  )
`;

const BUMP_GUARD_VERSION_SQL = `
  INSERT INTO public_snapshot_guard_versions (key, version, updated_at, state_json)
  VALUES (?1, 1, ?2, NULL)
  ON CONFLICT(key) DO UPDATE SET
    version = public_snapshot_guard_versions.version + 1,
    updated_at = excluded.updated_at,
    state_json = NULL
`;

const WRITE_GUARD_STATE_SQL = `
  INSERT INTO public_snapshot_guard_versions (key, version, updated_at, state_json)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(key) DO UPDATE SET
    version = excluded.version,
    updated_at = excluded.updated_at,
    state_json = excluded.state_json
`;

const readGuardRowsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const bumpGuardVersionStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const writeGuardStateStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readNextMaintenanceBoundaryStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

function getReadGuardRowsStatement(db: D1Database): D1PreparedStatement {
  const cached = readGuardRowsStatementByDb.get(db);
  if (cached) return cached;
  const statement = db.prepare(READ_GUARD_ROWS_SQL);
  readGuardRowsStatementByDb.set(db, statement);
  return statement;
}

function getBumpGuardVersionStatement(db: D1Database): D1PreparedStatement {
  const cached = bumpGuardVersionStatementByDb.get(db);
  if (cached) return cached;
  const statement = db.prepare(BUMP_GUARD_VERSION_SQL);
  bumpGuardVersionStatementByDb.set(db, statement);
  return statement;
}

function getWriteGuardStateStatement(db: D1Database): D1PreparedStatement {
  const cached = writeGuardStateStatementByDb.get(db);
  if (cached) return cached;
  const statement = db.prepare(WRITE_GUARD_STATE_SQL);
  writeGuardStateStatementByDb.set(db, statement);
  return statement;
}

function getReadNextMaintenanceBoundaryStatement(db: D1Database): D1PreparedStatement {
  const cached = readNextMaintenanceBoundaryStatementByDb.get(db);
  if (cached) return cached;
  const visibilitySql = maintenanceWindowStatusPageVisibilityPredicate(false);
  const statement = db.prepare(`
    SELECT MIN(boundary_at) AS boundary_at
    FROM (
      SELECT starts_at AS boundary_at
      FROM maintenance_windows
      WHERE starts_at > ?1
        AND ${visibilitySql}
      UNION ALL
      SELECT ends_at AS boundary_at
      FROM maintenance_windows
      WHERE ends_at > ?1
        AND ${visibilitySql}
    )
  `);
  readNextMaintenanceBoundaryStatementByDb.set(db, statement);
  return statement;
}

function versionsFromRows(rows: Map<string, VersionRow>): HomepageGuardVersions {
  return {
    settings: normalizeVersion(rows.get(SETTINGS_KEY)?.version),
    monitorMetadata: normalizeVersion(rows.get(MONITOR_METADATA_KEY)?.version),
    incidents: normalizeVersion(rows.get(INCIDENTS_KEY)?.version),
    maintenance: normalizeVersion(rows.get(MAINTENANCE_KEY)?.version),
  };
}

function normalizeVersion(raw: number | null | undefined): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function sameVersions(a: HomepageGuardVersions, b: HomepageGuardVersions): boolean {
  return (
    a.settings === b.settings &&
    a.monitorMetadata === b.monitorMetadata &&
    a.incidents === b.incidents &&
    a.maintenance === b.maintenance
  );
}

function parseGuardStateJson(raw: string | null | undefined): HomepageGuardStateJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = homepageGuardStateJsonSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function toCachedGuardState(parsed: HomepageGuardStateJson): CachedHomepageScheduledFastGuardState {
  return {
    settings: parsed.guard_state.settings,
    monitorMetadataStamp: {
      monitorCountTotal: parsed.guard_state.monitor_metadata_stamp.monitor_count_total,
      maxUpdatedAt: parsed.guard_state.monitor_metadata_stamp.max_updated_at,
    },
    hasActiveIncidents: parsed.guard_state.has_active_incidents,
    hasActiveMaintenance: parsed.guard_state.has_active_maintenance,
    hasUpcomingMaintenance: parsed.guard_state.has_upcoming_maintenance,
    hasResolvedIncidentPreview: parsed.guard_state.has_resolved_incident_preview,
    hasMaintenanceHistoryPreview: parsed.guard_state.has_maintenance_history_preview,
  };
}

export async function readHomepageGuardCacheState(
  db: D1Database,
  now: number,
  trace?: Trace,
): Promise<HomepageGuardCacheReadResult> {
  const start = Date.now();
  try {
    const { results } = await getReadGuardRowsStatement(db).all<VersionRow>();
    trace?.addSpan('homepage_guard_state_read', Date.now() - start);

    const rows = new Map<string, VersionRow>();
    for (const row of results ?? []) {
      if (row && typeof row.key === 'string') rows.set(row.key, row);
    }

    const versions = versionsFromRows(rows);
    const guardRow = rows.get(GUARD_KEY);
    if (!guardRow?.state_json) return { source: 'miss', versions };

    const parsed = parseGuardStateJson(guardRow.state_json);
    if (!parsed) return { source: 'invalid', versions };
    if (now >= parsed.valid_until) {
      return { source: 'expired', versions, validUntil: parsed.valid_until };
    }

    const guardVersions: HomepageGuardVersions = {
      settings: parsed.versions.settings,
      monitorMetadata: parsed.versions.monitor_metadata,
      incidents: parsed.versions.incidents,
      maintenance: parsed.versions.maintenance,
    };
    if (!sameVersions(guardVersions, versions)) {
      return { source: 'version_mismatch', versions, validUntil: parsed.valid_until };
    }

    return {
      source: 'db_cache',
      state: toCachedGuardState(parsed),
      versions,
      validUntil: parsed.valid_until,
    };
  } catch (err) {
    trace?.addSpan('homepage_guard_state_read', Date.now() - start);
    console.warn('homepage guard state: read failed', err);
    return { source: 'error', versions: null };
  }
}

export async function computeHomepageGuardValidUntil(db: D1Database, now: number): Promise<number> {
  const maxValidUntil = now + HOMEPAGE_GUARD_MAX_VALID_SECONDS;
  try {
    const row = await getReadNextMaintenanceBoundaryStatement(db)
      .bind(now)
      .first<{ boundary_at: number | null }>();
    const boundary = row?.boundary_at;
    if (typeof boundary === 'number' && Number.isInteger(boundary) && boundary > now) {
      return Math.max(now + 1, Math.min(maxValidUntil, boundary));
    }
  } catch (err) {
    console.warn('homepage guard state: maintenance boundary read failed', err);
  }
  return maxValidUntil;
}

export async function writeHomepageGuardCacheState(opts: {
  db: D1Database;
  now: number;
  versions: HomepageGuardVersions;
  validUntil: number;
  state: CachedHomepageScheduledFastGuardState;
  trace?: Trace | undefined;
}): Promise<void> {
  const start = Date.now();
  const body: HomepageGuardStateJson = {
    schema_version: 1,
    include_hidden_monitors: false,
    generated_at: opts.now,
    valid_until: opts.validUntil,
    versions: {
      settings: opts.versions.settings,
      monitor_metadata: opts.versions.monitorMetadata,
      incidents: opts.versions.incidents,
      maintenance: opts.versions.maintenance,
    },
    guard_state: {
      settings: opts.state.settings,
      monitor_metadata_stamp: {
        monitor_count_total: opts.state.monitorMetadataStamp.monitorCountTotal,
        max_updated_at: opts.state.monitorMetadataStamp.maxUpdatedAt,
      },
      has_active_incidents: opts.state.hasActiveIncidents,
      has_active_maintenance: opts.state.hasActiveMaintenance,
      has_upcoming_maintenance: opts.state.hasUpcomingMaintenance,
      has_resolved_incident_preview: opts.state.hasResolvedIncidentPreview,
      has_maintenance_history_preview: opts.state.hasMaintenanceHistoryPreview,
    },
  };

  try {
    await getWriteGuardStateStatement(opts.db)
      .bind(GUARD_KEY, 1, opts.now, JSON.stringify(body))
      .run();
  } catch (err) {
    console.warn('homepage guard state: write failed', err);
  } finally {
    opts.trace?.addSpan('homepage_guard_state_write', Date.now() - start);
  }
}

function uniqueComponentKeys(
  keys: readonly HomepageGuardComponentKey[],
): HomepageGuardComponentKey[] {
  return [...new Set(keys)];
}

export async function bumpHomepageGuardVersions(
  db: D1Database,
  keys: readonly HomepageGuardComponentKey[],
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const uniqueKeys = uniqueComponentKeys(keys);
  if (uniqueKeys.length === 0) return;
  const statement = getBumpGuardVersionStatement(db);
  await db.batch(uniqueKeys.map((key) => statement.bind(key, now)));
}

export async function bumpHomepageSettingsGuardVersion(
  db: D1Database,
  now?: number,
): Promise<void> {
  await bumpHomepageGuardVersions(db, [SETTINGS_KEY], now);
}

export async function bumpHomepageMonitorGuardVersions(
  db: D1Database,
  now?: number,
): Promise<void> {
  await bumpHomepageGuardVersions(db, [MONITOR_METADATA_KEY, INCIDENTS_KEY, MAINTENANCE_KEY], now);
}

export async function bumpHomepageIncidentGuardVersion(
  db: D1Database,
  now?: number,
): Promise<void> {
  await bumpHomepageGuardVersions(db, [INCIDENTS_KEY], now);
}

export async function bumpHomepageMaintenanceGuardVersion(
  db: D1Database,
  now?: number,
): Promise<void> {
  await bumpHomepageGuardVersions(db, [MAINTENANCE_KEY], now);
}
