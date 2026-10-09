import { AppError } from '../middleware/errors';
import type { Trace } from '../observability/trace';
import { publicStatusResponseSchema, type PublicStatusResponse } from '../schemas/public-status';
import { primeStatusSnapshotCache } from './public-status-read';

const SNAPSHOT_KEY = 'status';
const MAX_AGE_SECONDS = 60;
const FUTURE_SNAPSHOT_TOLERANCE_SECONDS = 60;
const READ_STATUS_SQL = `
  SELECT generated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const UPSERT_STATUS_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshots.generated_at
    OR public_snapshots.generated_at > ?5
`;
const UPSERT_STATUS_AFTER_HOMEPAGE_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  SELECT ?1, ?2, ?3, ?4
  WHERE EXISTS (
    SELECT 1
    FROM public_snapshots homepage_snapshot
    WHERE homepage_snapshot.key = ?6
      AND homepage_snapshot.generated_at = ?7
      AND homepage_snapshot.updated_at = ?8
  )
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE (
      excluded.generated_at >= public_snapshots.generated_at
      OR public_snapshots.generated_at > ?5
    )
    AND EXISTS (
      SELECT 1
      FROM public_snapshots homepage_snapshot
      WHERE homepage_snapshot.key = ?6
        AND homepage_snapshot.generated_at = ?7
        AND homepage_snapshot.updated_at = ?8
    )
`;
const UPSERT_STATUS_AFTER_HOMEPAGE_AND_LEASE_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  SELECT ?1, ?2, ?3, ?4
  WHERE EXISTS (
    SELECT 1
    FROM public_snapshots homepage_snapshot
    WHERE homepage_snapshot.key = ?6
      AND homepage_snapshot.generated_at = ?7
      AND homepage_snapshot.updated_at = ?8
  )
    AND EXISTS (
      SELECT 1
      FROM locks refresh_lock
      WHERE refresh_lock.name = ?9
        AND refresh_lock.expires_at = ?10
        AND refresh_lock.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
    )
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE (
      excluded.generated_at >= public_snapshots.generated_at
      OR public_snapshots.generated_at > ?5
    )
    AND EXISTS (
      SELECT 1
      FROM public_snapshots homepage_snapshot
      WHERE homepage_snapshot.key = ?6
        AND homepage_snapshot.generated_at = ?7
        AND homepage_snapshot.updated_at = ?8
    )
    AND EXISTS (
      SELECT 1
      FROM locks refresh_lock
      WHERE refresh_lock.name = ?9
        AND refresh_lock.expires_at = ?10
        AND refresh_lock.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
    )
`;

const readStatusStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertStatusStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertStatusAfterHomepageStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertStatusAfterHomepageAndLeaseStatementByDb = new WeakMap<
  D1Database,
  D1PreparedStatement
>();

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

export function getSnapshotKey() {
  return SNAPSHOT_KEY;
}

export function getSnapshotMaxAgeSeconds() {
  return MAX_AGE_SECONDS;
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function normalizeStatusSnapshotPayload(value: unknown): PublicStatusResponse | null {
  const parsed = publicStatusResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeStatusSnapshotBodyJson(bodyJson: string): string | null {
  const parsed = safeJsonParse(bodyJson);
  if (parsed === null) {
    return null;
  }

  const payload = normalizeStatusSnapshotPayload(parsed);
  return payload ? JSON.stringify(payload) : null;
}

export async function readStatusSnapshot(
  db: D1Database,
  now: number,
): Promise<{ data: PublicStatusResponse; age: number } | null> {
  try {
    const cached = readStatusStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_STATUS_SQL);
    if (!cached) {
      readStatusStatementByDb.set(db, statement);
    }

    const row = await statement
      .bind(SNAPSHOT_KEY)
      .first<{ generated_at: number; body_json: string }>();

    if (!row) return null;
    if (row.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > MAX_AGE_SECONDS) return null;

    const parsed = safeJsonParse(row.body_json);
    if (parsed === null) {
      console.warn('public snapshot: invalid JSON, falling back to live');
      return null;
    }
    const payload = normalizeStatusSnapshotPayload(parsed);
    if (!payload) {
      console.warn('public snapshot: invalid payload, falling back to live');
      return null;
    }
    return { data: payload, age };
  } catch (err) {
    // Backward compatible: if the table doesn't exist yet or snapshot is invalid,
    // callers should fall back to live computation.
    console.warn('public snapshot: read failed, falling back to live', err);
    return null;
  }
}

export async function readStatusSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  try {
    const cached = readStatusStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_STATUS_SQL);
    if (!cached) {
      readStatusStatementByDb.set(db, statement);
    }

    const row = await statement
      .bind(SNAPSHOT_KEY)
      .first<{ generated_at: number; body_json: string }>();

    if (!row) return null;
    if (row.generated_at > now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > MAX_AGE_SECONDS) return null;

    const bodyJson = normalizeStatusSnapshotBodyJson(row.body_json);
    if (!bodyJson) {
      console.warn('public snapshot: invalid payload, falling back to live');
      return null;
    }
    return { bodyJson, age };
  } catch (err) {
    console.warn('public snapshot: read failed, falling back to live', err);
    return null;
  }
}

export async function writeStatusSnapshot(
  db: D1Database,
  now: number,
  payload: PublicStatusResponse,
  trace?: Trace,
): Promise<void> {
  const prepared = prepareStatusSnapshotWrite({ db, now, payload, ...(trace ? { trace } : {}) });
  const result = await withTraceAsync(
    trace,
    'status_write_run',
    async () => await prepared.statement.run(),
  );
  if (didApplyStatusSnapshotWrite(result)) {
    prepared.prime();
  }
}

export function didApplyStatusSnapshotWrite(
  result: Awaited<ReturnType<D1PreparedStatement['run']>> | undefined,
): boolean {
  const changes = result?.meta?.changes;
  if (typeof changes === 'number' && Number.isFinite(changes)) {
    return changes > 0;
  }
  return result !== undefined;
}

export type PreparedStatusSnapshotWrite = {
  statement: D1PreparedStatement;
  prime: () => void;
};

function bindStatusSnapshotUpsert(
  db: D1Database,
  now: number,
  bodyJson: string,
  generatedAt: number,
): D1PreparedStatement {
  const cached = upsertStatusStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_STATUS_SQL);
  if (!cached) {
    upsertStatusStatementByDb.set(db, statement);
  }

  return statement.bind(
    SNAPSHOT_KEY,
    generatedAt,
    bodyJson,
    now,
    now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
  );
}

function bindStatusSnapshotAfterHomepageUpsert(opts: {
  db: D1Database;
  now: number;
  bodyJson: string;
  generatedAt: number;
  homepageSnapshotKey: string;
  homepageGeneratedAt: number;
  homepageUpdatedAt: number;
  homepageLease?: {
    name: string;
    expiresAt: number;
  };
}): D1PreparedStatement {
  const cached = opts.homepageLease
    ? upsertStatusAfterHomepageAndLeaseStatementByDb.get(opts.db)
    : upsertStatusAfterHomepageStatementByDb.get(opts.db);
  const statement =
    cached ??
    opts.db.prepare(
      opts.homepageLease
        ? UPSERT_STATUS_AFTER_HOMEPAGE_AND_LEASE_SQL
        : UPSERT_STATUS_AFTER_HOMEPAGE_SQL,
    );
  if (!cached) {
    if (opts.homepageLease) {
      upsertStatusAfterHomepageAndLeaseStatementByDb.set(opts.db, statement);
    } else {
      upsertStatusAfterHomepageStatementByDb.set(opts.db, statement);
    }
  }

  const args = [
    SNAPSHOT_KEY,
    opts.generatedAt,
    opts.bodyJson,
    opts.now,
    opts.now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
    opts.homepageSnapshotKey,
    opts.homepageGeneratedAt,
    opts.homepageUpdatedAt,
  ];
  if (opts.homepageLease) {
    args.push(opts.homepageLease.name, opts.homepageLease.expiresAt);
  }

  return statement.bind(...args);
}

export function prepareStatusSnapshotWrite(opts: {
  db: D1Database;
  now: number;
  payload: PublicStatusResponse;
  trace?: Trace;
  afterHomepage?: {
    key: string;
    generatedAt: number;
    updatedAt: number;
    lease?: {
      name: string;
      expiresAt: number;
    };
  };
}): PreparedStatusSnapshotWrite {
  const bodyJson = withTraceSync(opts.trace, 'status_write_stringify', () =>
    JSON.stringify(opts.payload),
  );
  if (opts.trace?.enabled) {
    opts.trace.setLabel('status_payload_monitors', opts.payload.monitors.length);
    opts.trace.setLabel('status_payload_bytes', bodyJson.length);
  }
  const statement = opts.afterHomepage
    ? bindStatusSnapshotAfterHomepageUpsert({
        db: opts.db,
        now: opts.now,
        bodyJson,
        generatedAt: opts.payload.generated_at,
        homepageSnapshotKey: opts.afterHomepage.key,
        homepageGeneratedAt: opts.afterHomepage.generatedAt,
        homepageUpdatedAt: opts.afterHomepage.updatedAt,
        ...(opts.afterHomepage.lease ? { homepageLease: opts.afterHomepage.lease } : {}),
      })
    : bindStatusSnapshotUpsert(opts.db, opts.now, bodyJson, opts.payload.generated_at);

  return {
    statement,
    prime: () => {
      primeStatusSnapshotCache({
        db: opts.db,
        generatedAt: opts.payload.generated_at,
        updatedAt: opts.now,
        bodyJson,
        data: opts.payload,
      });
    },
  };
}

export function applyStatusCacheHeaders(res: Response, ageSeconds: number): void {
  // Guarantee freshness bound <= 60s. Prefer <= 30s in normal cases.
  //
  // We ensure (max-age + stale-*) never exceeds MAX_AGE_SECONDS.
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(30, remaining);
  const stale = Math.max(0, remaining - maxAge);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
  );
}

export function toSnapshotPayload(value: unknown): PublicStatusResponse {
  const parsed = publicStatusResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, 'INTERNAL', 'Failed to generate status snapshot');
  }
  return parsed.data;
}
