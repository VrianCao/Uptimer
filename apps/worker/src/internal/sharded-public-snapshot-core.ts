import { z } from 'zod';
import type { PublicStatusGenerationContext } from '../public/status';
import type { Env } from '../env';
import { usesBoundedPublicSeeds, usesCombinedPublicSeeds } from '../public/refresh-profile';
import { batchSnapshotReads } from '../public/batched-reads';
import type { PublicHomepageResponse } from '../schemas/public-homepage';
import type { PublicStatusResponse } from '../schemas/public-status';
import {
  writePublicSnapshotFragments,
  type PublicSnapshotFragmentWrite,
} from '../snapshots/public-fragments';
import {
  assemblePublicHomepagePayloadFromFragments,
  assemblePublicStatusPayloadFromFragments,
  buildHomepageEnvelopeFragmentWrite,
  buildHomepageMonitorFragmentWrites,
  buildStatusEnvelopeFragmentWrite,
  buildStatusMonitorFragmentWrites,
  readHomepageSnapshotBodyJsonFromFragments,
  readHomepageSnapshotFragments,
  readStatusSnapshotBodyJsonFromFragments,
  readStatusSnapshotFragments,
  parseStatusEnvelopeFragmentRows,
} from '../snapshots/public-monitor-fragments';

const seedContextSchema = z.object({
  source_maintenance_monitor_ids: z.array(z.number().int().positive()),
  source_range_start_at: z.number().int().nonnegative().optional(),
});
const validatedGenerationContexts = new Map<string, PublicStatusGenerationContext>();

async function readStatusGenerationContext(
  env: Env,
  now: number,
): Promise<PublicStatusGenerationContext | undefined> {
  const { readPublicSnapshotFragments } = await import('../snapshots/public-fragments');
  const rows = await readPublicSnapshotFragments(env.DB, 'status:envelope', now);
  const row = rows.find((row) => row.generated_at === now && row.fragment_key === 'envelope');
  if (!row) return undefined;
  const cached = validatedGenerationContexts.get(row.body_json);
  if (cached?.envelope.generated_at === now) return cached;
  const parsed = parseStatusEnvelopeFragmentRows(rows);
  if (!parsed || parsed.generatedAt !== now) return undefined;
  let source: unknown;
  try {
    source = JSON.parse(row.body_json);
  } catch {
    return undefined;
  }
  const context = seedContextSchema.safeParse(source);
  if (!context.success || (context.data.source_range_start_at ?? 0) > now) return undefined;
  const { monitor_ids: _monitorIds, ...envelope } = parsed.data;
  const result = {
    envelope,
    maintenanceMonitorIds: context.data.source_maintenance_monitor_ids,
    ...(context.data.source_range_start_at !== undefined
      ? { monitorIds: parsed.data.monitor_ids, rangeStart: context.data.source_range_start_at }
      : {}),
  };
  if (validatedGenerationContexts.size >= 8)
    validatedGenerationContexts.delete(validatedGenerationContexts.keys().next().value!);
  validatedGenerationContexts.set(row.body_json, result);
  return result;
}

export type ShardedPublicSnapshotKind = 'homepage' | 'status';
export type ShardedPublicSnapshotAssemblyMode = 'validated' | 'json';
export type ShardedPublicSnapshotSeedPart = 'envelope' | 'monitors' | 'all';

export type ShardedPublicSnapshotAssembleOptions = {
  env: Env;
  kind: ShardedPublicSnapshotKind;
  mode?: ShardedPublicSnapshotAssemblyMode;
  measureBodyBytes?: boolean;
  publish?: boolean;
  publishArtifact?: boolean;
  now?: number;
};

export type ShardedPublicSnapshotAssembleResult = {
  ok: boolean;
  assembled: boolean;
  kind: ShardedPublicSnapshotKind;
  generatedAt?: number;
  monitorCount: number;
  invalidCount: number;
  staleCount: number;
  mode: ShardedPublicSnapshotAssemblyMode;
  bodyBytes?: number | undefined;
  published?: boolean;
  artifactPublished?: boolean;
  writeCount?: number;
  skip?: 'missing_envelope' | 'missing_monitors' | 'invalid_payload';
  error?: boolean;
  errorName?: string;
  errorMessage?: string;
};

export type ShardedPublicSnapshotSeedOptions = {
  env: Env;
  kind: ShardedPublicSnapshotKind;
  part: ShardedPublicSnapshotSeedPart;
  now: number;
  offset?: number;
  limit?: number;
};

export type ShardedPublicSnapshotSeedResult = {
  ok: boolean;
  seeded: boolean;
  kind: ShardedPublicSnapshotKind;
  part: ShardedPublicSnapshotSeedPart;
  generatedAt?: number;
  monitorCount: number;
  monitorOffset: number;
  monitorLimit: number;
  writeCount: number;
  skipped?: 'missing_snapshot' | 'empty_batch';
  error?: boolean;
};

export type ShardedHomepageArtifactPublishResult = {
  ok: boolean;
  published: boolean;
  artifactPublished: boolean;
  generatedAt?: number;
  monitorCount: number;
  writeCount: number;
  skip?:
    | 'missing_homepage'
    | 'stale_homepage'
    | 'current_artifact'
    | 'invalid_payload'
    | 'missing_artifact_fragments';
  error?: boolean;
  errorName?: string;
  errorMessage?: string;
};

function measuredBodyBytes(value: unknown, enabled: boolean): number | undefined {
  if (!enabled) {
    return undefined;
  }
  return JSON.stringify(value).length;
}

function toErrorInfo(err: unknown): { errorName: string; errorMessage: string } {
  if (err instanceof Error) {
    return {
      errorName: err.name || 'Error',
      errorMessage: err.message || 'Unknown error',
    };
  }
  return {
    errorName: typeof err,
    errorMessage: String(err),
  };
}

function bodyJsonBytes(bodyJson: string, enabled: boolean): number | undefined {
  return enabled ? bodyJson.length : undefined;
}

function isTruthyEnvFlag(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldWriteHomepageArtifactFragments(env: Env): boolean {
  const raw = (env as unknown as Record<string, unknown>)
    .UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES;
  return isTruthyEnvFlag(raw);
}

function shouldSeedHomepageFromRuntimeSnapshot(env: Env): boolean {
  const raw = (env as unknown as Record<string, unknown>)
    .UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED;
  return isTruthyEnvFlag(raw);
}

const RAW_PUBLIC_SNAPSHOT_FUTURE_TOLERANCE_SECONDS = 60;
const READ_RAW_PUBLIC_SNAPSHOT_SQL = `
  SELECT generated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const READ_RAW_PUBLIC_SNAPSHOT_GENERATED_AT_SQL = `
  SELECT generated_at
  FROM public_snapshots
  WHERE key = ?1
`;
const UPSERT_RAW_PUBLIC_SNAPSHOT_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE (excluded.generated_at >= public_snapshots.generated_at
    AND (excluded.generated_at != public_snapshots.generated_at
      OR excluded.body_json != public_snapshots.body_json))
    OR public_snapshots.generated_at > ?5
`;
type PublicSnapshotPublishKey = 'homepage' | 'homepage:artifact' | 'status';
const rawPublicSnapshotReadStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const rawPublicSnapshotGeneratedAtStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const rawPublicSnapshotUpsertStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

function publicSnapshotKeyForKind(kind: ShardedPublicSnapshotKind): 'homepage' | 'status' {
  return kind === 'homepage' ? 'homepage' : 'status';
}

function rawPublicSnapshotReadStatement(
  db: D1Database,
  key: PublicSnapshotPublishKey,
): D1PreparedStatement {
  const cached = rawPublicSnapshotReadStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_RAW_PUBLIC_SNAPSHOT_SQL);
  if (!cached) {
    rawPublicSnapshotReadStatementByDb.set(db, statement);
  }
  return statement.bind(key);
}

function rawPublicSnapshotGeneratedAtStatement(
  db: D1Database,
  key: PublicSnapshotPublishKey,
): D1PreparedStatement {
  const cached = rawPublicSnapshotGeneratedAtStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_RAW_PUBLIC_SNAPSHOT_GENERATED_AT_SQL);
  if (!cached) {
    rawPublicSnapshotGeneratedAtStatementByDb.set(db, statement);
  }
  return statement.bind(key);
}

function rawPublicSnapshotUpsertStatement(
  db: D1Database,
  key: PublicSnapshotPublishKey,
  generatedAt: number,
  bodyJson: string,
  updatedAt: number,
): D1PreparedStatement {
  const cached = rawPublicSnapshotUpsertStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_RAW_PUBLIC_SNAPSHOT_SQL);
  if (!cached) {
    rawPublicSnapshotUpsertStatementByDb.set(db, statement);
  }
  return statement.bind(
    key,
    generatedAt,
    bodyJson,
    updatedAt,
    updatedAt + RAW_PUBLIC_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
  );
}

function didApplySnapshotWrite(result: D1Result): boolean {
  const changed = result.meta?.changes;
  return typeof changed === 'number' ? changed > 0 : true;
}

async function readRawPublicSnapshotRow(
  env: Env,
  key: PublicSnapshotPublishKey,
): Promise<{ generated_at: number; body_json: string } | null> {
  const row = await rawPublicSnapshotReadStatement(env.DB, key).first<{
    generated_at: number;
    body_json: string;
  }>();
  if (!row || !Number.isFinite(row.generated_at) || typeof row.body_json !== 'string') {
    return null;
  }
  return row;
}

async function readRawPublicSnapshotGeneratedAt(
  env: Env,
  key: PublicSnapshotPublishKey,
): Promise<number | null> {
  const row = await rawPublicSnapshotGeneratedAtStatement(env.DB, key).first<{
    generated_at: number;
  }>();
  return row && Number.isFinite(row.generated_at) ? row.generated_at : null;
}

async function publishRawPublicSnapshot(opts: {
  env: Env;
  kind: ShardedPublicSnapshotKind;
  generatedAt: number;
  bodyJson: string;
  now: number;
}): Promise<boolean> {
  const updatedAt = Math.max(opts.now, Math.floor(Date.now() / 1000));
  const result = await rawPublicSnapshotUpsertStatement(
    opts.env.DB,
    publicSnapshotKeyForKind(opts.kind),
    opts.generatedAt,
    opts.bodyJson,
    updatedAt,
  ).run();
  return didApplySnapshotWrite(result);
}

async function publishRawHomepageArtifactSnapshot(opts: {
  env: Env;
  generatedAt: number;
  bodyJson: string;
  now: number;
}): Promise<ShardedHomepageArtifactPublishResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(opts.bodyJson) as unknown;
  } catch {
    return {
      ok: true,
      published: false,
      artifactPublished: false,
      monitorCount: 0,
      writeCount: 0,
      skip: 'invalid_payload',
    };
  }

  const [
    { storedPublicHomepageResponseSchema },
    {
      HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY,
      buildHomepageRenderArtifact,
      buildHomepageRenderArtifactFromMonitorFragments,
    },
  ] = await Promise.all([
    import('../schemas/public-homepage-stored'),
    import('../snapshots/public-homepage'),
  ]);
  const parsed = storedPublicHomepageResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.generated_at !== opts.generatedAt) {
    return {
      ok: true,
      published: false,
      artifactPublished: false,
      monitorCount: 0,
      writeCount: 0,
      skip: 'invalid_payload',
    };
  }

  let artifact: ReturnType<typeof buildHomepageRenderArtifact> | null = null;
  if (shouldWriteHomepageArtifactFragments(opts.env)) {
    const { readPublicSnapshotFragments } = await import('../snapshots/public-fragments');
    const rows = await readPublicSnapshotFragments(
      opts.env.DB,
      HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY,
      opts.generatedAt,
    );
    // Earlier layouts and page sizes remain readable during an upgrade. Only
    // fragments belonging to this publication can satisfy its card set.
    const monitorKeys = new Set(parsed.data.monitors.map((m) => `monitor:${m.id}`));
    const currentRows = rows.filter(
      (row) => row.generated_at === parsed.data.generated_at && monitorKeys.has(row.fragment_key),
    );
    const preRendered = buildHomepageRenderArtifactFromMonitorFragments(parsed.data, currentRows);
    artifact = preRendered.artifact;
    if (!artifact) {
      return {
        ok: true,
        published: false,
        artifactPublished: false,
        generatedAt: parsed.data.generated_at,
        monitorCount: parsed.data.monitors.length,
        writeCount: 0,
        skip: 'missing_artifact_fragments',
      };
    }
  } else {
    artifact = buildHomepageRenderArtifact(parsed.data);
  }
  // The canonical full snapshot has already passed runtime validation above.
  // Keep its JSON text rather than serializing every heartbeat/day a second time.
  const artifactJson =
    parsed.data.bootstrap_mode === 'full' &&
    parsed.data.monitor_count_total === parsed.data.monitors.length
      ? `${JSON.stringify({ generated_at: artifact.generated_at, preload_html: artifact.preload_html }).slice(0, -1)},"snapshot":${opts.bodyJson},${JSON.stringify({ meta_title: artifact.meta_title, meta_description: artifact.meta_description }).slice(1)}`
      : JSON.stringify(artifact);
  const updatedAt = Math.max(opts.now, Math.floor(Date.now() / 1000));
  const result = await rawPublicSnapshotUpsertStatement(
    opts.env.DB,
    'homepage:artifact',
    artifact.generated_at,
    artifactJson,
    updatedAt,
  ).run();
  const published = didApplySnapshotWrite(result);
  return {
    ok: true,
    published,
    artifactPublished: published,
    generatedAt: artifact.generated_at,
    monitorCount: parsed.data.monitors.length,
    writeCount: published ? 1 : 0,
  };
}

export async function publishHomepageArtifactSnapshotFromPublishedHomepage(opts: {
  env: Env;
  now: number;
  generatedAt?: number;
}): Promise<ShardedHomepageArtifactPublishResult> {
  try {
    const homepageGeneratedAt = await readRawPublicSnapshotGeneratedAt(opts.env, 'homepage');
    if (homepageGeneratedAt === null) {
      return {
        ok: true,
        published: false,
        artifactPublished: false,
        monitorCount: 0,
        writeCount: 0,
        skip: 'missing_homepage',
      };
    }
    if (opts.generatedAt !== undefined && homepageGeneratedAt < opts.generatedAt) {
      return {
        ok: true,
        published: false,
        artifactPublished: false,
        generatedAt: homepageGeneratedAt,
        monitorCount: 0,
        writeCount: 0,
        skip: 'stale_homepage',
      };
    }
    const artifactGeneratedAt = await readRawPublicSnapshotGeneratedAt(
      opts.env,
      'homepage:artifact',
    );
    if (artifactGeneratedAt !== null && artifactGeneratedAt >= homepageGeneratedAt) {
      return {
        ok: true,
        published: false,
        artifactPublished: false,
        generatedAt: artifactGeneratedAt,
        monitorCount: 0,
        writeCount: 0,
        skip: 'current_artifact',
      };
    }

    const row = await readRawPublicSnapshotRow(opts.env, 'homepage');
    if (!row) {
      return {
        ok: true,
        published: false,
        artifactPublished: false,
        monitorCount: 0,
        writeCount: 0,
        skip: 'missing_homepage',
      };
    }
    return await publishRawHomepageArtifactSnapshot({
      env: opts.env,
      generatedAt: row.generated_at,
      bodyJson: row.body_json,
      now: opts.now,
    });
  } catch (err) {
    console.warn('internal sharded homepage artifact publish failed', err);
    const errorInfo = toErrorInfo(err);
    return {
      ok: false,
      published: false,
      artifactPublished: false,
      monitorCount: 0,
      writeCount: 0,
      error: true,
      ...errorInfo,
    };
  }
}

function normalizeSliceBounds(
  offset: number | undefined,
  limit: number | undefined,
): {
  offset: number;
  limit: number;
} {
  return {
    offset: Math.max(0, Math.floor(offset ?? 0)),
    limit: Math.max(1, Math.min(10, Math.floor(limit ?? 5))),
  };
}

function selectMonitorIds(
  payload: PublicHomepageResponse | PublicStatusResponse,
  offset: number,
  limit: number,
): number[] {
  return payload.monitors.slice(offset, offset + limit).map((monitor) => monitor.id);
}

async function readHomepageSeedPayload(
  env: Env,
  now: number,
): Promise<PublicHomepageResponse | null> {
  const { readHomepageRefreshBaseSnapshot } = await import('../snapshots/public-homepage-read');
  const base = await readHomepageRefreshBaseSnapshot(env.DB, now);
  if (!base.snapshot || !shouldSeedHomepageFromRuntimeSnapshot(env)) {
    return base.snapshot;
  }

  try {
    const [
      { tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates },
      { readPublicMonitorRuntimeSnapshot },
    ] = await Promise.all([import('../public/homepage'), import('../public/monitor-runtime')]);
    const runtimeSnapshot = await readPublicMonitorRuntimeSnapshot(env.DB, now);
    const seedNow = runtimeSnapshot?.generated_at ?? now;
    return (
      (await tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
        db: env.DB,
        now: seedNow,
        baseSnapshot: base.snapshot,
        baseSnapshotBodyJson: null,
        updates: [],
      })) ?? base.snapshot
    );
  } catch (err) {
    console.warn('internal sharded homepage runtime seed failed', err);
    return base.snapshot;
  }
}

async function readStatusSeedPayload(env: Env, now: number): Promise<PublicStatusResponse | null> {
  const { readStatusSnapshotPayloadAnyAge } = await import('../snapshots/public-status-read');
  return (await readStatusSnapshotPayloadAnyAge(env.DB, now))?.data ?? null;
}

function buildSeedWrites(opts: {
  kind: ShardedPublicSnapshotKind;
  part: ShardedPublicSnapshotSeedPart;
  payload: PublicHomepageResponse | PublicStatusResponse;
  monitorIds: number[];
  now: number;
  allMonitorIds?: number[];
}): PublicSnapshotFragmentWrite[] {
  if (opts.kind === 'homepage') {
    const payload = opts.payload as PublicHomepageResponse;
    return [
      ...(opts.part === 'envelope' || opts.part === 'all'
        ? [buildHomepageEnvelopeFragmentWrite(payload, opts.now, opts.allMonitorIds)]
        : []),
      ...(opts.part === 'monitors' || opts.part === 'all'
        ? buildHomepageMonitorFragmentWrites(payload, opts.now, opts.monitorIds)
        : []),
    ];
  }

  const payload = opts.payload as PublicStatusResponse;
  return [
    ...(opts.part === 'envelope' || opts.part === 'all'
      ? [buildStatusEnvelopeFragmentWrite(payload, opts.now, opts.allMonitorIds)]
      : []),
    ...(opts.part === 'monitors' || opts.part === 'all'
      ? buildStatusMonitorFragmentWrites(payload, opts.now, opts.monitorIds)
      : []),
  ];
}

export async function seedShardedPublicSnapshotFragments(
  opts: ShardedPublicSnapshotSeedOptions,
): Promise<ShardedPublicSnapshotSeedResult> {
  const { offset, limit } = normalizeSliceBounds(opts.offset, opts.limit);
  try {
    // With the normal refresh disabled, static snapshots are outputs, never inputs.
    // Calculate history for only this page; summary/config still cover all visible monitors.
    const boundedRefresh = usesBoundedPublicSeeds(opts.env);
    const combined = usesCombinedPublicSeeds(opts.env) && opts.kind === 'homepage';
    let combinedStatus: PublicStatusResponse | undefined;
    let allMonitorIds: number[] | undefined;
    let maintenanceMonitorIds: number[] | undefined;
    let rangeStart: number | undefined;
    const seedOptions = {
      runtimeSnapshot: null,
      monitorSlice: { offset, limit: opts.part === 'envelope' ? 0 : limit },
      onMaintenanceMonitorIds: (ids: number[]) => {
        maintenanceMonitorIds = ids;
      },
      onMonitorIds: (ids: number[]) => {
        allMonitorIds = ids;
      },
      onRangeStart: (at: number) => {
        rangeStart = at;
      },
    };
    const payload = boundedRefresh
      ? combined
        ? await (async () => {
            const [
              { computePublicStatusPayload },
              { homepageFromStatusPayload, readHomepageHistoryPreviews },
            ] = await Promise.all([import('../public/status'), import('../public/homepage')]);
            const generationContext =
              opts.part === 'monitors'
                ? await readStatusGenerationContext(opts.env, opts.now)
                : undefined;
            const db = batchSnapshotReads(opts.env.DB);
            const [status, previews] = await Promise.all([
              computePublicStatusPayload(db, opts.now, {
                ...seedOptions,
                ...(generationContext ? { generationContext } : {}),
              }),
              opts.part === 'envelope' || opts.part === 'all'
                ? readHomepageHistoryPreviews(db, opts.now)
                : Promise.resolve({}),
            ]);
            combinedStatus = status;
            const homepage = homepageFromStatusPayload(combinedStatus, previews);
            homepage.monitor_count_total = allMonitorIds?.length ?? combinedStatus.monitors.length;
            return homepage;
          })()
        : opts.kind === 'homepage'
          ? await (
              await import('../public/homepage')
            ).computePublicHomepagePayload(opts.env.DB, opts.now, seedOptions)
          : await (
              await import('../public/status')
            ).computePublicStatusPayload(opts.env.DB, opts.now, seedOptions)
      : opts.kind === 'homepage'
        ? await readHomepageSeedPayload(opts.env, opts.now)
        : await readStatusSeedPayload(opts.env, opts.now);
    if (!payload) {
      return {
        ok: true,
        seeded: false,
        kind: opts.kind,
        part: opts.part,
        monitorCount: 0,
        monitorOffset: offset,
        monitorLimit: limit,
        writeCount: 0,
        skipped: 'missing_snapshot',
      };
    }

    const monitorIds = boundedRefresh
      ? payload.monitors.map((monitor) => monitor.id)
      : selectMonitorIds(payload, offset, limit);
    const monitorCount = allMonitorIds?.length ?? payload.monitors.length;
    if ((opts.part === 'monitors' || opts.part === 'all') && monitorIds.length === 0) {
      return {
        ok: true,
        seeded: false,
        kind: opts.kind,
        part: opts.part,
        generatedAt: payload.generated_at,
        monitorCount,
        monitorOffset: offset,
        monitorLimit: limit,
        writeCount: 0,
        skipped: 'empty_batch',
      };
    }

    const writes = buildSeedWrites({
      kind: opts.kind,
      part: opts.part,
      payload,
      monitorIds,
      now: opts.now,
      ...(allMonitorIds ? { allMonitorIds } : {}),
    });
    if (combinedStatus) {
      writes.push(
        ...buildSeedWrites({
          kind: 'status',
          part: opts.part,
          payload: combinedStatus,
          monitorIds,
          now: opts.now,
          ...(allMonitorIds ? { allMonitorIds } : {}),
        }),
      );
    }
    if (
      (combinedStatus || opts.kind === 'status') &&
      maintenanceMonitorIds &&
      (opts.part === 'envelope' || opts.part === 'all')
    ) {
      const envelope = writes.find((write) => write.snapshotKey === 'status:envelope');
      if (envelope)
        envelope.bodyJson = JSON.stringify({
          ...JSON.parse(envelope.bodyJson),
          source_maintenance_monitor_ids: maintenanceMonitorIds,
          ...(rangeStart !== undefined ? { source_range_start_at: rangeStart } : {}),
        });
    }
    if (
      opts.kind === 'homepage' &&
      (opts.part === 'monitors' || opts.part === 'all') &&
      shouldWriteHomepageArtifactFragments(opts.env)
    ) {
      const { buildHomepageArtifactMonitorFragmentWrites } =
        await import('../snapshots/public-homepage');
      writes.push(
        ...buildHomepageArtifactMonitorFragmentWrites(
          payload as PublicHomepageResponse,
          opts.now,
          monitorIds,
        ),
      );
    }
    if (writes.length === 0) {
      return {
        ok: true,
        seeded: false,
        kind: opts.kind,
        part: opts.part,
        generatedAt: payload.generated_at,
        monitorCount,
        monitorOffset: offset,
        monitorLimit: limit,
        writeCount: 0,
        skipped: 'empty_batch',
      };
    }

    const results = await writePublicSnapshotFragments(
      opts.env.DB,
      writes,
      boundedRefresh ? offset : undefined,
      combined,
    );
    return {
      ok: true,
      seeded: true,
      kind: opts.kind,
      part: opts.part,
      generatedAt: payload.generated_at,
      monitorCount,
      monitorOffset: offset,
      monitorLimit: limit,
      writeCount: results.reduce((total, result) => total + (result.meta.changes ?? 0), 0),
    };
  } catch (err) {
    console.warn('internal sharded public snapshot fragment seed failed', err);
    return {
      ok: false,
      seeded: false,
      kind: opts.kind,
      part: opts.part,
      monitorCount: 0,
      monitorOffset: offset,
      monitorLimit: limit,
      writeCount: 0,
      error: true,
    };
  }
}

export async function assembleShardedPublicSnapshot(
  opts: ShardedPublicSnapshotAssembleOptions,
): Promise<ShardedPublicSnapshotAssembleResult> {
  const mode = opts.mode ?? 'validated';
  try {
    if (mode === 'json') {
      const assembled =
        opts.kind === 'homepage'
          ? await readHomepageSnapshotBodyJsonFromFragments(opts.env.DB)
          : await readStatusSnapshotBodyJsonFromFragments(opts.env.DB);
      if (!assembled) {
        return {
          ok: true,
          assembled: false,
          kind: opts.kind,
          monitorCount: 0,
          invalidCount: 0,
          staleCount: 0,
          mode,
          skip: 'invalid_payload',
        };
      }
      const publishNow = opts.now ?? Math.floor(Date.now() / 1000);
      const published = opts.publish
        ? await publishRawPublicSnapshot({
            env: opts.env,
            kind: opts.kind,
            generatedAt: assembled.generatedAt,
            bodyJson: assembled.bodyJson,
            now: publishNow,
          })
        : false;
      const shouldPublishArtifact = (opts.publishArtifact ?? true) && opts.kind === 'homepage';
      const artifactResult =
        opts.publish && shouldPublishArtifact
          ? await publishRawHomepageArtifactSnapshot({
              env: opts.env,
              generatedAt: assembled.generatedAt,
              bodyJson: assembled.bodyJson,
              now: publishNow,
            })
          : null;
      const artifactPublished = artifactResult?.artifactPublished ?? false;
      return {
        ok: true,
        assembled: true,
        kind: opts.kind,
        generatedAt: assembled.generatedAt,
        monitorCount: assembled.monitorCount,
        invalidCount: assembled.invalidCount,
        staleCount: assembled.staleCount,
        mode,
        ...(opts.measureBodyBytes ? { bodyBytes: bodyJsonBytes(assembled.bodyJson, true) } : {}),
        ...(opts.publish
          ? {
              published,
              ...(shouldPublishArtifact ? { artifactPublished } : {}),
              writeCount: (published ? 1 : 0) + (artifactPublished ? 1 : 0),
            }
          : {}),
      };
    }

    if (opts.kind === 'homepage') {
      const fragments = await readHomepageSnapshotFragments(opts.env.DB);
      if (!fragments.envelope) {
        return {
          ok: true,
          assembled: false,
          kind: opts.kind,
          monitorCount: 0,
          invalidCount: fragments.monitors.invalidCount,
          staleCount: fragments.monitors.staleCount,
          mode,
          skip: 'missing_envelope',
        };
      }

      const assembled = assemblePublicHomepagePayloadFromFragments(
        fragments.envelope.data,
        fragments.monitors.data,
      );
      if (!assembled) {
        return {
          ok: true,
          assembled: false,
          kind: opts.kind,
          generatedAt: fragments.envelope.generatedAt,
          monitorCount: fragments.monitors.data.length,
          invalidCount: fragments.monitors.invalidCount,
          staleCount: fragments.monitors.staleCount,
          mode,
          skip:
            fragments.monitors.data.length < fragments.envelope.data.monitor_ids.length
              ? 'missing_monitors'
              : 'invalid_payload',
        };
      }

      return {
        ok: true,
        assembled: true,
        kind: opts.kind,
        generatedAt: assembled.generated_at,
        monitorCount: assembled.monitors.length,
        invalidCount: fragments.monitors.invalidCount,
        staleCount: fragments.monitors.staleCount,
        mode,
        ...(opts.measureBodyBytes ? { bodyBytes: measuredBodyBytes(assembled, true) } : {}),
      };
    }

    const fragments = await readStatusSnapshotFragments(opts.env.DB);
    if (!fragments.envelope) {
      return {
        ok: true,
        assembled: false,
        kind: opts.kind,
        monitorCount: 0,
        invalidCount: fragments.monitors.invalidCount,
        staleCount: fragments.monitors.staleCount,
        mode,
        skip: 'missing_envelope',
      };
    }

    const assembled = assemblePublicStatusPayloadFromFragments(
      fragments.envelope.data,
      fragments.monitors.data,
    );
    if (!assembled) {
      return {
        ok: true,
        assembled: false,
        kind: opts.kind,
        generatedAt: fragments.envelope.generatedAt,
        monitorCount: fragments.monitors.data.length,
        invalidCount: fragments.monitors.invalidCount,
        staleCount: fragments.monitors.staleCount,
        mode,
        skip:
          fragments.monitors.data.length < fragments.envelope.data.monitor_ids.length
            ? 'missing_monitors'
            : 'invalid_payload',
      };
    }

    return {
      ok: true,
      assembled: true,
      kind: opts.kind,
      generatedAt: assembled.generated_at,
      monitorCount: assembled.monitors.length,
      invalidCount: fragments.monitors.invalidCount,
      staleCount: fragments.monitors.staleCount,
      mode,
      ...(opts.measureBodyBytes ? { bodyBytes: measuredBodyBytes(assembled, true) } : {}),
    };
  } catch (err) {
    console.warn('internal sharded public snapshot assembly failed', err);
    const errorInfo = toErrorInfo(err);
    return {
      ok: false,
      assembled: false,
      kind: opts.kind,
      monitorCount: 0,
      invalidCount: 0,
      staleCount: 0,
      mode,
      error: true,
      ...errorInfo,
    };
  }
}
