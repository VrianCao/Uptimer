import { type PublicStatusResponse } from '../schemas/public-status';
import { storedPublicStatusResponseSchema } from '../schemas/public-status-stored';

const SNAPSHOT_KEY = 'status';
const MAX_AGE_SECONDS = 60;
const MAX_STALE_SECONDS = 10 * 60;
const FUTURE_SNAPSHOT_TOLERANCE_SECONDS = 60;

const READ_STATUS_SQL = `
  SELECT generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const READ_STATUS_METADATA_SQL = `
  SELECT generated_at, updated_at
  FROM public_snapshots
  WHERE key = ?1
`;

const readStatusStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readStatusMetadataStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const normalizedStatusCacheByDb = new WeakMap<D1Database, StatusSnapshotCacheEntry>();

type StatusSnapshotRow = {
  generated_at: number;
  updated_at?: number | null;
  body_json: string;
};

type StatusSnapshotMetadataRow = {
  generated_at: number;
  updated_at?: number | null;
};

type ParsedJsonText = {
  trimmed: string;
  value: unknown;
};

type ValidatedStatusSnapshotJson = {
  bodyJson: string;
  data: PublicStatusResponse;
};

type StatusSnapshotCacheEntry = {
  generatedAt: number;
  updatedAt: number;
  bodyJson: string;
  data: PublicStatusResponse;
};

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

function normalizeStatusSnapshotPayload(value: unknown): PublicStatusResponse | null {
  const stored = storedPublicStatusResponseSchema.safeParse(value);
  return stored.success ? stored.data : null;
}

function validateStatusSnapshotBodyJson(bodyJson: string): ValidatedStatusSnapshotJson | null {
  const parsed = parseJsonText(bodyJson);
  if (parsed === null) {
    return null;
  }

  const payload = normalizeStatusSnapshotPayload(parsed.value);
  return payload
    ? {
        bodyJson: parsed.trimmed,
        data: payload,
      }
    : null;
}

function toSnapshotUpdatedAt(row: StatusSnapshotMetadataRow): number {
  return typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
    ? row.updated_at
    : row.generated_at;
}

function readCachedStatusSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
): StatusSnapshotCacheEntry | null {
  const cached = normalizedStatusCacheByDb.get(db);
  if (!cached) {
    return null;
  }

  return cached.generatedAt === generatedAt && cached.updatedAt === updatedAt ? cached : null;
}

function writeCachedStatusSnapshot(
  db: D1Database,
  generatedAt: number,
  updatedAt: number,
  validated: ValidatedStatusSnapshotJson,
): StatusSnapshotCacheEntry {
  const cached: StatusSnapshotCacheEntry = {
    generatedAt,
    updatedAt,
    bodyJson: validated.bodyJson,
    data: validated.data,
  };
  normalizedStatusCacheByDb.set(db, cached);
  return cached;
}

async function readStatusSnapshotMetadataRow(
  db: D1Database,
): Promise<StatusSnapshotMetadataRow | null> {
  try {
    const cached = readStatusMetadataStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_STATUS_METADATA_SQL);
    if (!cached) {
      readStatusMetadataStatementByDb.set(db, statement);
    }

    return await statement.bind(SNAPSHOT_KEY).first<StatusSnapshotMetadataRow>();
  } catch {
    return null;
  }
}

async function readStatusSnapshotRow(db: D1Database): Promise<StatusSnapshotRow | null> {
  const cached = readStatusStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_STATUS_SQL);
  if (!cached) {
    readStatusStatementByDb.set(db, statement);
  }

  return await statement.bind(SNAPSHOT_KEY).first<StatusSnapshotRow>();
}

function readValidatedStatusSnapshotRow(
  db: D1Database,
  row: StatusSnapshotRow,
): StatusSnapshotCacheEntry | null {
  const updatedAt = toSnapshotUpdatedAt(row);
  const cached = readCachedStatusSnapshot(db, row.generated_at, updatedAt);
  if (cached) {
    return cached;
  }

  const validated = validateStatusSnapshotBodyJson(row.body_json);
  if (validated === null) {
    return null;
  }

  return writeCachedStatusSnapshot(db, row.generated_at, updatedAt, validated);
}

export async function readStatusSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  try {
    const metadata = await readStatusSnapshotMetadataRow(db);
    if (!metadata) {
      const row = await readStatusSnapshotRow(db);
      if (!row) return null;
      if (row.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

      const age = Math.max(0, now - row.generated_at);
      if (age > MAX_AGE_SECONDS) return null;

      const validated = readValidatedStatusSnapshotRow(db, row);
      if (validated === null) {
        console.warn('public snapshot: invalid JSON, falling back to live');
        return null;
      }
      return { bodyJson: validated.bodyJson, age };
    }
    if (metadata.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

    const age = Math.max(0, now - metadata.generated_at);
    if (age > MAX_AGE_SECONDS) return null;

    const updatedAt = toSnapshotUpdatedAt(metadata);
    const cached = readCachedStatusSnapshot(db, metadata.generated_at, updatedAt);
    if (cached) {
      return { bodyJson: cached.bodyJson, age };
    }

    const row = await readStatusSnapshotRow(db);
    if (
      !row ||
      row.generated_at !== metadata.generated_at ||
      toSnapshotUpdatedAt(row) !== updatedAt
    ) {
      return null;
    }

    const validated = readValidatedStatusSnapshotRow(db, row);
    if (validated === null) {
      console.warn('public snapshot: invalid JSON, falling back to live');
      return null;
    }

    return { bodyJson: validated.bodyJson, age };
  } catch (err) {
    console.warn('public snapshot: read failed, falling back to live', err);
    return null;
  }
}

export async function readStatusSnapshotPayloadAnyAge(
  db: D1Database,
  now: number,
  maxAgeSeconds = MAX_STALE_SECONDS,
): Promise<{ data: PublicStatusResponse; bodyJson: string; age: number } | null> {
  try {
    const metadata = await readStatusSnapshotMetadataRow(db);
    if (!metadata) {
      const row = await readStatusSnapshotRow(db);
      if (!row) return null;
      if (row.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

      const age = Math.max(0, now - row.generated_at);
      if (age > maxAgeSeconds) return null;

      const validated = readValidatedStatusSnapshotRow(db, row);
      if (validated === null) return null;
      return { data: validated.data, bodyJson: validated.bodyJson, age };
    }
    if (metadata.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

    const age = Math.max(0, now - metadata.generated_at);
    if (age > maxAgeSeconds) return null;

    const updatedAt = toSnapshotUpdatedAt(metadata);
    const cached = readCachedStatusSnapshot(db, metadata.generated_at, updatedAt);
    if (cached) {
      return { data: cached.data, bodyJson: cached.bodyJson, age };
    }

    const row = await readStatusSnapshotRow(db);
    if (
      !row ||
      row.generated_at !== metadata.generated_at ||
      toSnapshotUpdatedAt(row) !== updatedAt
    ) {
      return null;
    }

    const validated = readValidatedStatusSnapshotRow(db, row);
    if (validated === null) return null;

    return { data: validated.data, bodyJson: validated.bodyJson, age };
  } catch {
    return null;
  }
}

export function readCachedStatusSnapshotPayloadAnyAge(
  db: D1Database,
  now: number,
  maxAgeSeconds = MAX_STALE_SECONDS,
): { data: PublicStatusResponse; bodyJson: string; age: number } | null {
  const cached = normalizedStatusCacheByDb.get(db);
  if (!cached) return null;
  if (cached.generatedAt > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

  const age = Math.max(0, now - cached.generatedAt);
  if (age > maxAgeSeconds) return null;

  return { data: cached.data, bodyJson: cached.bodyJson, age };
}

export async function readStaleStatusSnapshotJson(
  db: D1Database,
  now: number,
  maxStaleSeconds = MAX_STALE_SECONDS,
): Promise<{ bodyJson: string; age: number } | null> {
  try {
    const metadata = await readStatusSnapshotMetadataRow(db);
    if (!metadata) {
      const row = await readStatusSnapshotRow(db);
      if (!row) return null;
      if (row.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

      const age = Math.max(0, now - row.generated_at);
      if (age > maxStaleSeconds) return null;

      const validated = readValidatedStatusSnapshotRow(db, row);
      if (validated === null) return null;
      return { bodyJson: validated.bodyJson, age };
    }
    if (metadata.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

    const age = Math.max(0, now - metadata.generated_at);
    if (age > maxStaleSeconds) return null;

    const updatedAt = toSnapshotUpdatedAt(metadata);
    const cached = readCachedStatusSnapshot(db, metadata.generated_at, updatedAt);
    if (cached) {
      return { bodyJson: cached.bodyJson, age };
    }

    const row = await readStatusSnapshotRow(db);
    if (
      !row ||
      row.generated_at !== metadata.generated_at ||
      toSnapshotUpdatedAt(row) !== updatedAt
    ) {
      return null;
    }

    const validated = readValidatedStatusSnapshotRow(db, row);
    if (validated === null) return null;

    return { bodyJson: validated.bodyJson, age };
  } catch {
    return null;
  }
}

export function applyStatusCacheHeaders(res: Response, ageSeconds: number): void {
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(30, remaining);
  const stale = Math.max(0, remaining - maxAge);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
  );
}

export function primeStatusSnapshotCache(opts: {
  db: D1Database;
  generatedAt: number;
  updatedAt: number;
  bodyJson: string;
  data: PublicStatusResponse;
}): void {
  normalizedStatusCacheByDb.set(opts.db, {
    generatedAt: opts.generatedAt,
    updatedAt: opts.updatedAt,
    bodyJson: opts.bodyJson,
    data: opts.data,
  });
}
