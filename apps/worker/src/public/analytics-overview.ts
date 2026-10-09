import { z } from 'zod';

import { acquireLease } from '../scheduler/lock';
import { utcDayStart } from './monitor-runtime';

export const PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_KEY = 'analytics-overview';
export const PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_VERSION = 1;

const READ_ANALYTICS_OVERVIEW_SNAPSHOT_SQL = `
  SELECT generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const UPSERT_ANALYTICS_OVERVIEW_SNAPSHOT_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshots.generated_at
`;
const ANALYTICS_OVERVIEW_REFRESH_LOCK_PREFIX = 'snapshot:analytics-overview:';
const ANALYTICS_OVERVIEW_REFRESH_LEASE_SECONDS = 5 * 60;

export type AnalyticsOverviewRange = '30d' | '90d';

export type PublicAnalyticsOverviewTotals = {
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
};

export type PublicAnalyticsOverviewSnapshotEntry = {
  monitor_id: number;
  total_sec_30d: number;
  downtime_sec_30d: number;
  unknown_sec_30d: number;
  uptime_sec_30d: number;
  total_sec_90d: number;
  downtime_sec_90d: number;
  unknown_sec_90d: number;
  uptime_sec_90d: number;
};

export type PublicAnalyticsOverviewSnapshot = {
  version: 1;
  generated_at: number;
  full_day_end_at: number;
  monitors: PublicAnalyticsOverviewSnapshotEntry[];
};

type AnalyticsOverviewSnapshotRow = {
  generated_at: number;
  updated_at?: number | null;
  body_json: string;
};

type AnalyticsOverviewSnapshotCacheEntry = {
  generatedAt: number;
  updatedAt: number;
  snapshot: PublicAnalyticsOverviewSnapshot;
};

type AnalyticsOverviewSnapshotCacheGlobalEntry = AnalyticsOverviewSnapshotCacheEntry & {
  rawBodyJson: string;
};

type AnalyticsOverviewRow = {
  monitor_id: number;
  total_sec_30d: number | null;
  downtime_sec_30d: number | null;
  unknown_sec_30d: number | null;
  uptime_sec_30d: number | null;
  total_sec_90d: number | null;
  downtime_sec_90d: number | null;
  unknown_sec_90d: number | null;
  uptime_sec_90d: number | null;
};

const readAnalyticsOverviewSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertAnalyticsOverviewSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const analyticsOverviewSnapshotCacheByDb = new WeakMap<
  D1Database,
  AnalyticsOverviewSnapshotCacheEntry
>();
const analyticsOverviewEntryMapBySnapshot = new WeakMap<
  PublicAnalyticsOverviewSnapshot,
  ReadonlyMap<number, PublicAnalyticsOverviewSnapshotEntry>
>();
let analyticsOverviewSnapshotCacheGlobal: AnalyticsOverviewSnapshotCacheGlobalEntry | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSnapshotEntry(value: unknown): value is PublicAnalyticsOverviewSnapshotEntry {
  return (
    isRecord(value) &&
    isPositiveInteger(value.monitor_id) &&
    isNonNegativeInteger(value.total_sec_30d) &&
    isNonNegativeInteger(value.downtime_sec_30d) &&
    isNonNegativeInteger(value.unknown_sec_30d) &&
    isNonNegativeInteger(value.uptime_sec_30d) &&
    isNonNegativeInteger(value.total_sec_90d) &&
    isNonNegativeInteger(value.downtime_sec_90d) &&
    isNonNegativeInteger(value.unknown_sec_90d) &&
    isNonNegativeInteger(value.uptime_sec_90d)
  );
}

function isSnapshot(value: unknown): value is PublicAnalyticsOverviewSnapshot {
  return (
    isRecord(value) &&
    value.version === PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_VERSION &&
    isNonNegativeInteger(value.generated_at) &&
    isNonNegativeInteger(value.full_day_end_at) &&
    Array.isArray(value.monitors) &&
    value.monitors.every(isSnapshotEntry)
  );
}

export const publicAnalyticsOverviewSnapshotSchema = z.custom<PublicAnalyticsOverviewSnapshot>(
  isSnapshot,
  'Invalid public analytics overview snapshot',
);

function readAnalyticsOverviewSnapshotStatement(db: D1Database): D1PreparedStatement {
  const cached = readAnalyticsOverviewSnapshotStatementByDb.get(db);
  if (cached) {
    return cached;
  }

  const statement = db.prepare(READ_ANALYTICS_OVERVIEW_SNAPSHOT_SQL);
  readAnalyticsOverviewSnapshotStatementByDb.set(db, statement);
  return statement;
}

function upsertAnalyticsOverviewSnapshotStatement(
  db: D1Database,
  generatedAt: number,
  bodyJson: string,
  now: number,
): D1PreparedStatement {
  const cached = upsertAnalyticsOverviewSnapshotStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_ANALYTICS_OVERVIEW_SNAPSHOT_SQL);
  if (!cached) {
    upsertAnalyticsOverviewSnapshotStatementByDb.set(db, statement);
  }

  return statement.bind(PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_KEY, generatedAt, bodyJson, now);
}

function toSnapshotUpdatedAt(
  row: Pick<AnalyticsOverviewSnapshotRow, 'generated_at' | 'updated_at'>,
): number {
  return typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
    ? row.updated_at
    : row.generated_at;
}

function readCachedSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
): PublicAnalyticsOverviewSnapshot | null {
  const cached = analyticsOverviewSnapshotCacheByDb.get(db);
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt && cached.updatedAt === updatedAt
    ? cached.snapshot
    : null;
}

function writeCachedSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  snapshot: PublicAnalyticsOverviewSnapshot,
): PublicAnalyticsOverviewSnapshot {
  analyticsOverviewSnapshotCacheByDb.set(db, {
    generatedAt,
    updatedAt,
    snapshot,
  });
  return snapshot;
}

function readCachedSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
): PublicAnalyticsOverviewSnapshot | null {
  const cached = analyticsOverviewSnapshotCacheGlobal;
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt &&
    cached.updatedAt === updatedAt &&
    cached.rawBodyJson === rawBodyJson
    ? cached.snapshot
    : null;
}

function writeCachedSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
  snapshot: PublicAnalyticsOverviewSnapshot,
): PublicAnalyticsOverviewSnapshot {
  analyticsOverviewSnapshotCacheGlobal = {
    generatedAt,
    updatedAt,
    rawBodyJson,
    snapshot,
  };
  return snapshot;
}

async function readStoredPublicAnalyticsOverviewSnapshot(
  db: D1Database,
): Promise<{ generatedAt: number; snapshot: PublicAnalyticsOverviewSnapshot } | null> {
  try {
    const row = await readAnalyticsOverviewSnapshotStatement(db)
      .bind(PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_KEY)
      .first<AnalyticsOverviewSnapshotRow>();
    if (!row?.body_json) {
      return null;
    }

    const updatedAt = toSnapshotUpdatedAt(row);
    const cachedSnapshot = readCachedSnapshot(db, row.generated_at, updatedAt);
    if (cachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: cachedSnapshot,
      };
    }

    const globalCachedSnapshot = readCachedSnapshotGlobal(
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (globalCachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: writeCachedSnapshot(db, row.generated_at, updatedAt, globalCachedSnapshot),
      };
    }

    const parsedJson = JSON.parse(row.body_json) as unknown;
    const parsed = publicAnalyticsOverviewSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.warn('analytics overview: invalid snapshot payload', parsed.error.message);
      return null;
    }

    return {
      generatedAt: row.generated_at,
      snapshot: writeCachedSnapshot(
        db,
        row.generated_at,
        updatedAt,
        writeCachedSnapshotGlobal(row.generated_at, updatedAt, row.body_json, parsed.data),
      ),
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('No fake D1 first() handler matched SQL:')) {
      return null;
    }
    console.warn('analytics overview: read failed', err);
    return null;
  }
}

export async function readPublicAnalyticsOverviewSnapshot(
  db: D1Database,
  fullDayEndAt: number,
): Promise<PublicAnalyticsOverviewSnapshot | null> {
  const stored = await readStoredPublicAnalyticsOverviewSnapshot(db);
  if (!stored) {
    return null;
  }
  return stored.snapshot.full_day_end_at === fullDayEndAt ? stored.snapshot : null;
}

export async function writePublicAnalyticsOverviewSnapshot(
  db: D1Database,
  snapshot: PublicAnalyticsOverviewSnapshot,
  now: number,
): Promise<void> {
  const bodyJson = JSON.stringify(snapshot);
  writeCachedSnapshot(db, snapshot.generated_at, now, snapshot);
  writeCachedSnapshotGlobal(snapshot.generated_at, now, bodyJson, snapshot);
  await upsertAnalyticsOverviewSnapshotStatement(db, snapshot.generated_at, bodyJson, now).run();
}

export async function buildPublicAnalyticsOverviewSnapshot(opts: {
  db: D1Database;
  fullDayEndAt: number;
  now: number;
}): Promise<PublicAnalyticsOverviewSnapshot> {
  const range30Start = opts.fullDayEndAt - 30 * 86400;
  const range90Start = opts.fullDayEndAt - 90 * 86400;
  const { results } = await opts.db
    .prepare(
      `
        SELECT
          m.id AS monitor_id,
          COALESCE(SUM(CASE WHEN r.day_start_at >= ?2 THEN r.total_sec ELSE 0 END), 0) AS total_sec_30d,
          COALESCE(SUM(CASE WHEN r.day_start_at >= ?2 THEN r.downtime_sec ELSE 0 END), 0) AS downtime_sec_30d,
          COALESCE(SUM(CASE WHEN r.day_start_at >= ?2 THEN r.unknown_sec ELSE 0 END), 0) AS unknown_sec_30d,
          COALESCE(SUM(CASE WHEN r.day_start_at >= ?2 THEN r.uptime_sec ELSE 0 END), 0) AS uptime_sec_30d,
          COALESCE(SUM(r.total_sec), 0) AS total_sec_90d,
          COALESCE(SUM(r.downtime_sec), 0) AS downtime_sec_90d,
          COALESCE(SUM(r.unknown_sec), 0) AS unknown_sec_90d,
          COALESCE(SUM(r.uptime_sec), 0) AS uptime_sec_90d
        FROM monitors m
        LEFT JOIN monitor_daily_rollups r
          ON r.monitor_id = m.id
         AND r.day_start_at >= ?1
         AND r.day_start_at < ?3
        WHERE m.is_active = 1
        GROUP BY m.id
        ORDER BY m.id
      `,
    )
    .bind(range90Start, range30Start, opts.fullDayEndAt)
    .all<AnalyticsOverviewRow>();

  return {
    version: PUBLIC_ANALYTICS_OVERVIEW_SNAPSHOT_VERSION,
    generated_at: opts.now,
    full_day_end_at: opts.fullDayEndAt,
    monitors: (results ?? []).map((row) => ({
      monitor_id: row.monitor_id,
      total_sec_30d: row.total_sec_30d ?? 0,
      downtime_sec_30d: row.downtime_sec_30d ?? 0,
      unknown_sec_30d: row.unknown_sec_30d ?? 0,
      uptime_sec_30d: row.uptime_sec_30d ?? 0,
      total_sec_90d: row.total_sec_90d ?? 0,
      downtime_sec_90d: row.downtime_sec_90d ?? 0,
      unknown_sec_90d: row.unknown_sec_90d ?? 0,
      uptime_sec_90d: row.uptime_sec_90d ?? 0,
    })),
  };
}

export async function refreshPublicAnalyticsOverviewSnapshotIfNeeded(opts: {
  db: D1Database;
  now: number;
  fullDayEndAt?: number;
  force?: boolean;
}): Promise<boolean> {
  const fullDayEndAt = opts.fullDayEndAt ?? utcDayStart(opts.now);
  if (!opts.force) {
    const existing = await readPublicAnalyticsOverviewSnapshot(opts.db, fullDayEndAt);
    if (existing) {
      return false;
    }
  }

  const acquired = await acquireLease(
    opts.db,
    `${ANALYTICS_OVERVIEW_REFRESH_LOCK_PREFIX}${fullDayEndAt}`,
    opts.now,
    ANALYTICS_OVERVIEW_REFRESH_LEASE_SECONDS,
  );
  if (!acquired) {
    return false;
  }

  if (!opts.force) {
    const existing = await readPublicAnalyticsOverviewSnapshot(opts.db, fullDayEndAt);
    if (existing) {
      return false;
    }
  }

  await writePublicAnalyticsOverviewSnapshot(
    opts.db,
    await buildPublicAnalyticsOverviewSnapshot({
      db: opts.db,
      fullDayEndAt,
      now: opts.now,
    }),
    opts.now,
  );
  return true;
}

export function toPublicAnalyticsOverviewEntryMap(
  snapshot: PublicAnalyticsOverviewSnapshot,
): ReadonlyMap<number, PublicAnalyticsOverviewSnapshotEntry> {
  const cached = analyticsOverviewEntryMapBySnapshot.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Map<number, PublicAnalyticsOverviewSnapshotEntry>();
  for (const entry of snapshot.monitors) {
    next.set(entry.monitor_id, entry);
  }
  analyticsOverviewEntryMapBySnapshot.set(snapshot, next);
  return next;
}

export function analyticsOverviewSnapshotSupportsMonitors(
  snapshot: PublicAnalyticsOverviewSnapshot,
  monitors: ReadonlyArray<{ id: number; created_at: number }>,
): boolean {
  const byMonitorId = toPublicAnalyticsOverviewEntryMap(snapshot);
  for (const monitor of monitors) {
    if (byMonitorId.has(monitor.id)) {
      continue;
    }
    if (monitor.created_at >= snapshot.full_day_end_at) {
      continue;
    }
    return false;
  }
  return true;
}

export function totalsFromAnalyticsOverviewEntry(
  entry: PublicAnalyticsOverviewSnapshotEntry | undefined,
  range: AnalyticsOverviewRange,
): PublicAnalyticsOverviewTotals {
  if (!entry) {
    return {
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
    };
  }

  if (range === '90d') {
    return {
      total_sec: entry.total_sec_90d,
      downtime_sec: entry.downtime_sec_90d,
      unknown_sec: entry.unknown_sec_90d,
      uptime_sec: entry.uptime_sec_90d,
    };
  }

  return {
    total_sec: entry.total_sec_30d,
    downtime_sec: entry.downtime_sec_30d,
    unknown_sec: entry.unknown_sec_30d,
    uptime_sec: entry.uptime_sec_30d,
  };
}
