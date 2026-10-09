import { z } from 'zod';

export const MONITOR_RUNTIME_SNAPSHOT_KEY = 'monitor-runtime';
export const MONITOR_RUNTIME_TOTALS_SNAPSHOT_KEY = 'monitor-runtime:totals';
export const MONITOR_RUNTIME_SNAPSHOT_VERSION = 1;
export const MONITOR_RUNTIME_MAX_AGE_SECONDS = 3 * 60;
export const MONITOR_RUNTIME_HEARTBEAT_POINTS = 60;
const FUTURE_SNAPSHOT_TOLERANCE_SECONDS = 60;

const READ_RUNTIME_SNAPSHOT_SQL = `
  SELECT generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const UPSERT_RUNTIME_SNAPSHOT_ROWS_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  VALUES
    (?1, ?2, ?3, ?4),
    (?5, ?6, ?7, ?8)
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshots.generated_at
    OR public_snapshots.generated_at > ?9
`;

export type MonitorRuntimeStatusCode = 'u' | 'd' | 'm' | 'p' | 'x';

export type PublicMonitorRuntimeEntry = {
  monitor_id: number;
  created_at: number | null;
  interval_sec: number;
  range_start_at: number | null;
  materialized_at: number;
  last_checked_at: number | null;
  last_status_code: MonitorRuntimeStatusCode;
  last_outage_open: boolean;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  heartbeat_gap_sec: string;
  heartbeat_latency_ms: Array<number | null>;
  heartbeat_status_codes: string;
};

export type PublicMonitorRuntimeTotalsEntry = Pick<
  PublicMonitorRuntimeEntry,
  | 'monitor_id'
  | 'interval_sec'
  | 'range_start_at'
  | 'materialized_at'
  | 'last_checked_at'
  | 'last_status_code'
  | 'last_outage_open'
  | 'total_sec'
  | 'downtime_sec'
  | 'unknown_sec'
  | 'uptime_sec'
>;

export type PublicMonitorRuntimeSnapshot = {
  version: 1;
  generated_at: number;
  day_start_at: number;
  monitors: PublicMonitorRuntimeEntry[];
};

export type PublicMonitorRuntimeTotalsSnapshot = {
  version: 1;
  generated_at: number;
  day_start_at: number;
  monitors: PublicMonitorRuntimeTotalsEntry[];
};

export type MonitorRuntimeHeartbeat = {
  checked_at: number;
  latency_ms: number | null;
  status: 'up' | 'down' | 'maintenance' | 'paused' | 'unknown';
};

export type MonitorRuntimeTotals = {
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number | null;
};

export type MonitorRuntimeUpdate = {
  monitor_id: number;
  interval_sec: number;
  created_at: number;
  checked_at: number;
  check_status: 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' | null;
  next_status: 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' | null;
  latency_ms: number | null;
};

export type CompactMonitorRuntimeUpdate = [
  monitor_id: number,
  interval_sec: number,
  created_at: number,
  checked_at: number,
  check_status: MonitorRuntimeUpdate['check_status'],
  next_status: MonitorRuntimeUpdate['next_status'],
  latency_ms: number | null,
];

type MonitorRuntimeUpdateStatus = Exclude<MonitorRuntimeUpdate['check_status'], null>;

const monitorRuntimeUpdateStatusSchema = z
  .enum(['up', 'down', 'maintenance', 'paused', 'unknown'])
  .nullable();
const monitorRuntimeUpdateStatusValues = new Set<MonitorRuntimeUpdateStatus>([
  'up',
  'down',
  'maintenance',
  'paused',
  'unknown',
]);

export function normalizeRuntimeUpdateLatencyMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseMonitorRuntimeUpdateStatus(
  value: unknown,
): MonitorRuntimeUpdateStatus | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return monitorRuntimeUpdateStatusValues.has(value as MonitorRuntimeUpdateStatus)
    ? (value as MonitorRuntimeUpdateStatus)
    : undefined;
}

export function parseMonitorRuntimeUpdate(value: unknown): MonitorRuntimeUpdate | null {
  if (Array.isArray(value)) {
    const [
      monitor_id,
      interval_sec,
      created_at,
      checked_at,
      check_status,
      next_status,
      latency_ms = null,
    ] = value;
    const parsedCheckStatus = parseMonitorRuntimeUpdateStatus(check_status);
    const parsedNextStatus = parseMonitorRuntimeUpdateStatus(next_status);
    if (
      value.length < 6 ||
      value.length > 7 ||
      !isPositiveInteger(monitor_id) ||
      !isPositiveInteger(interval_sec) ||
      !isNonNegativeInteger(created_at) ||
      !isNonNegativeInteger(checked_at) ||
      parsedCheckStatus === undefined ||
      parsedNextStatus === undefined
    ) {
      return null;
    }

    return {
      monitor_id,
      interval_sec,
      created_at,
      checked_at,
      check_status: parsedCheckStatus,
      next_status: parsedNextStatus,
      latency_ms: normalizeRuntimeUpdateLatencyMs(latency_ms),
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const checkStatus = parseMonitorRuntimeUpdateStatus(value.check_status);
  const nextStatus = parseMonitorRuntimeUpdateStatus(value.next_status);
  if (
    !isPositiveInteger(value.monitor_id) ||
    !isPositiveInteger(value.interval_sec) ||
    !isNonNegativeInteger(value.created_at) ||
    !isNonNegativeInteger(value.checked_at) ||
    checkStatus === undefined ||
    nextStatus === undefined
  ) {
    return null;
  }

  return {
    monitor_id: value.monitor_id,
    interval_sec: value.interval_sec,
    created_at: value.created_at,
    checked_at: value.checked_at,
    check_status: checkStatus,
    next_status: nextStatus,
    latency_ms: normalizeRuntimeUpdateLatencyMs(value.latency_ms),
  };
}

export function parseMonitorRuntimeUpdates(value: unknown): MonitorRuntimeUpdate[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const updates = new Array<MonitorRuntimeUpdate>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseMonitorRuntimeUpdate(value[index]);
    if (!parsed) {
      return null;
    }
    updates[index] = parsed;
  }

  return updates;
}

export function encodeMonitorRuntimeUpdatesCompact(
  updates: readonly MonitorRuntimeUpdate[],
): CompactMonitorRuntimeUpdate[] {
  return updates.map((update) => [
    update.monitor_id,
    update.interval_sec,
    update.created_at,
    update.checked_at,
    update.check_status,
    update.next_status,
    update.latency_ms,
  ]);
}

export const monitorRuntimeUpdateSchema = z.object({
  monitor_id: z.number().int().positive(),
  interval_sec: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  checked_at: z.number().int().nonnegative(),
  check_status: monitorRuntimeUpdateStatusSchema,
  next_status: monitorRuntimeUpdateStatusSchema,
  latency_ms: z.preprocess(
    (value) =>
      value === null || value === undefined ? null : normalizeRuntimeUpdateLatencyMs(value),
    z.number().int().nonnegative().nullable(),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHeartbeatGapSec(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const parts = trimmed.split(',');
  const gaps: number[] = [];
  for (const part of parts) {
    const normalized = part.trim().toLowerCase();
    if (!normalized) return [];
    const parsed = Number.parseInt(normalized, 36);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return [];
    }
    gaps.push(parsed);
  }

  return gaps;
}

function encodeHeartbeatGapSec(gaps: number[]): string {
  if (gaps.length === 0) return '';
  return gaps.map((gap) => clampNonNegativeInteger(gap).toString(36)).join(',');
}

function heartbeatsToGapSec(checkedAt: Array<number | null | undefined>): string {
  const gaps: number[] = [];
  for (let index = 1; index < checkedAt.length; index += 1) {
    const newer = checkedAt[index - 1];
    const older = checkedAt[index];
    if (typeof newer !== 'number' || !Number.isInteger(newer)) {
      break;
    }
    if (typeof older !== 'number' || !Number.isInteger(older)) {
      break;
    }
    gaps.push(Math.max(0, newer - older));
  }
  return encodeHeartbeatGapSec(gaps);
}

export function runtimeHeartbeatsToGapSec(checkedAt: Array<number | null | undefined>): string {
  return heartbeatsToGapSec(checkedAt);
}

const runtimeEntrySchema = z
  .preprocess(
    (value) => {
      if (!isRecord(value)) return value;
      if (typeof value.heartbeat_gap_sec === 'string') {
        return value;
      }

      const legacyCheckedAt = value.heartbeat_checked_at;
      if (!Array.isArray(legacyCheckedAt)) {
        return value;
      }

      return {
        ...value,
        heartbeat_gap_sec: runtimeHeartbeatsToGapSec(
          legacyCheckedAt.filter((item): item is number => Number.isInteger(item)),
        ),
      };
    },
    z.object({
      monitor_id: z.number().int().positive(),
      created_at: z.number().int().nonnegative().nullable().optional().default(null),
      interval_sec: z.number().int().positive(),
      range_start_at: z.number().int().nonnegative().nullable(),
      materialized_at: z.number().int().nonnegative(),
      last_checked_at: z.number().int().nonnegative().nullable(),
      last_status_code: z.enum(['u', 'd', 'm', 'p', 'x']),
      last_outage_open: z.boolean(),
      total_sec: z.number().int().nonnegative(),
      downtime_sec: z.number().int().nonnegative(),
      unknown_sec: z.number().int().nonnegative(),
      uptime_sec: z.number().int().nonnegative(),
      heartbeat_gap_sec: z.string(),
      heartbeat_latency_ms: z
        .array(z.number().int().nonnegative().nullable())
        .max(MONITOR_RUNTIME_HEARTBEAT_POINTS),
      heartbeat_status_codes: z.string().max(MONITOR_RUNTIME_HEARTBEAT_POINTS),
    }),
  )
  .superRefine((value, ctx) => {
    const count = value.heartbeat_latency_ms.length;
    if (value.heartbeat_latency_ms.length !== count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'heartbeat latency length mismatch',
      });
    }
    if (value.heartbeat_status_codes.length !== count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'heartbeat status code length mismatch',
      });
    }
    for (let index = 0; index < value.heartbeat_status_codes.length; index += 1) {
      const code = value.heartbeat_status_codes[index];
      if (code !== 'u' && code !== 'd' && code !== 'm' && code !== 'p' && code !== 'x') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid heartbeat status code at ${index}`,
        });
        break;
      }
    }
    const gaps = parseHeartbeatGapSec(value.heartbeat_gap_sec);
    if (value.heartbeat_gap_sec.trim().length > 0 && gaps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'invalid heartbeat gap encoding',
      });
      return;
    }
    if (gaps.length !== Math.max(0, count - 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'heartbeat gap length mismatch',
      });
    }
    if (count > 0 && value.last_checked_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'missing last_checked_at for heartbeat strip',
      });
    }
  });

export function parsePublicMonitorRuntimeEntry(value: unknown): PublicMonitorRuntimeEntry | null {
  const parsed = runtimeEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isRuntimeStatusCode(value: unknown): value is MonitorRuntimeStatusCode {
  return value === 'u' || value === 'd' || value === 'm' || value === 'p' || value === 'x';
}

function isPublicMonitorRuntimeTotalsEntry(
  value: unknown,
): value is PublicMonitorRuntimeTotalsEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isPositiveInteger(value.monitor_id) &&
    isPositiveInteger(value.interval_sec) &&
    isNullableNonNegativeInteger(value.range_start_at) &&
    isNonNegativeInteger(value.materialized_at) &&
    isNullableNonNegativeInteger(value.last_checked_at) &&
    isRuntimeStatusCode(value.last_status_code) &&
    typeof value.last_outage_open === 'boolean' &&
    isNonNegativeInteger(value.total_sec) &&
    isNonNegativeInteger(value.downtime_sec) &&
    isNonNegativeInteger(value.unknown_sec) &&
    isNonNegativeInteger(value.uptime_sec)
  );
}

function isPublicMonitorRuntimeTotalsSnapshot(
  value: unknown,
): value is PublicMonitorRuntimeTotalsSnapshot {
  return (
    isRecord(value) &&
    value.version === MONITOR_RUNTIME_SNAPSHOT_VERSION &&
    isNonNegativeInteger(value.generated_at) &&
    isNonNegativeInteger(value.day_start_at) &&
    Array.isArray(value.monitors) &&
    value.monitors.every(isPublicMonitorRuntimeTotalsEntry)
  );
}

const MAX_CACHED_RUNTIME_ENTRY_JSON_TEXTS = 512;
const runtimeEntryByJsonText = new Map<string, PublicMonitorRuntimeEntry | null>();

function writeCachedRuntimeEntryByJsonText(
  jsonText: string,
  entry: PublicMonitorRuntimeEntry | null,
): PublicMonitorRuntimeEntry | null {
  if (runtimeEntryByJsonText.size >= MAX_CACHED_RUNTIME_ENTRY_JSON_TEXTS) {
    runtimeEntryByJsonText.clear();
  }
  runtimeEntryByJsonText.set(jsonText, entry);
  return entry;
}

export function parsePublicMonitorRuntimeEntryJson(
  jsonText: string | null | undefined,
): PublicMonitorRuntimeEntry | null {
  if (typeof jsonText !== 'string') {
    return null;
  }

  const trimmed = jsonText.trim();
  if (!trimmed) {
    return null;
  }

  if (runtimeEntryByJsonText.has(trimmed)) {
    return runtimeEntryByJsonText.get(trimmed) ?? null;
  }

  try {
    return writeCachedRuntimeEntryByJsonText(
      trimmed,
      parsePublicMonitorRuntimeEntry(JSON.parse(trimmed) as unknown),
    );
  } catch {
    return writeCachedRuntimeEntryByJsonText(trimmed, null);
  }
}

export const publicMonitorRuntimeSnapshotSchema = z.object({
  version: z.literal(MONITOR_RUNTIME_SNAPSHOT_VERSION),
  generated_at: z.number().int().nonnegative(),
  day_start_at: z.number().int().nonnegative(),
  monitors: z.array(runtimeEntrySchema),
});

export const publicMonitorRuntimeTotalsSnapshotSchema =
  z.custom<PublicMonitorRuntimeTotalsSnapshot>(
    isPublicMonitorRuntimeTotalsSnapshot,
    'Invalid public monitor runtime totals snapshot',
  );

const readRuntimeSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertRuntimeSnapshotRowsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const runtimeSnapshotCacheByDb = new WeakMap<D1Database, RuntimeSnapshotCacheEntry>();
const runtimeTotalsSnapshotCacheByDb = new WeakMap<D1Database, RuntimeTotalsSnapshotCacheEntry>();
const runtimeSnapshotMonitorIdsBySnapshot = new WeakMap<
  PublicMonitorRuntimeSnapshot,
  ReadonlySet<number>
>();
const runtimeTotalsSnapshotMonitorIdsBySnapshot = new WeakMap<
  PublicMonitorRuntimeTotalsSnapshot,
  ReadonlySet<number>
>();
const runtimeSnapshotEntryMapBySnapshot = new WeakMap<
  PublicMonitorRuntimeSnapshot,
  ReadonlyMap<number, PublicMonitorRuntimeEntry>
>();
const runtimeTotalsSnapshotEntryMapBySnapshot = new WeakMap<
  PublicMonitorRuntimeTotalsSnapshot,
  ReadonlyMap<number, PublicMonitorRuntimeTotalsEntry>
>();
const runtimeEntryHeartbeatsByEntry = new WeakMap<
  PublicMonitorRuntimeEntry,
  MonitorRuntimeHeartbeat[]
>();
let runtimeSnapshotCacheGlobal: RuntimeSnapshotCacheGlobalEntry | null = null;
let runtimeTotalsSnapshotCacheGlobal: RuntimeTotalsSnapshotCacheGlobalEntry | null = null;

type RuntimeSnapshotRow = {
  generated_at: number;
  updated_at?: number | null;
  body_json: string;
};

type RuntimeSnapshotCacheEntry = {
  generatedAt: number;
  updatedAt: number;
  rawBodyJson: string;
  snapshot: PublicMonitorRuntimeSnapshot;
};

type RuntimeTotalsSnapshotCacheEntry = {
  generatedAt: number;
  updatedAt: number;
  rawBodyJson: string;
  snapshot: PublicMonitorRuntimeTotalsSnapshot;
};

type RuntimeSnapshotCacheGlobalEntry = RuntimeSnapshotCacheEntry & {
  rawBodyJson: string;
};

type RuntimeTotalsSnapshotCacheGlobalEntry = RuntimeTotalsSnapshotCacheEntry & {
  rawBodyJson: string;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function utcDayStart(timestampSec: number): number {
  return Math.floor(timestampSec / 86400) * 86400;
}

export function toRuntimeStatusCode(value: string | null | undefined): MonitorRuntimeStatusCode {
  switch (value) {
    case 'up':
      return 'u';
    case 'down':
      return 'd';
    case 'maintenance':
      return 'm';
    case 'paused':
      return 'p';
    case 'unknown':
    default:
      return 'x';
  }
}

export function fromRuntimeStatusCode(
  value: MonitorRuntimeStatusCode,
): MonitorRuntimeHeartbeat['status'] {
  switch (value) {
    case 'u':
      return 'up';
    case 'd':
      return 'down';
    case 'm':
      return 'maintenance';
    case 'p':
      return 'paused';
    case 'x':
    default:
      return 'unknown';
  }
}

function toRuntimeCurrentStatusCode(update: MonitorRuntimeUpdate): MonitorRuntimeStatusCode {
  return toRuntimeStatusCode(update.next_status ?? update.check_status);
}

function readRuntimeSnapshotStatement(db: D1Database): D1PreparedStatement {
  const cached = readRuntimeSnapshotStatementByDb.get(db);
  if (cached) return cached;

  const statement = db.prepare(READ_RUNTIME_SNAPSHOT_SQL);
  readRuntimeSnapshotStatementByDb.set(db, statement);
  return statement;
}

function upsertRuntimeSnapshotRowsStatement(
  db: D1Database,
  snapshot: PublicMonitorRuntimeSnapshot,
  totalsSnapshot: PublicMonitorRuntimeTotalsSnapshot,
  now: number,
): D1PreparedStatement {
  const cached = upsertRuntimeSnapshotRowsStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_RUNTIME_SNAPSHOT_ROWS_SQL);
  if (!cached) {
    upsertRuntimeSnapshotRowsStatementByDb.set(db, statement);
  }

  return statement.bind(
    MONITOR_RUNTIME_SNAPSHOT_KEY,
    snapshot.generated_at,
    JSON.stringify(snapshot),
    now,
    MONITOR_RUNTIME_TOTALS_SNAPSHOT_KEY,
    totalsSnapshot.generated_at,
    JSON.stringify(totalsSnapshot),
    now,
    now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
  );
}

function toSnapshotUpdatedAt(row: Pick<RuntimeSnapshotRow, 'generated_at' | 'updated_at'>): number {
  return typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
    ? row.updated_at
    : row.generated_at;
}

function readCachedRuntimeSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
): PublicMonitorRuntimeSnapshot | null {
  const cached = runtimeSnapshotCacheByDb.get(db);
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt &&
    cached.updatedAt === updatedAt &&
    cached.rawBodyJson === rawBodyJson
    ? cached.snapshot
    : null;
}

function writeCachedRuntimeSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
  snapshot: PublicMonitorRuntimeSnapshot,
): PublicMonitorRuntimeSnapshot {
  runtimeSnapshotCacheByDb.set(db, {
    generatedAt,
    updatedAt,
    rawBodyJson,
    snapshot,
  });
  return snapshot;
}

function readCachedRuntimeTotalsSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
): PublicMonitorRuntimeTotalsSnapshot | null {
  const cached = runtimeTotalsSnapshotCacheByDb.get(db);
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt &&
    cached.updatedAt === updatedAt &&
    cached.rawBodyJson === rawBodyJson
    ? cached.snapshot
    : null;
}

function writeCachedRuntimeTotalsSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
): PublicMonitorRuntimeTotalsSnapshot {
  runtimeTotalsSnapshotCacheByDb.set(db, {
    generatedAt,
    updatedAt,
    rawBodyJson,
    snapshot,
  });
  return snapshot;
}

function readCachedRuntimeSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
): PublicMonitorRuntimeSnapshot | null {
  const cached = runtimeSnapshotCacheGlobal;
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt &&
    cached.updatedAt === updatedAt &&
    cached.rawBodyJson === rawBodyJson
    ? cached.snapshot
    : null;
}

function writeCachedRuntimeSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
  snapshot: PublicMonitorRuntimeSnapshot,
): PublicMonitorRuntimeSnapshot {
  runtimeSnapshotCacheGlobal = {
    generatedAt,
    updatedAt,
    rawBodyJson,
    snapshot,
  };
  return snapshot;
}

function readCachedRuntimeTotalsSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
): PublicMonitorRuntimeTotalsSnapshot | null {
  const cached = runtimeTotalsSnapshotCacheGlobal;
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt &&
    cached.updatedAt === updatedAt &&
    cached.rawBodyJson === rawBodyJson
    ? cached.snapshot
    : null;
}

function writeCachedRuntimeTotalsSnapshotGlobal(
  generatedAt: number,
  updatedAt: number,
  rawBodyJson: string,
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
): PublicMonitorRuntimeTotalsSnapshot {
  runtimeTotalsSnapshotCacheGlobal = {
    generatedAt,
    updatedAt,
    rawBodyJson,
    snapshot,
  };
  return snapshot;
}

function readSnapshotMonitorIds(snapshot: PublicMonitorRuntimeSnapshot): ReadonlySet<number> {
  const cached = runtimeSnapshotMonitorIdsBySnapshot.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Set<number>();
  for (const entry of snapshot.monitors) {
    next.add(entry.monitor_id);
  }
  runtimeSnapshotMonitorIdsBySnapshot.set(snapshot, next);
  return next;
}

function readSnapshotEntryMap(
  snapshot: PublicMonitorRuntimeSnapshot,
): ReadonlyMap<number, PublicMonitorRuntimeEntry> {
  const cached = runtimeSnapshotEntryMapBySnapshot.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Map<number, PublicMonitorRuntimeEntry>();
  for (const entry of snapshot.monitors) {
    next.set(entry.monitor_id, entry);
  }
  runtimeSnapshotEntryMapBySnapshot.set(snapshot, next);
  return next;
}

function readTotalsSnapshotMonitorIds(
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
): ReadonlySet<number> {
  const cached = runtimeTotalsSnapshotMonitorIdsBySnapshot.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Set<number>();
  for (const entry of snapshot.monitors) {
    next.add(entry.monitor_id);
  }
  runtimeTotalsSnapshotMonitorIdsBySnapshot.set(snapshot, next);
  return next;
}

function readTotalsSnapshotEntryMap(
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
): ReadonlyMap<number, PublicMonitorRuntimeTotalsEntry> {
  const cached = runtimeTotalsSnapshotEntryMapBySnapshot.get(snapshot);
  if (cached) {
    return cached;
  }

  const next = new Map<number, PublicMonitorRuntimeTotalsEntry>();
  for (const entry of snapshot.monitors) {
    next.set(entry.monitor_id, entry);
  }
  runtimeTotalsSnapshotEntryMapBySnapshot.set(snapshot, next);
  return next;
}

async function readStoredMonitorRuntimeSnapshot(
  db: D1Database,
): Promise<{ generatedAt: number; snapshot: PublicMonitorRuntimeSnapshot } | null> {
  try {
    const row = await readRuntimeSnapshotStatement(db)
      .bind(MONITOR_RUNTIME_SNAPSHOT_KEY)
      .first<RuntimeSnapshotRow>();
    if (!row?.body_json) return null;

    const updatedAt = toSnapshotUpdatedAt(row);
    const cachedSnapshot = readCachedRuntimeSnapshot(
      db,
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (cachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: cachedSnapshot,
      };
    }

    const globalCachedSnapshot = readCachedRuntimeSnapshotGlobal(
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (globalCachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: writeCachedRuntimeSnapshot(
          db,
          row.generated_at,
          updatedAt,
          row.body_json,
          globalCachedSnapshot,
        ),
      };
    }

    const parsedJson = JSON.parse(row.body_json) as unknown;
    const parsed = publicMonitorRuntimeSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.warn('monitor runtime: invalid snapshot payload', parsed.error.message);
      return null;
    }

    return {
      generatedAt: row.generated_at,
      snapshot: writeCachedRuntimeSnapshot(
        db,
        row.generated_at,
        updatedAt,
        row.body_json,
        writeCachedRuntimeSnapshotGlobal(row.generated_at, updatedAt, row.body_json, parsed.data),
      ),
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('No fake D1 first() handler matched SQL:')) {
      return null;
    }
    console.warn('monitor runtime: read failed', err);
    return null;
  }
}

async function readStoredMonitorRuntimeTotalsSnapshot(
  db: D1Database,
): Promise<{ generatedAt: number; snapshot: PublicMonitorRuntimeTotalsSnapshot } | null> {
  try {
    const row = await readRuntimeSnapshotStatement(db)
      .bind(MONITOR_RUNTIME_TOTALS_SNAPSHOT_KEY)
      .first<RuntimeSnapshotRow>();
    if (!row?.body_json) {
      return await readStoredMonitorRuntimeTotalsSnapshotFromFullSnapshot(db);
    }

    const updatedAt = toSnapshotUpdatedAt(row);
    const cachedSnapshot = readCachedRuntimeTotalsSnapshot(
      db,
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (cachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: cachedSnapshot,
      };
    }

    const globalCachedSnapshot = readCachedRuntimeTotalsSnapshotGlobal(
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (globalCachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: writeCachedRuntimeTotalsSnapshot(
          db,
          row.generated_at,
          updatedAt,
          row.body_json,
          globalCachedSnapshot,
        ),
      };
    }

    const parsedJson = JSON.parse(row.body_json) as unknown;
    const parsed = publicMonitorRuntimeTotalsSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.warn('monitor runtime totals: invalid snapshot payload', parsed.error.message);
      return await readStoredMonitorRuntimeTotalsSnapshotFromFullSnapshot(db);
    }

    return {
      generatedAt: row.generated_at,
      snapshot: writeCachedRuntimeTotalsSnapshot(
        db,
        row.generated_at,
        updatedAt,
        row.body_json,
        writeCachedRuntimeTotalsSnapshotGlobal(
          row.generated_at,
          updatedAt,
          row.body_json,
          parsed.data,
        ),
      ),
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('No fake D1 first() handler matched SQL:')) {
      return await readStoredMonitorRuntimeTotalsSnapshotFromFullSnapshot(db);
    }
    console.warn('monitor runtime totals: read failed', err);
    return await readStoredMonitorRuntimeTotalsSnapshotFromFullSnapshot(db);
  }
}

async function readStoredMonitorRuntimeTotalsSnapshotFromFullSnapshot(
  db: D1Database,
): Promise<{ generatedAt: number; snapshot: PublicMonitorRuntimeTotalsSnapshot } | null> {
  try {
    const row = await readRuntimeSnapshotStatement(db)
      .bind(MONITOR_RUNTIME_SNAPSHOT_KEY)
      .first<RuntimeSnapshotRow>();
    if (!row?.body_json) return null;

    const updatedAt = toSnapshotUpdatedAt(row);
    const cachedSnapshot = readCachedRuntimeTotalsSnapshot(
      db,
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (cachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: cachedSnapshot,
      };
    }

    const globalCachedSnapshot = readCachedRuntimeTotalsSnapshotGlobal(
      row.generated_at,
      updatedAt,
      row.body_json,
    );
    if (globalCachedSnapshot) {
      return {
        generatedAt: row.generated_at,
        snapshot: writeCachedRuntimeTotalsSnapshot(
          db,
          row.generated_at,
          updatedAt,
          row.body_json,
          globalCachedSnapshot,
        ),
      };
    }

    const parsedJson = JSON.parse(row.body_json) as unknown;
    const parsed = publicMonitorRuntimeTotalsSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.warn('monitor runtime totals: invalid full snapshot payload', parsed.error.message);
      return null;
    }

    return {
      generatedAt: row.generated_at,
      snapshot: writeCachedRuntimeTotalsSnapshot(
        db,
        row.generated_at,
        updatedAt,
        row.body_json,
        writeCachedRuntimeTotalsSnapshotGlobal(
          row.generated_at,
          updatedAt,
          row.body_json,
          parsed.data,
        ),
      ),
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('No fake D1 first() handler matched SQL:')) {
      return null;
    }
    console.warn('monitor runtime totals: fallback read failed', err);
    return null;
  }
}

export async function readPublicMonitorRuntimeSnapshot(
  db: D1Database,
  now: number,
  maxAgeSeconds = MONITOR_RUNTIME_MAX_AGE_SECONDS,
): Promise<PublicMonitorRuntimeSnapshot | null> {
  const stored = await readStoredMonitorRuntimeSnapshot(db);
  if (!stored) return null;
  if (stored.generatedAt > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) {
    return null;
  }

  const age = Math.max(0, now - stored.generatedAt);
  if (age > maxAgeSeconds) {
    return null;
  }

  const dayStart = utcDayStart(now);
  if (stored.snapshot.day_start_at !== dayStart) {
    return null;
  }

  return stored.snapshot;
}

export async function readPublicMonitorRuntimeTotalsSnapshot(
  db: D1Database,
  now: number,
  maxAgeSeconds = MONITOR_RUNTIME_MAX_AGE_SECONDS,
): Promise<PublicMonitorRuntimeTotalsSnapshot | null> {
  const stored = await readStoredMonitorRuntimeTotalsSnapshot(db);
  if (!stored) return null;
  if (stored.generatedAt > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) {
    return null;
  }

  const age = Math.max(0, now - stored.generatedAt);
  if (age > maxAgeSeconds) {
    return null;
  }

  const dayStart = utcDayStart(now);
  if (stored.snapshot.day_start_at !== dayStart) {
    return null;
  }

  return stored.snapshot;
}

export async function writePublicMonitorRuntimeSnapshot(
  db: D1Database,
  snapshot: PublicMonitorRuntimeSnapshot,
  now: number,
): Promise<void> {
  const totalsSnapshot = {
    version: snapshot.version,
    generated_at: snapshot.generated_at,
    day_start_at: snapshot.day_start_at,
    monitors: snapshot.monitors.map(
      ({
        monitor_id,
        interval_sec,
        range_start_at,
        materialized_at,
        last_checked_at,
        last_status_code,
        last_outage_open,
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
      }) => ({
        monitor_id,
        interval_sec,
        range_start_at,
        materialized_at,
        last_checked_at,
        last_status_code,
        last_outage_open,
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
      }),
    ),
  } satisfies PublicMonitorRuntimeTotalsSnapshot;
  const bodyJson = JSON.stringify(snapshot);
  const totalsBodyJson = JSON.stringify(totalsSnapshot);
  const writeNow = Math.max(now, Math.floor(Date.now() / 1000));
  writeCachedRuntimeSnapshot(db, snapshot.generated_at, writeNow, bodyJson, snapshot);
  writeCachedRuntimeSnapshotGlobal(snapshot.generated_at, writeNow, bodyJson, snapshot);
  writeCachedRuntimeTotalsSnapshot(
    db,
    totalsSnapshot.generated_at,
    writeNow,
    totalsBodyJson,
    totalsSnapshot,
  );
  writeCachedRuntimeTotalsSnapshotGlobal(
    totalsSnapshot.generated_at,
    writeNow,
    totalsBodyJson,
    totalsSnapshot,
  );
  await upsertRuntimeSnapshotRowsStatement(db, snapshot, totalsSnapshot, writeNow).run();
}

export function snapshotHasMonitorIds(
  snapshot: PublicMonitorRuntimeSnapshot,
  monitorIds: number[],
): boolean {
  if (monitorIds.length === 0) return true;
  if (monitorIds.length > snapshot.monitors.length) {
    return false;
  }

  const seen = readSnapshotMonitorIds(snapshot);
  for (const monitorId of monitorIds) {
    if (!seen.has(monitorId)) {
      return false;
    }
  }
  return true;
}

export function toMonitorRuntimeEntryMap(
  snapshot: PublicMonitorRuntimeSnapshot,
): ReadonlyMap<number, PublicMonitorRuntimeEntry> {
  return readSnapshotEntryMap(snapshot);
}

export function totalsSnapshotHasMonitorIds(
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
  monitorIds: number[],
): boolean {
  if (monitorIds.length === 0) return true;
  if (monitorIds.length > snapshot.monitors.length) {
    return false;
  }

  const seen = readTotalsSnapshotMonitorIds(snapshot);
  for (const monitorId of monitorIds) {
    if (!seen.has(monitorId)) {
      return false;
    }
  }
  return true;
}

export function toMonitorRuntimeTotalsEntryMap(
  snapshot: PublicMonitorRuntimeTotalsSnapshot,
): ReadonlyMap<number, PublicMonitorRuntimeTotalsEntry> {
  return readTotalsSnapshotEntryMap(snapshot);
}

function computeSegmentTotals(opts: {
  segmentStart: number;
  segmentEnd: number;
  lastCheckedAt: number | null;
  lastStatusCode: MonitorRuntimeStatusCode;
  lastOutageOpen: boolean;
  intervalSec: number;
}): { totalSec: number; downtimeSec: number; unknownSec: number; uptimeSec: number } {
  const segmentStart = clampNonNegativeInteger(opts.segmentStart);
  const segmentEnd = clampNonNegativeInteger(opts.segmentEnd);
  if (segmentEnd <= segmentStart) {
    return {
      totalSec: 0,
      downtimeSec: 0,
      unknownSec: 0,
      uptimeSec: 0,
    };
  }

  const totalSec = segmentEnd - segmentStart;
  if (opts.lastOutageOpen) {
    return {
      totalSec,
      downtimeSec: totalSec,
      unknownSec: 0,
      uptimeSec: 0,
    };
  }

  if (!isFiniteNumber(opts.lastCheckedAt)) {
    return {
      totalSec,
      downtimeSec: 0,
      unknownSec: totalSec,
      uptimeSec: 0,
    };
  }

  if (opts.lastStatusCode === 'x') {
    return {
      totalSec,
      downtimeSec: 0,
      unknownSec: totalSec,
      uptimeSec: 0,
    };
  }

  const validUntil = opts.lastCheckedAt + Math.max(0, opts.intervalSec) * 2;
  const unknownStart = Math.max(segmentStart, validUntil);
  const unknownSec = segmentEnd > unknownStart ? segmentEnd - unknownStart : 0;

  return {
    totalSec,
    downtimeSec: 0,
    unknownSec,
    uptimeSec: totalSec - unknownSec,
  };
}

function cloneRuntimeEntry(entry: PublicMonitorRuntimeEntry): PublicMonitorRuntimeEntry {
  return {
    ...entry,
    heartbeat_latency_ms: [...entry.heartbeat_latency_ms],
  };
}

function createRuntimeEntryForUpdate(
  update: MonitorRuntimeUpdate,
  dayStart: number,
): PublicMonitorRuntimeEntry {
  const createdToday =
    Number.isFinite(update.created_at) &&
    update.created_at >= dayStart &&
    update.created_at <= update.checked_at;

  return {
    monitor_id: update.monitor_id,
    created_at: clampNonNegativeInteger(update.created_at),
    interval_sec: Math.max(1, clampNonNegativeInteger(update.interval_sec)),
    range_start_at: createdToday ? update.checked_at : dayStart,
    materialized_at: update.checked_at,
    last_checked_at: update.checked_at,
    last_status_code: toRuntimeCurrentStatusCode(update),
    last_outage_open: update.next_status === 'down',
    total_sec: 0,
    downtime_sec: 0,
    unknown_sec: 0,
    uptime_sec: 0,
    heartbeat_gap_sec: '',
    heartbeat_latency_ms: [normalizeRuntimeUpdateLatencyMs(update.latency_ms)],
    heartbeat_status_codes: toRuntimeStatusCode(update.check_status),
  };
}

export function applyMonitorRuntimeUpdates(
  snapshot: PublicMonitorRuntimeSnapshot,
  now: number,
  updates: MonitorRuntimeUpdate[],
): PublicMonitorRuntimeSnapshot {
  const dayStart = utcDayStart(now);
  const sourceById = readSnapshotEntryMap(snapshot);
  const nextById = new Map<number, PublicMonitorRuntimeEntry>(sourceById);
  let hasInsertedMonitor = false;

  for (const update of updates) {
    if (!Number.isInteger(update.monitor_id) || update.monitor_id <= 0) continue;
    if (!Number.isInteger(update.checked_at) || update.checked_at < 0) continue;
    if (!Number.isInteger(update.created_at) || update.created_at < 0) continue;
    if (update.checked_at < update.created_at || update.checked_at > now) continue;

    const existing = nextById.get(update.monitor_id);
    if (!existing) {
      nextById.set(update.monitor_id, createRuntimeEntryForUpdate(update, dayStart));
      hasInsertedMonitor = true;
      continue;
    }
    if (
      typeof existing.last_checked_at === 'number' &&
      Number.isInteger(existing.last_checked_at) &&
      update.checked_at <= existing.last_checked_at
    ) {
      continue;
    }

    const sourceEntry = sourceById.get(update.monitor_id);
    const nextEntry =
      sourceEntry && existing === sourceEntry ? cloneRuntimeEntry(existing) : existing;
    if (nextEntry !== existing) {
      nextById.set(update.monitor_id, nextEntry);
    }

    if (nextEntry.created_at === null) {
      nextEntry.created_at = clampNonNegativeInteger(update.created_at);
    }
    nextEntry.interval_sec = Math.max(1, clampNonNegativeInteger(update.interval_sec));
    const rangeStartAt = nextEntry.range_start_at;
    const segmentStart =
      rangeStartAt === null ? update.checked_at : Math.max(rangeStartAt, nextEntry.materialized_at);
    const segment = computeSegmentTotals({
      segmentStart,
      segmentEnd: update.checked_at,
      lastCheckedAt: nextEntry.last_checked_at,
      lastStatusCode: nextEntry.last_status_code,
      lastOutageOpen: nextEntry.last_outage_open,
      intervalSec: nextEntry.interval_sec,
    });

    nextEntry.total_sec += segment.totalSec;
    nextEntry.downtime_sec += segment.downtimeSec;
    nextEntry.unknown_sec += segment.unknownSec;
    nextEntry.uptime_sec += segment.uptimeSec;

    if (nextEntry.range_start_at === null) {
      const createdToday =
        Number.isFinite(update.created_at) &&
        update.created_at >= dayStart &&
        update.created_at <= update.checked_at;
      nextEntry.range_start_at = createdToday ? update.checked_at : dayStart;
    }
    nextEntry.materialized_at = update.checked_at;
    const previousLastCheckedAt = nextEntry.last_checked_at;
    nextEntry.last_checked_at = update.checked_at;
    nextEntry.last_status_code = toRuntimeCurrentStatusCode(update);
    nextEntry.last_outage_open = update.next_status === 'down';

    nextEntry.heartbeat_latency_ms.unshift(normalizeRuntimeUpdateLatencyMs(update.latency_ms));
    nextEntry.heartbeat_status_codes = `${toRuntimeStatusCode(update.check_status)}${nextEntry.heartbeat_status_codes}`;
    const gaps = parseHeartbeatGapSec(nextEntry.heartbeat_gap_sec);
    if (typeof previousLastCheckedAt === 'number' && Number.isInteger(previousLastCheckedAt)) {
      gaps.unshift(Math.max(0, update.checked_at - previousLastCheckedAt));
    }

    if (nextEntry.heartbeat_latency_ms.length > MONITOR_RUNTIME_HEARTBEAT_POINTS) {
      nextEntry.heartbeat_latency_ms.length = MONITOR_RUNTIME_HEARTBEAT_POINTS;
    }
    if (nextEntry.heartbeat_status_codes.length > MONITOR_RUNTIME_HEARTBEAT_POINTS) {
      nextEntry.heartbeat_status_codes = nextEntry.heartbeat_status_codes.slice(
        0,
        MONITOR_RUNTIME_HEARTBEAT_POINTS,
      );
    }
    if (gaps.length > Math.max(0, nextEntry.heartbeat_latency_ms.length - 1)) {
      gaps.length = Math.max(0, nextEntry.heartbeat_latency_ms.length - 1);
    }
    nextEntry.heartbeat_gap_sec = encodeHeartbeatGapSec(gaps);
  }

  return {
    version: MONITOR_RUNTIME_SNAPSHOT_VERSION,
    generated_at: now,
    day_start_at: dayStart,
    monitors: hasInsertedMonitor
      ? [...nextById.values()].sort((a, b) => a.monitor_id - b.monitor_id)
      : [...nextById.values()],
  };
}

export function materializeMonitorRuntimeTotals(
  entry: PublicMonitorRuntimeTotalsEntry,
  now: number,
): MonitorRuntimeTotals {
  const total_sec = clampNonNegativeInteger(entry.total_sec);
  const downtime_sec = clampNonNegativeInteger(entry.downtime_sec);
  const unknown_sec = clampNonNegativeInteger(entry.unknown_sec);
  const uptime_sec = clampNonNegativeInteger(entry.uptime_sec);

  const segmentStart =
    entry.range_start_at === null
      ? now
      : Math.max(entry.range_start_at, clampNonNegativeInteger(entry.materialized_at));
  const segment = computeSegmentTotals({
    segmentStart,
    segmentEnd: now,
    lastCheckedAt: entry.last_checked_at,
    lastStatusCode: entry.last_status_code,
    lastOutageOpen: entry.last_outage_open,
    intervalSec: entry.interval_sec,
  });

  const totalWithTail = total_sec + segment.totalSec;
  const downtimeWithTail = downtime_sec + segment.downtimeSec;
  const unknownWithTail = unknown_sec + segment.unknownSec;
  const uptimeWithTail = uptime_sec + segment.uptimeSec;

  return {
    total_sec: totalWithTail,
    downtime_sec: downtimeWithTail,
    unknown_sec: unknownWithTail,
    uptime_sec: uptimeWithTail,
    uptime_pct: totalWithTail === 0 ? null : (uptimeWithTail / totalWithTail) * 100,
  };
}

export function runtimeEntryToHeartbeats(
  entry: PublicMonitorRuntimeEntry,
): MonitorRuntimeHeartbeat[] {
  const cached = runtimeEntryHeartbeatsByEntry.get(entry);
  if (cached) {
    return cached;
  }

  const heartbeats: MonitorRuntimeHeartbeat[] = [];
  const count = Math.min(entry.heartbeat_latency_ms.length, entry.heartbeat_status_codes.length);
  if (count === 0 || entry.last_checked_at === null) {
    runtimeEntryHeartbeatsByEntry.set(entry, heartbeats);
    return heartbeats;
  }

  const gaps = parseHeartbeatGapSec(entry.heartbeat_gap_sec);
  let checkedAt = entry.last_checked_at;
  for (let index = 0; index < count; index += 1) {
    const code = entry.heartbeat_status_codes[index] as MonitorRuntimeStatusCode | undefined;
    if (!code) continue;
    heartbeats.push({
      checked_at: checkedAt,
      latency_ms: entry.heartbeat_latency_ms[index] ?? null,
      status: fromRuntimeStatusCode(code),
    });
    const gap = gaps[index];
    if (typeof gap === 'number') {
      checkedAt = Math.max(0, checkedAt - gap);
    }
  }
  runtimeEntryHeartbeatsByEntry.set(entry, heartbeats);
  return heartbeats;
}

export async function refreshPublicMonitorRuntimeSnapshot(opts: {
  db: D1Database;
  now: number;
  updates: MonitorRuntimeUpdate[];
  rebuild: () => Promise<PublicMonitorRuntimeSnapshot>;
  beforeWrite?: () => void | Promise<void>;
}): Promise<PublicMonitorRuntimeSnapshot> {
  const stored = await readStoredMonitorRuntimeSnapshot(opts.db);
  const dayStart = utcDayStart(opts.now);
  const shouldRebuild =
    stored === null ||
    stored.snapshot.day_start_at !== dayStart ||
    stored.generatedAt < dayStart ||
    stored.generatedAt > opts.now;

  if (shouldRebuild) {
    const rebuilt = await opts.rebuild();
    await opts.beforeWrite?.();
    await writePublicMonitorRuntimeSnapshot(opts.db, rebuilt, opts.now);
    return rebuilt;
  }

  const snapshot = stored.snapshot;
  const snapshotMonitorIds = readSnapshotMonitorIds(snapshot);
  const missingHistoricalEntry = opts.updates.some(
    (update) =>
      !snapshotMonitorIds.has(update.monitor_id) &&
      update.created_at < dayStart &&
      update.checked_at >= dayStart + update.interval_sec,
  );
  if (missingHistoricalEntry) {
    const rebuilt = await opts.rebuild();
    await opts.beforeWrite?.();
    await writePublicMonitorRuntimeSnapshot(opts.db, rebuilt, opts.now);
    return rebuilt;
  }

  const next = applyMonitorRuntimeUpdates(snapshot, opts.now, opts.updates);
  await opts.beforeWrite?.();
  await writePublicMonitorRuntimeSnapshot(opts.db, next, opts.now);
  return next;
}
