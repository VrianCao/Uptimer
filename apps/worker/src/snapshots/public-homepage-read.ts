import { AppError } from '../middleware/errors';
import { type PublicHomepageResponse } from '../schemas/public-homepage';
import {
  publicHomepageStoredRenderArtifactSchema,
  storedPublicHomepageResponseSchema,
} from '../schemas/public-homepage-stored';

const SNAPSHOT_KEY = 'homepage';
const SNAPSHOT_ARTIFACT_KEY = 'homepage:artifact';
const MAX_AGE_SECONDS = 60;
const MAX_STALE_SECONDS = 10 * 60;
const MAX_FUTURE_SNAPSHOT_SKEW_SECONDS = 60;
const SPLIT_SNAPSHOT_VERSION = 3;
const LEGACY_COMBINED_SNAPSHOT_VERSION = 2;
type SnapshotKey = typeof SNAPSHOT_KEY | typeof SNAPSHOT_ARTIFACT_KEY;

const READ_REFRESH_SNAPSHOT_METADATA_SQL = `
  SELECT key, generated_at, updated_at
  FROM public_snapshots
  WHERE key = ?1 OR key = ?2
`;
const READ_REFRESH_SNAPSHOT_ROWS_SQL = `
  SELECT key, generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1 OR key = ?2
`;
const READ_REFRESH_SNAPSHOT_ROW_BY_KEY_SQL = `
  SELECT generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const READ_REFRESH_SNAPSHOT_METADATA_ROW_BY_KEY_SQL = `
  SELECT generated_at, updated_at
  FROM public_snapshots
  WHERE key = ?1
`;
const readRefreshSnapshotMetadataStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readRefreshSnapshotRowsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readRefreshSnapshotRowByKeyStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readRefreshSnapshotMetadataRowByKeyStatementByDb = new WeakMap<
  D1Database,
  D1PreparedStatement
>();
const normalizedHomepagePayloadCacheByDb = new WeakMap<
  D1Database,
  Map<SnapshotKey, NormalizedSnapshotRow>
>();
const normalizedHomepageArtifactCacheByDb = new WeakMap<
  D1Database,
  Map<SnapshotKey, NormalizedSnapshotRow>
>();
const normalizedHomepagePayloadCacheGlobal = new Map<SnapshotKey, RawNormalizedSnapshotRow>();
const normalizedHomepageArtifactCacheGlobal = new Map<SnapshotKey, RawNormalizedSnapshotRow>();
const parsedHomepagePayloadCacheByDb = new WeakMap<
  D1Database,
  Map<SnapshotKey, ParsedSnapshotRow>
>();
const parsedHomepagePayloadCacheGlobal = new Map<SnapshotKey, RawParsedSnapshotRow>();

type SnapshotRefreshRow = {
  key: SnapshotKey;
  generated_at: number;
  body_json: string;
  updated_at?: number | null;
};

type SnapshotRefreshMetadataRow = {
  key: SnapshotKey;
  generated_at: number;
  updated_at: number | null;
};

type SnapshotCandidate = {
  key: SnapshotKey;
  generatedAt: number;
  updatedAt: number;
};

type NormalizedSnapshotRow = {
  generatedAt: number;
  updatedAt: number;
  rawBodyJson: string;
  bodyJson: string;
};

type RawNormalizedSnapshotRow = NormalizedSnapshotRow & {
  rawBodyJson: string;
};

type ParsedSnapshotRow = {
  generatedAt: number;
  updatedAt: number;
  rawBodyJson: string;
  snapshot: PublicHomepageResponse;
};

type RawParsedSnapshotRow = ParsedSnapshotRow & {
  rawBodyJson: string;
};

type ParsedJsonText = {
  trimmed: string;
  value: unknown;
};

type CandidateReadResult = {
  row: NormalizedSnapshotRow | null;
  invalid: boolean;
};

type PreferredSnapshotReadResult = {
  row: NormalizedSnapshotRow | null;
  age: number | null;
  invalid: boolean;
};

type RefreshSnapshotReadContext = {
  metadataRows: SnapshotRefreshMetadataRow[];
  readRowByKey: (key: SnapshotKey) => Promise<SnapshotRefreshRow | null>;
};

export type HomepageRefreshBaseSnapshotReadResult = {
  generatedAt: number | null;
  snapshot: PublicHomepageResponse | null;
  seedDataSnapshot: boolean;
};

function isNoFakeD1HandlerError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message.startsWith('No fake D1 all() handler matched SQL:') ||
      err.message.startsWith('No fake D1 first() handler matched SQL:'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonText(text: string): ParsedJsonText | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return {
      trimmed,
      value: JSON.parse(trimmed) as unknown,
    };
  } catch {
    return null;
  }
}

function parseDirectHomepagePayload(value: unknown): PublicHomepageResponse | null {
  const storedPayload = storedPublicHomepageResponseSchema.safeParse(value);
  if (storedPayload.success) {
    return storedPayload.data;
  }
  if (!isRecord(value)) {
    return null;
  }

  const normalizedPayload = storedPublicHomepageResponseSchema.safeParse({
    generated_at: value.generated_at,
    bootstrap_mode:
      value.bootstrap_mode === 'full' || value.bootstrap_mode === 'partial'
        ? value.bootstrap_mode
        : 'full',
    monitor_count_total: Array.isArray(value.monitors) ? value.monitors.length : 0,
    site_title: value.site_title,
    site_description: value.site_description,
    site_locale: value.site_locale,
    site_timezone: value.site_timezone,
    uptime_rating_level: value.uptime_rating_level,
    overall_status: value.overall_status,
    banner: value.banner,
    summary: value.summary,
    monitors: value.monitors,
    active_incidents: value.active_incidents,
    maintenance_windows: value.maintenance_windows,
    resolved_incident_preview: value.resolved_incident_preview ?? null,
    maintenance_history_preview: value.maintenance_history_preview ?? null,
  });
  return normalizedPayload.success ? normalizedPayload.data : null;
}

function parseStoredHomepageRenderArtifactSnapshot(value: unknown): PublicHomepageResponse | null {
  const artifact = publicHomepageStoredRenderArtifactSchema.safeParse(value);
  if (!artifact.success) {
    return null;
  }

  if ('snapshot' in artifact.data) {
    return artifact.data.snapshot;
  }

  const parsedSnapshot = parseJsonText(artifact.data.snapshot_json);
  if (parsedSnapshot === null) {
    return null;
  }

  return parseDirectHomepagePayload(parsedSnapshot.value);
}

function matchesExpectedGeneratedAt(
  snapshot: PublicHomepageResponse,
  expectedGeneratedAt: number | undefined,
): boolean {
  return expectedGeneratedAt === undefined || snapshot.generated_at === expectedGeneratedAt;
}

function normalizeHomepagePayloadBodyJsonForKey(
  key: SnapshotKey,
  bodyJson: string,
  expectedGeneratedAt?: number,
): string | null {
  const parsed = parseJsonText(bodyJson);
  if (parsed === null) return null;

  if (!isRecord(parsed.value)) {
    return null;
  }

  const version = parsed.value.version;
  if (version === SPLIT_SNAPSHOT_VERSION || version === LEGACY_COMBINED_SNAPSHOT_VERSION) {
    const directPayload = parseDirectHomepagePayload(parsed.value.data);
    return directPayload && matchesExpectedGeneratedAt(directPayload, expectedGeneratedAt)
      ? JSON.stringify(directPayload)
      : null;
  }

  if (key === SNAPSHOT_KEY) {
    const directPayload = parseDirectHomepagePayload(parsed.value);
    if (directPayload) {
      return matchesExpectedGeneratedAt(directPayload, expectedGeneratedAt)
        ? JSON.stringify(directPayload)
        : null;
    }
  }

  const artifactSnapshot = parseStoredHomepageRenderArtifactSnapshot(parsed.value);
  if (artifactSnapshot && matchesExpectedGeneratedAt(artifactSnapshot, expectedGeneratedAt)) {
    return JSON.stringify(artifactSnapshot);
  }

  if (key === SNAPSHOT_KEY) {
    return null;
  }

  const directPayload = parseDirectHomepagePayload(parsed.value);
  return directPayload && matchesExpectedGeneratedAt(directPayload, expectedGeneratedAt)
    ? JSON.stringify(directPayload)
    : null;
}

function normalizeHomepageArtifactBodyJson(
  bodyJson: string,
  expectedGeneratedAt?: number,
): string | null {
  const parsed = parseJsonText(bodyJson);
  if (parsed === null) return null;

  const artifact = publicHomepageStoredRenderArtifactSchema.safeParse(parsed.value);
  if (artifact.success) {
    const snapshot = parseStoredHomepageRenderArtifactSnapshot(artifact.data);
    if (
      snapshot === null ||
      !matchesExpectedGeneratedAt(snapshot, expectedGeneratedAt) ||
      (expectedGeneratedAt !== undefined && artifact.data.generated_at !== expectedGeneratedAt)
    ) {
      return null;
    }
    return parsed.trimmed;
  }
  if (!isRecord(parsed.value)) {
    return null;
  }

  const version = parsed.value.version;
  if (version !== SPLIT_SNAPSHOT_VERSION && version !== LEGACY_COMBINED_SNAPSHOT_VERSION) {
    return null;
  }

  const legacyArtifact = publicHomepageStoredRenderArtifactSchema.safeParse(parsed.value.render);
  if (!legacyArtifact.success) {
    return null;
  }
  const snapshot = parseStoredHomepageRenderArtifactSnapshot(legacyArtifact.data);
  if (
    snapshot === null ||
    !matchesExpectedGeneratedAt(snapshot, expectedGeneratedAt) ||
    (expectedGeneratedAt !== undefined && legacyArtifact.data.generated_at !== expectedGeneratedAt)
  ) {
    return null;
  }
  return JSON.stringify(legacyArtifact.data);
}

function parseHomepagePayloadSnapshotForKey(
  key: SnapshotKey,
  bodyJson: string,
): PublicHomepageResponse | null {
  const parsed = parseJsonText(bodyJson);
  if (parsed === null) return null;
  if (!isRecord(parsed.value)) {
    return null;
  }

  const version = parsed.value.version;
  if (version === SPLIT_SNAPSHOT_VERSION || version === LEGACY_COMBINED_SNAPSHOT_VERSION) {
    return parseDirectHomepagePayload(parsed.value.data);
  }

  if (key === SNAPSHOT_KEY) {
    const directPayload = parseDirectHomepagePayload(parsed.value);
    if (directPayload) {
      return directPayload;
    }
  }

  const artifactSnapshot = parseStoredHomepageRenderArtifactSnapshot(parsed.value);
  if (artifactSnapshot) {
    return artifactSnapshot;
  }

  return key === SNAPSHOT_KEY ? null : parseDirectHomepagePayload(parsed.value);
}

function snapshotMatchesCandidateGeneratedAt(
  candidate: SnapshotCandidate,
  snapshot: PublicHomepageResponse,
): boolean {
  return snapshot.generated_at === candidate.generatedAt;
}

function toSnapshotUpdatedAt(row: Pick<SnapshotRefreshRow, 'generated_at' | 'updated_at'>): number {
  return typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
    ? row.updated_at
    : row.generated_at;
}

function getNormalizedSnapshotCache(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>,
  db: D1Database,
): Map<SnapshotKey, NormalizedSnapshotRow> {
  const cached = cacheByDb.get(db);
  if (cached) {
    return cached;
  }

  const next = new Map<SnapshotKey, NormalizedSnapshotRow>();
  cacheByDb.set(db, next);
  return next;
}

function getParsedSnapshotCache(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, ParsedSnapshotRow>>,
  db: D1Database,
): Map<SnapshotKey, ParsedSnapshotRow> {
  const cached = cacheByDb.get(db);
  if (cached) {
    return cached;
  }

  const next = new Map<SnapshotKey, ParsedSnapshotRow>();
  cacheByDb.set(db, next);
  return next;
}

function readCachedNormalizedSnapshotRow(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>,
  db: D1Database,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
): NormalizedSnapshotRow | null {
  const row = readCachedNormalizedSnapshotRowByVersion(cacheByDb, db, candidate);
  return row && row.rawBodyJson === rawBodyJson ? row : null;
}

function readCachedNormalizedSnapshotRowByVersion(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>,
  db: D1Database,
  candidate: SnapshotCandidate,
): NormalizedSnapshotRow | null {
  const cache = getNormalizedSnapshotCache(cacheByDb, db);
  const row = cache.get(candidate.key);
  if (!row) {
    return null;
  }

  return row.generatedAt === candidate.generatedAt && row.updatedAt === candidate.updatedAt
    ? row
    : null;
}

function writeCachedNormalizedSnapshotRow(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>,
  db: D1Database,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
  bodyJson: string,
): NormalizedSnapshotRow {
  const row: NormalizedSnapshotRow = {
    generatedAt: candidate.generatedAt,
    updatedAt: candidate.updatedAt,
    rawBodyJson,
    bodyJson,
  };
  getNormalizedSnapshotCache(cacheByDb, db).set(candidate.key, row);
  return row;
}

function readCachedParsedSnapshotRowByVersion(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, ParsedSnapshotRow>>,
  db: D1Database,
  candidate: SnapshotCandidate,
): ParsedSnapshotRow | null {
  const cache = getParsedSnapshotCache(cacheByDb, db);
  const row = cache.get(candidate.key);
  if (!row) {
    return null;
  }

  return row.generatedAt === candidate.generatedAt && row.updatedAt === candidate.updatedAt
    ? row
    : null;
}

function writeCachedParsedSnapshotRow(
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, ParsedSnapshotRow>>,
  db: D1Database,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
  snapshot: PublicHomepageResponse,
): ParsedSnapshotRow {
  const row: ParsedSnapshotRow = {
    generatedAt: candidate.generatedAt,
    updatedAt: candidate.updatedAt,
    rawBodyJson,
    snapshot,
  };
  getParsedSnapshotCache(cacheByDb, db).set(candidate.key, row);
  return row;
}

function readCachedNormalizedSnapshotRowGlobal(
  cache: ReadonlyMap<SnapshotKey, RawNormalizedSnapshotRow>,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
): NormalizedSnapshotRow | null {
  const row = readCachedNormalizedSnapshotRowGlobalByVersion(cache, candidate);
  return row && row.rawBodyJson === rawBodyJson ? row : null;
}

function readCachedNormalizedSnapshotRowGlobalByVersion(
  cache: ReadonlyMap<SnapshotKey, RawNormalizedSnapshotRow>,
  candidate: SnapshotCandidate,
): NormalizedSnapshotRow | null {
  const row = cache.get(candidate.key);
  if (!row) {
    return null;
  }

  return row.generatedAt === candidate.generatedAt && row.updatedAt === candidate.updatedAt
    ? row
    : null;
}

function writeCachedNormalizedSnapshotRowGlobal(
  cache: Map<SnapshotKey, RawNormalizedSnapshotRow>,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
  bodyJson: string,
): RawNormalizedSnapshotRow {
  const row: RawNormalizedSnapshotRow = {
    generatedAt: candidate.generatedAt,
    updatedAt: candidate.updatedAt,
    rawBodyJson,
    bodyJson,
  };
  cache.set(candidate.key, row);
  return row;
}

function readCachedParsedSnapshotRowGlobalByVersion(
  cache: ReadonlyMap<SnapshotKey, RawParsedSnapshotRow>,
  candidate: SnapshotCandidate,
): ParsedSnapshotRow | null {
  const row = cache.get(candidate.key);
  if (!row) {
    return null;
  }

  return row.generatedAt === candidate.generatedAt && row.updatedAt === candidate.updatedAt
    ? row
    : null;
}

function writeCachedParsedSnapshotRowGlobal(
  cache: Map<SnapshotKey, RawParsedSnapshotRow>,
  candidate: SnapshotCandidate,
  rawBodyJson: string,
  snapshot: PublicHomepageResponse,
): RawParsedSnapshotRow {
  const row: RawParsedSnapshotRow = {
    generatedAt: candidate.generatedAt,
    updatedAt: candidate.updatedAt,
    rawBodyJson,
    snapshot,
  };
  cache.set(candidate.key, row);
  return row;
}

function isSameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / 86_400) === Math.floor(b / 86_400);
}

function isFutureSnapshotCandidate(candidate: SnapshotCandidate, now: number): boolean {
  return candidate.generatedAt > now + MAX_FUTURE_SNAPSHOT_SKEW_SECONDS;
}

function snapshotCandidateAgeSeconds(candidate: SnapshotCandidate, now: number): number {
  return Math.max(0, now - candidate.generatedAt);
}

function snapshotCandidateUpdatedAgeSeconds(candidate: SnapshotCandidate, now: number): number {
  return Math.max(0, now - candidate.updatedAt);
}

async function readRefreshSnapshotRows(db: D1Database): Promise<SnapshotRefreshRow[]> {
  try {
    const cached = readRefreshSnapshotRowsStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_REFRESH_SNAPSHOT_ROWS_SQL);
    if (!cached) {
      readRefreshSnapshotRowsStatementByDb.set(db, statement);
    }

    const { results } = await statement
      .bind(SNAPSHOT_KEY, SNAPSHOT_ARTIFACT_KEY)
      .all<SnapshotRefreshRow>();
    return results ?? [];
  } catch (err) {
    console.warn('homepage snapshot: refresh rows read failed', err);
    return [];
  }
}

async function readRefreshSnapshotMetadataRows(
  db: D1Database,
): Promise<SnapshotRefreshMetadataRow[]> {
  try {
    const cached = readRefreshSnapshotMetadataStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_REFRESH_SNAPSHOT_METADATA_SQL);
    if (!cached) {
      readRefreshSnapshotMetadataStatementByDb.set(db, statement);
    }

    const { results } = await statement
      .bind(SNAPSHOT_KEY, SNAPSHOT_ARTIFACT_KEY)
      .all<SnapshotRefreshMetadataRow>();
    return results ?? [];
  } catch (err) {
    if (isNoFakeD1HandlerError(err)) {
      return [];
    }
    console.warn('homepage snapshot: refresh metadata read failed', err);
    return [];
  }
}

async function readRefreshSnapshotMetadataRowByKey(
  db: D1Database,
  key: SnapshotKey,
): Promise<SnapshotRefreshMetadataRow | null> {
  try {
    const cached = readRefreshSnapshotMetadataRowByKeyStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_REFRESH_SNAPSHOT_METADATA_ROW_BY_KEY_SQL);
    if (!cached) {
      readRefreshSnapshotMetadataRowByKeyStatementByDb.set(db, statement);
    }

    const row = await statement.bind(key).first<Omit<SnapshotRefreshMetadataRow, 'key'>>();
    return row ? { key, ...row } : null;
  } catch (err) {
    if (isNoFakeD1HandlerError(err)) {
      return null;
    }
    console.warn('homepage snapshot: refresh metadata row read failed', err);
    return null;
  }
}

async function readRefreshSnapshotRowByKey(
  db: D1Database,
  key: SnapshotKey,
): Promise<SnapshotRefreshRow | null> {
  try {
    const cached = readRefreshSnapshotRowByKeyStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_REFRESH_SNAPSHOT_ROW_BY_KEY_SQL);
    if (!cached) {
      readRefreshSnapshotRowByKeyStatementByDb.set(db, statement);
    }

    const row = await statement.bind(key).first<Omit<SnapshotRefreshRow, 'key'>>();
    return row ? { key, ...row } : null;
  } catch (err) {
    if (isNoFakeD1HandlerError(err)) {
      return null;
    }
    console.warn('homepage snapshot: refresh row read failed', err);
    return null;
  }
}

function listSnapshotCandidatesFromRefreshRows(
  rows: readonly Pick<SnapshotRefreshRow, 'key' | 'generated_at' | 'updated_at'>[],
): SnapshotCandidate[] {
  return rows.map((row) => ({
    key: row.key,
    generatedAt: row.generated_at,
    updatedAt: toSnapshotUpdatedAt(row),
  }));
}

function toSnapshotRefreshMetadataRow(
  row: Pick<SnapshotRefreshRow, 'key' | 'generated_at' | 'updated_at'>,
): SnapshotRefreshMetadataRow {
  return {
    key: row.key,
    generated_at: row.generated_at,
    updated_at: row.updated_at ?? null,
  };
}

async function createRefreshSnapshotReadContext(
  db: D1Database,
): Promise<RefreshSnapshotReadContext> {
  const rowByKey = new Map<SnapshotKey, SnapshotRefreshRow | null>();
  const readRowByKey = async (key: SnapshotKey): Promise<SnapshotRefreshRow | null> => {
    if (rowByKey.has(key)) {
      return rowByKey.get(key) ?? null;
    }

    const row = await readRefreshSnapshotRowByKey(db, key);
    rowByKey.set(key, row);
    return row;
  };

  const metadataRows = await readRefreshSnapshotMetadataRows(db);
  if (metadataRows.length > 0) {
    return { metadataRows, readRowByKey };
  }

  const refreshRows = await readRefreshSnapshotRows(db);
  for (const row of refreshRows) {
    rowByKey.set(row.key, row);
  }

  return {
    metadataRows: refreshRows.map(toSnapshotRefreshMetadataRow),
    readRowByKey,
  };
}

function comparePayloadCandidates(a: SnapshotCandidate, b: SnapshotCandidate): number {
  if (a.generatedAt !== b.generatedAt) {
    return b.generatedAt - a.generatedAt;
  }
  if (a.key === b.key) {
    return 0;
  }
  return a.key === SNAPSHOT_KEY ? -1 : 1;
}

function compareArtifactCandidates(a: SnapshotCandidate, b: SnapshotCandidate): number {
  if (a.generatedAt !== b.generatedAt) {
    return b.generatedAt - a.generatedAt;
  }
  if (a.key === b.key) {
    return 0;
  }
  return a.key === SNAPSHOT_ARTIFACT_KEY ? -1 : 1;
}

async function readValidatedSnapshotCandidate(opts: {
  db: D1Database;
  candidate: SnapshotCandidate;
  readRowByKey: (key: SnapshotKey) => Promise<SnapshotRefreshRow | null>;
  normalize: (candidate: SnapshotCandidate, bodyJson: string) => string | null;
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>;
  globalCache: Map<SnapshotKey, RawNormalizedSnapshotRow>;
}): Promise<CandidateReadResult> {
  const dbCachedByVersion = readCachedNormalizedSnapshotRowByVersion(
    opts.cacheByDb,
    opts.db,
    opts.candidate,
  );
  if (dbCachedByVersion) {
    return { row: dbCachedByVersion, invalid: false };
  }

  const globalCachedByVersion = readCachedNormalizedSnapshotRowGlobalByVersion(
    opts.globalCache,
    opts.candidate,
  );
  if (globalCachedByVersion) {
    return {
      row: writeCachedNormalizedSnapshotRow(
        opts.cacheByDb,
        opts.db,
        opts.candidate,
        globalCachedByVersion.rawBodyJson,
        globalCachedByVersion.bodyJson,
      ),
      invalid: false,
    };
  }

  const row = await opts.readRowByKey(opts.candidate.key);
  if (!row || row.generated_at !== opts.candidate.generatedAt) {
    return { row: null, invalid: false };
  }

  const bodyJson = opts.normalize(opts.candidate, row.body_json);
  if (!bodyJson) {
    return { row: null, invalid: true };
  }

  writeCachedNormalizedSnapshotRowGlobal(opts.globalCache, opts.candidate, row.body_json, bodyJson);
  return {
    row: writeCachedNormalizedSnapshotRow(
      opts.cacheByDb,
      opts.db,
      opts.candidate,
      row.body_json,
      bodyJson,
    ),
    invalid: false,
  };
}

async function readPreferredSnapshotCandidate(opts: {
  db: D1Database;
  key: SnapshotKey;
  now: number;
  maxAgeSeconds: number;
  normalize: (candidate: SnapshotCandidate, bodyJson: string) => string | null;
  cacheByDb: WeakMap<D1Database, Map<SnapshotKey, NormalizedSnapshotRow>>;
  globalCache: Map<SnapshotKey, RawNormalizedSnapshotRow>;
}): Promise<PreferredSnapshotReadResult> {
  const metadata = await readRefreshSnapshotMetadataRowByKey(opts.db, opts.key);
  if (!metadata) {
    return { row: null, age: null, invalid: false };
  }

  const candidate: SnapshotCandidate = {
    key: opts.key,
    generatedAt: metadata.generated_at,
    updatedAt: toSnapshotUpdatedAt(metadata),
  };
  if (isFutureSnapshotCandidate(candidate, opts.now)) {
    return { row: null, age: null, invalid: false };
  }

  const age =
    opts.key === SNAPSHOT_ARTIFACT_KEY
      ? snapshotCandidateUpdatedAgeSeconds(candidate, opts.now)
      : snapshotCandidateAgeSeconds(candidate, opts.now);
  if (age > opts.maxAgeSeconds) {
    return { row: null, age, invalid: false };
  }

  const result = await readValidatedSnapshotCandidate({
    db: opts.db,
    candidate,
    readRowByKey: async (key) => await readRefreshSnapshotRowByKey(opts.db, key),
    normalize: opts.normalize,
    cacheByDb: opts.cacheByDb,
    globalCache: opts.globalCache,
  });

  return {
    row: result.row,
    age,
    invalid: result.invalid,
  };
}

async function readHomepageSnapshotJsonViaCandidates(
  db: D1Database,
  now: number,
  maxStaleSeconds: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const { metadataRows, readRowByKey } = await createRefreshSnapshotReadContext(db);
  const candidates = listSnapshotCandidatesFromRefreshRows(metadataRows)
    .filter(
      (candidate) =>
        !isFutureSnapshotCandidate(candidate, now) &&
        snapshotCandidateAgeSeconds(candidate, now) <= maxStaleSeconds,
    )
    .sort(comparePayloadCandidates);

  for (const candidate of candidates) {
    const result = await readValidatedSnapshotCandidate({
      db,
      candidate,
      readRowByKey,
      normalize: (currentCandidate, bodyJson) =>
        normalizeHomepagePayloadBodyJsonForKey(
          currentCandidate.key,
          bodyJson,
          currentCandidate.generatedAt,
        ),
      cacheByDb: normalizedHomepagePayloadCacheByDb,
      globalCache: normalizedHomepagePayloadCacheGlobal,
    });
    if (!result.row) {
      if (result.invalid) {
        console.warn('homepage snapshot: invalid payload');
      }
      continue;
    }

    return {
      bodyJson: result.row.bodyJson,
      age: snapshotCandidateAgeSeconds(
        {
          key: candidate.key,
          generatedAt: result.row.generatedAt,
          updatedAt: result.row.updatedAt,
        },
        now,
      ),
    };
  }

  return null;
}

async function readHomepageArtifactJsonViaCandidates(
  db: D1Database,
  now: number,
  maxAgeSeconds: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const { metadataRows, readRowByKey } = await createRefreshSnapshotReadContext(db);
  const candidates = listSnapshotCandidatesFromRefreshRows(metadataRows)
    .filter(
      (candidate) =>
        !isFutureSnapshotCandidate(candidate, now) &&
        snapshotCandidateUpdatedAgeSeconds(candidate, now) <= maxAgeSeconds,
    )
    .sort(compareArtifactCandidates);

  for (const candidate of candidates) {
    const result = await readValidatedSnapshotCandidate({
      db,
      candidate,
      readRowByKey,
      normalize: (candidate, bodyJson) =>
        normalizeHomepageArtifactBodyJson(bodyJson, candidate.generatedAt),
      cacheByDb: normalizedHomepageArtifactCacheByDb,
      globalCache: normalizedHomepageArtifactCacheGlobal,
    });
    if (!result.row) {
      if (result.invalid) {
        console.warn(
          maxAgeSeconds > MAX_AGE_SECONDS
            ? 'homepage snapshot: invalid stale artifact payload'
            : 'homepage snapshot: invalid artifact payload',
        );
      }
      continue;
    }

    return {
      bodyJson: result.row.bodyJson,
      age: snapshotCandidateUpdatedAgeSeconds(
        {
          key: candidate.key,
          generatedAt: result.row.generatedAt,
          updatedAt: result.row.updatedAt,
        },
        now,
      ),
    };
  }

  return null;
}

export async function readHomepageSnapshotGeneratedAt(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const candidates = listSnapshotCandidatesFromRefreshRows(
    await readRefreshSnapshotMetadataRows(db),
  )
    .filter((candidate) => !isFutureSnapshotCandidate(candidate, now))
    .sort(comparePayloadCandidates);

  for (const candidate of candidates) {
    const row = await readRefreshSnapshotRowByKey(db, candidate.key);
    if (!row) {
      continue;
    }

    const liveCandidate: SnapshotCandidate = {
      key: candidate.key,
      generatedAt: row.generated_at,
      updatedAt: toSnapshotUpdatedAt(row),
    };
    if (isFutureSnapshotCandidate(liveCandidate, now)) {
      continue;
    }

    const dbCached = readCachedNormalizedSnapshotRow(
      normalizedHomepagePayloadCacheByDb,
      db,
      liveCandidate,
      row.body_json,
    );
    if (dbCached) {
      return dbCached.generatedAt;
    }

    const globalCached = readCachedNormalizedSnapshotRowGlobal(
      normalizedHomepagePayloadCacheGlobal,
      liveCandidate,
      row.body_json,
    );
    if (globalCached) {
      writeCachedNormalizedSnapshotRow(
        normalizedHomepagePayloadCacheByDb,
        db,
        liveCandidate,
        row.body_json,
        globalCached.bodyJson,
      );
      return liveCandidate.generatedAt;
    }

    const bodyJson = normalizeHomepagePayloadBodyJsonForKey(
      liveCandidate.key,
      row.body_json,
      liveCandidate.generatedAt,
    );
    if (!bodyJson) {
      continue;
    }

    writeCachedNormalizedSnapshotRowGlobal(
      normalizedHomepagePayloadCacheGlobal,
      liveCandidate,
      row.body_json,
      bodyJson,
    );
    writeCachedNormalizedSnapshotRow(
      normalizedHomepagePayloadCacheByDb,
      db,
      liveCandidate,
      row.body_json,
      bodyJson,
    );
    return liveCandidate.generatedAt;
  }

  return null;
}

export async function readHomepageArtifactSnapshotGeneratedAt(
  db: D1Database,
): Promise<number | null> {
  const { metadataRows, readRowByKey } = await createRefreshSnapshotReadContext(db);
  const candidates = listSnapshotCandidatesFromRefreshRows(metadataRows)
    .filter((candidate) => candidate.key === SNAPSHOT_ARTIFACT_KEY)
    .sort(compareArtifactCandidates);

  for (const candidate of candidates) {
    const result = await readValidatedSnapshotCandidate({
      db,
      candidate,
      readRowByKey,
      normalize: (candidate, bodyJson) =>
        normalizeHomepageArtifactBodyJson(bodyJson, candidate.generatedAt),
      cacheByDb: normalizedHomepageArtifactCacheByDb,
      globalCache: normalizedHomepageArtifactCacheGlobal,
    });
    if (result.row) {
      return result.row.generatedAt;
    }
  }

  return null;
}

export function readCachedHomepageRefreshBaseSnapshot(
  db: D1Database,
  now: number,
): HomepageRefreshBaseSnapshotReadResult | null {
  const cache = parsedHomepagePayloadCacheByDb.get(db);
  if (!cache) {
    return null;
  }

  const toCandidate = (
    key: SnapshotKey,
  ): (SnapshotCandidate & { row: ParsedSnapshotRow }) | null => {
    const row = cache.get(key);
    if (!row) {
      return null;
    }

    const candidate = {
      key,
      generatedAt: row.generatedAt,
      updatedAt: row.updatedAt,
    };
    if (
      isFutureSnapshotCandidate(candidate, now) ||
      !snapshotMatchesCandidateGeneratedAt(candidate, row.snapshot)
    ) {
      return null;
    }

    return { ...candidate, row };
  };

  const homepageCandidate = toCandidate(SNAPSHOT_KEY);
  const artifactCandidate = toCandidate(SNAPSHOT_ARTIFACT_KEY);

  if (homepageCandidate && isSameUtcDay(homepageCandidate.generatedAt, now)) {
    if (
      !artifactCandidate ||
      !isSameUtcDay(artifactCandidate.generatedAt, now) ||
      comparePayloadCandidates(artifactCandidate, homepageCandidate) >= 0
    ) {
      return {
        generatedAt: homepageCandidate.row.generatedAt,
        snapshot: homepageCandidate.row.snapshot,
        seedDataSnapshot: false,
      };
    }
  }

  if (artifactCandidate && isSameUtcDay(artifactCandidate.generatedAt, now)) {
    return {
      generatedAt: artifactCandidate.row.generatedAt,
      snapshot: artifactCandidate.row.snapshot,
      seedDataSnapshot: false,
    };
  }

  const freshestBase = [homepageCandidate, artifactCandidate]
    .filter(
      (candidate): candidate is SnapshotCandidate & { row: ParsedSnapshotRow } =>
        candidate !== null,
    )
    .sort(comparePayloadCandidates)[0];
  if (!freshestBase) {
    return null;
  }

  return {
    generatedAt: freshestBase.row.generatedAt,
    snapshot: freshestBase.row.snapshot,
    seedDataSnapshot: true,
  };
}

export async function readHomepageRefreshBaseSnapshot(
  db: D1Database,
  now: number,
): Promise<HomepageRefreshBaseSnapshotReadResult> {
  let invalid = false;
  const parsedByKey = new Map<SnapshotKey, ParsedSnapshotRow | null>();
  const rowByKey = new Map<SnapshotKey, SnapshotRefreshRow | null>();
  const readRowByKey = async (key: SnapshotKey): Promise<SnapshotRefreshRow | null> => {
    if (rowByKey.has(key)) {
      return rowByKey.get(key) ?? null;
    }

    const row = await readRefreshSnapshotRowByKey(db, key);
    rowByKey.set(key, row);
    return row;
  };
  const readRefreshCandidate = async (
    candidate: SnapshotCandidate,
  ): Promise<ParsedSnapshotRow | null> => {
    if (parsedByKey.has(candidate.key)) {
      return parsedByKey.get(candidate.key) ?? null;
    }

    if (isFutureSnapshotCandidate(candidate, now)) {
      invalid = true;
      parsedByKey.set(candidate.key, null);
      return null;
    }

    const dbCachedByVersion = readCachedParsedSnapshotRowByVersion(
      parsedHomepagePayloadCacheByDb,
      db,
      candidate,
    );
    if (dbCachedByVersion) {
      if (!snapshotMatchesCandidateGeneratedAt(candidate, dbCachedByVersion.snapshot)) {
        invalid = true;
        parsedByKey.set(candidate.key, null);
        return null;
      }
      parsedByKey.set(candidate.key, dbCachedByVersion);
      return dbCachedByVersion;
    }

    const globalCachedByVersion = readCachedParsedSnapshotRowGlobalByVersion(
      parsedHomepagePayloadCacheGlobal,
      candidate,
    );
    if (globalCachedByVersion) {
      if (!snapshotMatchesCandidateGeneratedAt(candidate, globalCachedByVersion.snapshot)) {
        invalid = true;
        parsedByKey.set(candidate.key, null);
        return null;
      }
      const parsedRow = writeCachedParsedSnapshotRow(
        parsedHomepagePayloadCacheByDb,
        db,
        candidate,
        globalCachedByVersion.rawBodyJson,
        globalCachedByVersion.snapshot,
      );
      parsedByKey.set(candidate.key, parsedRow);
      return parsedRow;
    }

    const row = await readRowByKey(candidate.key);
    if (!row?.body_json || row.generated_at !== candidate.generatedAt) {
      parsedByKey.set(candidate.key, null);
      return null;
    }

    const snapshot = parseHomepagePayloadSnapshotForKey(candidate.key, row.body_json);
    if (!snapshot || !snapshotMatchesCandidateGeneratedAt(candidate, snapshot)) {
      invalid = true;
      parsedByKey.set(candidate.key, null);
      return null;
    }

    writeCachedParsedSnapshotRowGlobal(
      parsedHomepagePayloadCacheGlobal,
      candidate,
      row.body_json,
      snapshot,
    );
    const parsedRow = writeCachedParsedSnapshotRow(
      parsedHomepagePayloadCacheByDb,
      db,
      candidate,
      row.body_json,
      snapshot,
    );
    parsedByKey.set(candidate.key, parsedRow);
    return parsedRow;
  };

  let metadataRows = await readRefreshSnapshotMetadataRows(db);
  if (metadataRows.length === 0) {
    const refreshRows = await readRefreshSnapshotRows(db);
    for (const row of refreshRows) {
      rowByKey.set(row.key, row);
    }
    metadataRows = refreshRows.map(toSnapshotRefreshMetadataRow);
  }
  const metadataByKey = new Map(metadataRows.map((row) => [row.key, row]));
  const homepageMetadata = metadataByKey.get(SNAPSHOT_KEY) ?? null;
  const artifactMetadata = metadataByKey.get(SNAPSHOT_ARTIFACT_KEY) ?? null;

  const homepageCandidate: SnapshotCandidate | null = homepageMetadata
    ? {
        key: SNAPSHOT_KEY,
        generatedAt: homepageMetadata.generated_at,
        updatedAt: toSnapshotUpdatedAt(homepageMetadata),
      }
    : null;

  if (homepageCandidate && isSameUtcDay(homepageCandidate.generatedAt, now)) {
    const homepageBase = await readRefreshCandidate(homepageCandidate);
    if (homepageBase) {
      const artifactMetadataCandidate: SnapshotCandidate | null = artifactMetadata
        ? {
            key: SNAPSHOT_ARTIFACT_KEY,
            generatedAt: artifactMetadata.generated_at,
            updatedAt: toSnapshotUpdatedAt(artifactMetadata),
          }
        : null;

      if (
        !artifactMetadataCandidate ||
        !isSameUtcDay(artifactMetadataCandidate.generatedAt, now) ||
        comparePayloadCandidates(artifactMetadataCandidate, homepageCandidate) >= 0
      ) {
        return {
          generatedAt: homepageBase.generatedAt,
          snapshot: homepageBase.snapshot,
          seedDataSnapshot: false,
        };
      }
    }
  }

  const artifactCandidate: SnapshotCandidate | null = artifactMetadata
    ? {
        key: SNAPSHOT_ARTIFACT_KEY,
        generatedAt: artifactMetadata.generated_at,
        updatedAt: toSnapshotUpdatedAt(artifactMetadata),
      }
    : null;

  if (artifactCandidate && isSameUtcDay(artifactCandidate.generatedAt, now)) {
    const artifactBase = await readRefreshCandidate(artifactCandidate);
    if (artifactBase) {
      return {
        generatedAt: artifactBase.generatedAt,
        snapshot: artifactBase.snapshot,
        seedDataSnapshot: false,
      };
    }
  }

  const orderedCandidates = [homepageCandidate, artifactCandidate]
    .filter((candidate): candidate is SnapshotCandidate => candidate !== null)
    .sort(comparePayloadCandidates);

  for (const candidate of orderedCandidates) {
    const freshestBase = await readRefreshCandidate(candidate);
    if (!freshestBase) {
      continue;
    }

    return {
      generatedAt: freshestBase.generatedAt,
      snapshot: freshestBase.snapshot,
      seedDataSnapshot: true,
    };
  }

  if (invalid) {
    console.warn('homepage snapshot: invalid refresh payload');
  }

  return {
    generatedAt: null,
    snapshot: null,
    seedDataSnapshot: true,
  };
}

export function primeHomepageRefreshBaseSnapshotCache(opts: {
  db: D1Database;
  generatedAt: number;
  updatedAt: number;
  snapshot: PublicHomepageResponse;
  renderBodyJson: string;
  payloadBodyJson?: string | null;
}): void {
  const artifactCandidate: SnapshotCandidate = {
    key: SNAPSHOT_ARTIFACT_KEY,
    generatedAt: opts.generatedAt,
    updatedAt: opts.updatedAt,
  };
  writeCachedParsedSnapshotRowGlobal(
    parsedHomepagePayloadCacheGlobal,
    artifactCandidate,
    opts.renderBodyJson,
    opts.snapshot,
  );
  writeCachedParsedSnapshotRow(
    parsedHomepagePayloadCacheByDb,
    opts.db,
    artifactCandidate,
    opts.renderBodyJson,
    opts.snapshot,
  );

  if (!opts.payloadBodyJson) {
    return;
  }

  const payloadCandidate: SnapshotCandidate = {
    key: SNAPSHOT_KEY,
    generatedAt: opts.generatedAt,
    updatedAt: opts.updatedAt,
  };
  writeCachedParsedSnapshotRowGlobal(
    parsedHomepagePayloadCacheGlobal,
    payloadCandidate,
    opts.payloadBodyJson,
    opts.snapshot,
  );
  writeCachedParsedSnapshotRow(
    parsedHomepagePayloadCacheByDb,
    opts.db,
    payloadCandidate,
    opts.payloadBodyJson,
    opts.snapshot,
  );
}

export function applyHomepageCacheHeaders(res: Response, ageSeconds: number): void {
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(30, remaining);
  const stale = Math.max(0, remaining - maxAge);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
  );
}

export async function readHomepageSnapshotJsonAnyAge(
  db: D1Database,
  now: number,
  maxStaleSeconds = MAX_STALE_SECONDS,
): Promise<{ bodyJson: string; age: number } | null> {
  const preferred = await readPreferredSnapshotCandidate({
    db,
    key: SNAPSHOT_KEY,
    now,
    maxAgeSeconds: maxStaleSeconds,
    normalize: (candidate, bodyJson) =>
      normalizeHomepagePayloadBodyJsonForKey(candidate.key, bodyJson, candidate.generatedAt),
    cacheByDb: normalizedHomepagePayloadCacheByDb,
    globalCache: normalizedHomepagePayloadCacheGlobal,
  });
  if (preferred.row && preferred.age !== null) {
    return {
      bodyJson: preferred.row.bodyJson,
      age: preferred.age,
    };
  }
  if (preferred.invalid) {
    console.warn('homepage snapshot: invalid payload');
  }

  return await readHomepageSnapshotJsonViaCandidates(db, now, maxStaleSeconds);
}

export async function readHomepageSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  return await readHomepageSnapshotJsonAnyAge(db, now, MAX_AGE_SECONDS);
}

export async function readHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const preferred = await readPreferredSnapshotCandidate({
    db,
    key: SNAPSHOT_ARTIFACT_KEY,
    now,
    maxAgeSeconds: MAX_AGE_SECONDS,
    normalize: (candidate, bodyJson) =>
      normalizeHomepageArtifactBodyJson(bodyJson, candidate.generatedAt),
    cacheByDb: normalizedHomepageArtifactCacheByDb,
    globalCache: normalizedHomepageArtifactCacheGlobal,
  });
  if (preferred.row && preferred.age !== null) {
    return {
      bodyJson: preferred.row.bodyJson,
      age: preferred.age,
    };
  }
  if (preferred.invalid) {
    console.warn('homepage snapshot: invalid artifact payload');
  }

  return await readHomepageArtifactJsonViaCandidates(db, now, MAX_AGE_SECONDS);
}

export async function readStaleHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const preferred = await readPreferredSnapshotCandidate({
    db,
    key: SNAPSHOT_ARTIFACT_KEY,
    now,
    maxAgeSeconds: MAX_STALE_SECONDS,
    normalize: (candidate, bodyJson) =>
      normalizeHomepageArtifactBodyJson(bodyJson, candidate.generatedAt),
    cacheByDb: normalizedHomepageArtifactCacheByDb,
    globalCache: normalizedHomepageArtifactCacheGlobal,
  });
  if (preferred.row && preferred.age !== null) {
    return {
      bodyJson: preferred.row.bodyJson,
      age: preferred.age,
    };
  }
  if (preferred.invalid) {
    console.warn('homepage snapshot: invalid stale artifact payload');
  }

  return await readHomepageArtifactJsonViaCandidates(db, now, MAX_STALE_SECONDS);
}

export function assertHomepageArtifactAvailable(): never {
  throw new AppError(503, 'UNAVAILABLE', 'Homepage artifact unavailable');
}
