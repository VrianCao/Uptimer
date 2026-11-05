import pLimit from 'p-limit';

import {
  expectedStatusJsonSchema,
  forbiddenStatusJsonSchema,
  httpHeadersJsonSchema,
  parseDbJsonNullable,
  type StatusCodeRule,
} from '@uptimer/db/json';
import type { HttpResponseMatchMode, MonitorStatus } from '@uptimer/db/schema';

import type { Env } from '../env';
import { runInternalHomepageRefreshCore } from '../internal/homepage-refresh-core';
import type { Trace } from '../observability/trace';
import {
  computeNextState,
  type MonitorStateSnapshot,
  type NextState,
  type OutageAction,
} from '../monitor/state-machine';
import type { CheckOutcome } from '../monitor/types';
import { rebuildPublicMonitorRuntimeSnapshot } from '../public/monitor-runtime-bootstrap';
import {
  encodeMonitorRuntimeUpdatesCompact,
  normalizeRuntimeUpdateLatencyMs,
  parseMonitorRuntimeUpdates,
  refreshPublicMonitorRuntimeSnapshot,
  writePublicMonitorRuntimeSnapshot,
  type MonitorRuntimeUpdate,
  type PublicMonitorRuntimeSnapshot,
} from '../public/monitor-runtime';
import { readSettings } from '../settings';
import { acquireLease, releaseLease } from './lock';
import { LeaseLostError, startRenewableLease } from './lease-guard';
import type { NotifyContext } from './notifications';

const LOCK_NAME = 'scheduler:tick';
const LOCK_LEASE_SECONDS = 135;
const LOCK_RENEW_INTERVAL_MS = 45_000;
const LOCK_RENEW_MIN_REMAINING_SECONDS = 45;
const INTERNAL_PROTOCOL_FORMAT = 'compact-v1';
const INTERNAL_SCHEDULED_BATCH_SIZE = 6;
const INTERNAL_SCHEDULED_BATCH_CONCURRENCY = 2;
const HOMEPAGE_REFRESH_SERVICE_TIMEOUT_MS = 15_000;
const RUNTIME_FRAGMENTS_REFRESH_SERVICE_TIMEOUT_MS = 15_000;
const SHARDED_PUBLIC_SNAPSHOT_SERVICE_TIMEOUT_MS = 15_000;
const SHARDED_FRAGMENT_SEED_BATCH_SIZE = 5;
const INTERNAL_SCHEDULED_CHECK_BATCH_TIMEOUT_MS = 30_000;
const BATCH_EXECUTION_LOCK_PREFIX = 'scheduler:batch:';
const MONITOR_EXECUTION_LOCK_PREFIX = 'scheduler:batch-monitor:';
const BATCH_EXECUTION_LOCK_LEASE_SECONDS = 15 * 60;
const MONITOR_EXECUTION_LOCK_LEASE_SECONDS = 75;
const BATCH_EXECUTION_LOCK_RENEW_INTERVAL_MS = 60_000;
const BATCH_EXECUTION_LOCK_RENEW_MIN_REMAINING_SECONDS = 5 * 60;

const CHECK_CONCURRENCY = 5;
const D1_MAX_SQL_VARIABLES = 100;
const CHECK_RESULT_BINDINGS_PER_ROW = 8;
const MONITOR_STATE_BINDINGS_PER_ROW = 8;
const PERSIST_BATCH_SIZE = Math.max(
  1,
  Math.floor(
    D1_MAX_SQL_VARIABLES / Math.max(CHECK_RESULT_BINDINGS_PER_ROW, MONITOR_STATE_BINDINGS_PER_ROW),
  ),
);

async function refreshHomepageSnapshotInline(env: Env, now: number): Promise<void> {
  const [
    { computePublicHomepagePayload },
    { refreshPublicHomepageSnapshotIfNeeded },
    { readHomepageRefreshBaseSnapshot },
  ] = await Promise.all([
    import('../public/homepage'),
    import('../snapshots'),
    import('../snapshots/public-homepage-read'),
  ]);
  const baseSnapshot = await readHomepageRefreshBaseSnapshot(env.DB, now);

  await refreshPublicHomepageSnapshotIfNeeded({
    db: env.DB,
    now,
    compute: () =>
      computePublicHomepagePayload(env.DB, now, {
        baseSnapshot: baseSnapshot.snapshot,
        baseSnapshotBodyJson: null,
      }),
    seedDataSnapshot: baseSnapshot.seedDataSnapshot,
  });
}

type HomepageRefreshServiceResult = {
  refreshed: boolean | null;
};

type MonitorBatchStats = {
  processedCount: number;
  rejectedCount: number;
  attemptTotal: number;
  httpCount: number;
  tcpCount: number;
  assertionCount: number;
  downCount: number;
  unknownCount: number;
};

type MonitorBatchExecutionResult = {
  runtimeUpdates: MonitorRuntimeUpdate[];
  stats: MonitorBatchStats;
  checksDurMs: number;
  persistDurMs: number;
};

type ScheduledCheckBatchServiceResult = MonitorBatchExecutionResult;

type ScheduledCheckBatchServiceContext = {
  ids: number[];
  checkedAt: number;
  suppressedMonitorIds: number[];
  stateMachineConfig: {
    failuresToDownFromUp: number;
    successesToUpFromDown: number;
  };
  allowNotifications: boolean;
  runtimeFragmentsOnly?: boolean;
  splitRuntimeFragmentWrites?: boolean;
};

function readScheduledTraceToken(env: Env): string | null {
  const rawEnv = env as unknown as Record<string, unknown>;
  const raw = rawEnv.UPTIMER_TRACE_TOKEN ?? rawEnv.TRACE_TOKEN;
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isTruthyEnvFlag(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldTraceScheduledRefresh(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    readScheduledTraceToken(env) !== null &&
    isTruthyEnvFlag(rawEnv.UPTIMER_TRACE_SCHEDULED_REFRESH ?? rawEnv.TRACE_SCHEDULED_REFRESH)
  );
}

function shouldLogScheduledRefresh(env: Env): boolean {
  const raw = (env as unknown as Record<string, unknown>).UPTIMER_SCHEDULED_REFRESH_LOGS;
  if (typeof raw !== 'string') {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  );
}

function shouldRefreshHomepageDirect(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_HOMEPAGE_DIRECT);
}

function shouldRefreshRuntimeFragmentsViaService(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH);
}

function shouldUseScheduledRuntimeFragmentPipeline(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    Boolean(env.SELF) &&
    shouldRefreshRuntimeFragmentsViaService(env) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES)
  );
}

function shouldSplitInternalCheckBatchFragmentWrites(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return isTruthyEnvFlag(rawEnv.UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT);
}

function shouldSeedScheduledShardedFragments(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    Boolean(env.SELF) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED)
  );
}

function shouldAssembleScheduledShardedSnapshots(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    Boolean(env.SELF) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_PUBLIC_SHARDED_ASSEMBLER) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_SHARDED_ASSEMBLER)
  );
}

function shouldSkipScheduledHomepageRefreshForShardedSnapshots(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    Boolean(env.SELF) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH) &&
    (shouldSeedScheduledShardedFragments(env) || shouldAssembleScheduledShardedSnapshots(env))
  );
}

function shouldUseScheduledShardedContinuation(env: Env): boolean {
  const rawEnv = env as unknown as Record<string, unknown>;
  return (
    Boolean(env.SELF) &&
    isTruthyEnvFlag(rawEnv.UPTIMER_SCHEDULED_SHARDED_CONTINUATION) &&
    (shouldSeedScheduledShardedFragments(env) || shouldAssembleScheduledShardedSnapshots(env))
  );
}

function readBoundedPositiveIntegerEnv(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (env as unknown as Record<string, unknown>)[key];
  if (typeof raw !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

async function fetchSelfWithTimeout(
  env: Env,
  request: Request,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (!env.SELF) {
    throw new Error('SELF service binding missing');
  }

  const controller = new AbortController();
  /* v8 ignore next -- parent abort propagation is exercised by integration lease-loss tests, not cron coverage. */
  const abortFromParent = () => controller.abort();
  signal?.addEventListener('abort', abortFromParent);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await env.SELF.fetch(new Request(request, { signal: controller.signal }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', abortFromParent);
    clearTimeout(timeout);
  }
}

async function writeRuntimeUpdateFragmentsViaService(
  env: Env,
  runtimeUpdates: readonly MonitorRuntimeUpdate[],
  signal?: AbortSignal,
): Promise<void> {
  if (runtimeUpdates.length === 0) {
    return;
  }
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/write/runtime-update-fragments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        runtime_updates: encodeMonitorRuntimeUpdatesCompact(runtimeUpdates),
      }),
    }),
    RUNTIME_FRAGMENTS_REFRESH_SERVICE_TIMEOUT_MS,
    'runtime update fragments write service',
    signal,
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`runtime update fragments write failed: HTTP ${res.status} ${bodyText}`.trim());
  }
}

async function refreshRuntimeFragmentsViaService(env: Env): Promise<void> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/refresh/runtime-fragments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: env.ADMIN_TOKEN,
    }),
    RUNTIME_FRAGMENTS_REFRESH_SERVICE_TIMEOUT_MS,
    'runtime fragments refresh service',
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`runtime fragments refresh failed: HTTP ${res.status} ${bodyText}`.trim());
  }

  let refreshed: boolean | null = null;
  let updateCount: number | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { refreshed?: unknown; update_count?: unknown };
      refreshed = typeof parsed.refreshed === 'boolean' ? parsed.refreshed : null;
      updateCount = typeof parsed.update_count === 'number' ? parsed.update_count : null;
    } catch {
      refreshed = null;
      updateCount = null;
    }
  }
  console.log(
    `scheduled: runtime_fragments_refresh route=internal/refresh/runtime-fragments refreshed=${refreshed === null ? '-' : refreshed ? 1 : 0} update_count=${updateCount ?? '-'}`,
  );
}

type ShardedPublicSnapshotKind = 'homepage' | 'status';
type ShardedPublicSnapshotAssemblyMode = 'validated' | 'json';
type ShardedPublicSnapshotSeedPart = 'envelope' | 'monitors';

type ShardedPublicSnapshotSeedServiceResult = {
  seeded: boolean | null;
  monitorCount: number | null;
  writeCount: number | null;
  skipped: string | null;
};

type ShardedPublicSnapshotAssembleServiceResult = {
  assembled: boolean | null;
  mode: string | null;
  monitorCount: number | null;
  invalidCount: number | null;
  staleCount: number | null;
  skip: string | null;
};

function readShardedPublicSnapshotAssemblyMode(env: Env): ShardedPublicSnapshotAssemblyMode {
  const raw = (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_ASSEMBLER_MODE;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'json' ? 'json' : 'validated';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function seedShardedPublicSnapshotPartViaService(
  env: Env,
  kind: ShardedPublicSnapshotKind,
  part: ShardedPublicSnapshotSeedPart,
  monitorOffset: number,
  monitorLimit: number,
): Promise<ShardedPublicSnapshotSeedServiceResult> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        kind,
        part,
        monitor_offset: monitorOffset,
        monitor_limit: monitorLimit,
      }),
    }),
    SHARDED_PUBLIC_SNAPSHOT_SERVICE_TIMEOUT_MS,
    'sharded public snapshot seed service',
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`sharded public snapshot seed failed: HTTP ${res.status} ${bodyText}`.trim());
  }

  const parsed = parseJsonObject(bodyText);
  return {
    seeded: typeof parsed?.seeded === 'boolean' ? parsed.seeded : null,
    monitorCount: typeof parsed?.monitor_count === 'number' ? parsed.monitor_count : null,
    writeCount: typeof parsed?.write_count === 'number' ? parsed.write_count : null,
    skipped: typeof parsed?.skipped === 'string' ? parsed.skipped : null,
  };
}

async function assembleShardedPublicSnapshotViaService(
  env: Env,
  kind: ShardedPublicSnapshotKind,
  mode: ShardedPublicSnapshotAssemblyMode,
): Promise<ShardedPublicSnapshotAssembleServiceResult> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ kind, assembly: mode }),
    }),
    SHARDED_PUBLIC_SNAPSHOT_SERVICE_TIMEOUT_MS,
    'sharded public snapshot assemble service',
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `sharded public snapshot assemble failed: HTTP ${res.status} ${bodyText}`.trim(),
    );
  }

  const parsed = parseJsonObject(bodyText);
  return {
    assembled: typeof parsed?.assembled === 'boolean' ? parsed.assembled : null,
    mode: typeof parsed?.assembly === 'string' ? parsed.assembly : null,
    monitorCount: typeof parsed?.monitor_count === 'number' ? parsed.monitor_count : null,
    invalidCount: typeof parsed?.invalid_count === 'number' ? parsed.invalid_count : null,
    staleCount: typeof parsed?.stale_count === 'number' ? parsed.stale_count : null,
    skip: typeof parsed?.skip === 'string' ? parsed.skip : null,
  };
}

async function seedShardedPublicSnapshotKindViaService(
  env: Env,
  kind: ShardedPublicSnapshotKind,
  monitorLimit: number,
): Promise<void> {
  const envelope = await seedShardedPublicSnapshotPartViaService(
    env,
    kind,
    'envelope',
    0,
    monitorLimit,
  );
  const monitorCount = envelope.monitorCount ?? 0;
  let monitorBatchCount = 0;
  let writeCount = envelope.writeCount ?? 0;
  for (let offset = 0; offset < monitorCount; offset += monitorLimit) {
    const batch = await seedShardedPublicSnapshotPartViaService(
      env,
      kind,
      'monitors',
      offset,
      monitorLimit,
    );
    monitorBatchCount += 1;
    writeCount += batch.writeCount ?? 0;
  }
  console.log(
    `scheduled: sharded_fragment_seed kind=${kind} monitor_count=${monitorCount} monitor_batches=${monitorBatchCount} write_count=${writeCount} envelope_seeded=${envelope.seeded === null ? '-' : envelope.seeded ? 1 : 0}`,
  );
}

async function runScheduledShardedPublicSnapshotWork(env: Env): Promise<void> {
  const shouldSeed = shouldSeedScheduledShardedFragments(env);
  const shouldAssemble = shouldAssembleScheduledShardedSnapshots(env);
  if (!shouldSeed && !shouldAssemble) {
    return;
  }

  const monitorLimit = readBoundedPositiveIntegerEnv(
    env,
    'UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE',
    SHARDED_FRAGMENT_SEED_BATCH_SIZE,
    1,
    10,
  );
  if (shouldSeed) {
    await seedShardedPublicSnapshotKindViaService(env, 'homepage', monitorLimit);
    await seedShardedPublicSnapshotKindViaService(env, 'status', monitorLimit);
  }

  if (shouldAssemble) {
    const assemblyMode = readShardedPublicSnapshotAssemblyMode(env);
    for (const kind of ['homepage', 'status'] as const) {
      const assembled = await assembleShardedPublicSnapshotViaService(env, kind, assemblyMode);
      console.log(
        `scheduled: sharded_assemble kind=${kind} mode=${assembled.mode ?? assemblyMode} assembled=${assembled.assembled === null ? '-' : assembled.assembled ? 1 : 0} monitor_count=${assembled.monitorCount ?? '-'} invalid_count=${assembled.invalidCount ?? '-'} stale_count=${assembled.staleCount ?? '-'} skip=${assembled.skip ?? '-'}`,
      );
    }
  }
}

async function startShardedPublicSnapshotContinuationViaService(
  env: Env,
  opts: { refreshRuntimeFragments: boolean },
): Promise<void> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const monitorLimit = readBoundedPositiveIntegerEnv(
    env,
    'UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE',
    SHARDED_FRAGMENT_SEED_BATCH_SIZE,
    1,
    10,
  );
  const body = opts.refreshRuntimeFragments
    ? { step: 'runtime' }
    : {
        step: 'seed',
        kind: 'homepage',
        part: 'envelope',
        monitor_offset: 0,
        monitor_limit: monitorLimit,
      };
  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    }),
    SHARDED_PUBLIC_SNAPSHOT_SERVICE_TIMEOUT_MS,
    'sharded public snapshot continuation service',
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `sharded public snapshot continuation failed: HTTP ${res.status} ${bodyText}`.trim(),
    );
  }
  if (shouldLogScheduledRefresh(env)) {
    const parsed = parseJsonObject(bodyText);
    const continued = typeof parsed?.continued === 'boolean' ? parsed.continued : null;
    console.log(
      `scheduled: sharded_continuation_start step=${String(body.step)} continued=${continued === null ? '-' : continued ? 1 : 0}`,
    );
  }
}

async function refreshHomepageSnapshotViaService(
  env: Env,
  opts: {
    runtimeUpdates?: MonitorRuntimeUpdate[];
  } = {},
): Promise<HomepageRefreshServiceResult> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const runtimeUpdates = opts.runtimeUpdates?.length ? opts.runtimeUpdates : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    'X-Uptimer-Internal-Format': INTERNAL_PROTOCOL_FORMAT,
    'Content-Type': runtimeUpdates
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8',
    'X-Uptimer-Refresh-Source': 'scheduled',
  };
  const traceScheduledRefresh = shouldTraceScheduledRefresh(env);
  const traceId = traceScheduledRefresh ? crypto.randomUUID() : null;
  if (traceScheduledRefresh) {
    headers['X-Uptimer-Trace'] = '1';
    headers['X-Uptimer-Trace-Id'] = traceId ?? crypto.randomUUID();
    headers['X-Uptimer-Trace-Mode'] = 'scheduled';
    const traceToken = readScheduledTraceToken(env);
    if (traceToken) {
      headers['X-Uptimer-Trace-Token'] = traceToken;
    }
  }
  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/refresh/homepage', {
      method: 'POST',
      headers,
      body: runtimeUpdates
        ? JSON.stringify({
            runtime_updates: encodeMonitorRuntimeUpdatesCompact(runtimeUpdates),
          })
        : env.ADMIN_TOKEN,
    }),
    HOMEPAGE_REFRESH_SERVICE_TIMEOUT_MS,
    'homepage refresh service',
  );
  if (traceScheduledRefresh) {
    console.log(
      `scheduled: homepage_refresh_trace request_trace_id=${traceId ?? '-'} response_trace_id=${res.headers.get('X-Uptimer-Trace-Id') ?? '-'} response_trace=${res.headers.get('X-Uptimer-Trace') ?? '-'} server_timing=${res.headers.get('Server-Timing') ?? '-'}`,
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`service refresh failed: HTTP ${res.status} ${bodyText}`.trim());
  }
  let refreshed: boolean | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { refreshed?: unknown };
      refreshed = typeof parsed.refreshed === 'boolean' ? parsed.refreshed : null;
    } catch {
      refreshed = null;
    }
  }

  return {
    refreshed,
  };
}

function toInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createEmptyMonitorBatchStats(): MonitorBatchStats {
  return {
    processedCount: 0,
    rejectedCount: 0,
    attemptTotal: 0,
    httpCount: 0,
    tcpCount: 0,
    assertionCount: 0,
    downCount: 0,
    unknownCount: 0,
  };
}

function createEmptyMonitorBatchExecutionResult(): MonitorBatchExecutionResult {
  return {
    runtimeUpdates: [],
    stats: createEmptyMonitorBatchStats(),
    checksDurMs: 0,
    persistDurMs: 0,
  };
}

function toScheduledCheckBatchServiceResult(value: unknown): ScheduledCheckBatchServiceResult {
  if (!isRecord(value)) {
    throw new Error('service batch returned invalid JSON');
  }

  const runtimeUpdatesValue = value.runtime_updates;
  const runtimeUpdates = parseMonitorRuntimeUpdates(runtimeUpdatesValue);
  if (!runtimeUpdates) {
    throw new Error('service batch returned invalid runtime_updates');
  }

  const stats: MonitorBatchStats = {
    processedCount: Math.max(0, toInteger(value.processed_count) ?? runtimeUpdates.length),
    rejectedCount: Math.max(0, toInteger(value.rejected_count) ?? 0),
    attemptTotal: Math.max(0, toInteger(value.attempt_total) ?? 0),
    httpCount: Math.max(0, toInteger(value.http_count) ?? 0),
    tcpCount: Math.max(0, toInteger(value.tcp_count) ?? 0),
    assertionCount: Math.max(0, toInteger(value.assertion_count) ?? 0),
    downCount: Math.max(0, toInteger(value.down_count) ?? 0),
    unknownCount: Math.max(0, toInteger(value.unknown_count) ?? 0),
  };

  return {
    runtimeUpdates,
    stats,
    checksDurMs: Math.max(0, toNumber(value.checks_duration_ms) ?? 0),
    persistDurMs: Math.max(0, toNumber(value.persist_duration_ms) ?? 0),
  };
}

async function runScheduledCheckBatchViaService(
  env: Env,
  context: ScheduledCheckBatchServiceContext,
  signal?: AbortSignal,
): Promise<ScheduledCheckBatchServiceResult> {
  if (!env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN missing');
  }

  const traceScheduledRefresh = shouldTraceScheduledRefresh(env);
  const traceId = traceScheduledRefresh ? crypto.randomUUID() : null;
  const returnRuntimeUpdatesForSplit =
    context.runtimeFragmentsOnly === true && context.splitRuntimeFragmentWrites === true;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    'X-Uptimer-Internal-Format': INTERNAL_PROTOCOL_FORMAT,
    'Content-Type': 'application/json; charset=utf-8',
    ...(context.runtimeFragmentsOnly && !returnRuntimeUpdatesForSplit
      ? { 'X-Uptimer-Runtime-Fragments-Only': '1' }
      : {}),
  };
  if (traceScheduledRefresh) {
    headers['X-Uptimer-Trace'] = '1';
    headers['X-Uptimer-Trace-Id'] = traceId ?? crypto.randomUUID();
    headers['X-Uptimer-Trace-Mode'] = 'scheduled';
    const traceToken = readScheduledTraceToken(env);
    if (traceToken) {
      headers['X-Uptimer-Trace-Token'] = traceToken;
    }
  }

  const res = await fetchSelfWithTimeout(
    env,
    new Request('http://internal/api/v1/internal/scheduled/check-batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: env.ADMIN_TOKEN,
        ids: context.ids,
        checked_at: context.checkedAt,
        suppressed_monitor_ids: context.suppressedMonitorIds,
        state_failures_to_down_from_up: context.stateMachineConfig.failuresToDownFromUp,
        state_successes_to_up_from_down: context.stateMachineConfig.successesToUpFromDown,
        allow_notifications: context.allowNotifications || undefined,
      }),
    }),
    readBoundedPositiveIntegerEnv(
      env,
      'UPTIMER_INTERNAL_SCHEDULED_CHECK_BATCH_TIMEOUT_MS',
      INTERNAL_SCHEDULED_CHECK_BATCH_TIMEOUT_MS,
      5_000,
      120_000,
    ),
    'scheduled check batch service',
    signal,
  );
  if (traceScheduledRefresh) {
    console.log(
      `scheduled: check_batch_trace request_trace_id=${traceId ?? '-'} checked_at=${context.checkedAt} ids=${context.ids.length} response_trace_id=${res.headers.get('X-Uptimer-Trace-Id') ?? '-'} response_trace=${res.headers.get('X-Uptimer-Trace') ?? '-'} server_timing=${res.headers.get('Server-Timing') ?? '-'}`,
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`service check batch failed: HTTP ${res.status} ${bodyText}`.trim());
  }

  let parsedBody: unknown = null;
  if (bodyText.trim().length > 0) {
    try {
      parsedBody = JSON.parse(bodyText) as unknown;
    } catch (err) {
      throw new Error(
        `service check batch returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return toScheduledCheckBatchServiceResult(parsedBody);
}

type CachedMonitorHttpJson = {
  http_headers_json: string | null;
  expected_status_json: string | null;
  forbidden_status_json: string | null;
  httpHeaders: Record<string, string> | null;
  expectedStatus: StatusCodeRule[] | null;
  forbiddenStatus: StatusCodeRule[] | null;
};

const cachedMonitorHttpJsonById = new Map<number, CachedMonitorHttpJson>();
let httpCheckModulePromise: Promise<typeof import('../monitor/http')> | null = null;
let tcpCheckModulePromise: Promise<typeof import('../monitor/tcp')> | null = null;

export type DueMonitorRow = {
  id: number;
  name: string;
  type: string;
  target: string;
  display_url: string | null;
  interval_sec: number;
  created_at: number;
  timeout_ms: number;
  http_method: string | null;
  http_headers_json: string | null;
  http_body: string | null;
  follow_redirects: number | boolean | null;
  expected_status_json: string | null;
  forbidden_status_json: string | null;
  response_keyword: string | null;
  response_keyword_mode: HttpResponseMatchMode | null;
  response_forbidden_keyword: string | null;
  response_forbidden_keyword_mode: HttpResponseMatchMode | null;
  state_status: string | null;
  state_last_error: string | null;
  last_checked_at: number | null;
  last_changed_at: number | null;
  consecutive_failures: number | null;
  consecutive_successes: number | null;
};

async function getHttpCheckModule() {
  httpCheckModulePromise ??= import('../monitor/http');
  return await httpCheckModulePromise;
}

async function getTcpCheckModule() {
  tcpCheckModulePromise ??= import('../monitor/tcp');
  return await tcpCheckModulePromise;
}

async function hasActiveWebhookChannels(db: D1Database): Promise<boolean> {
  const cachedResult = activeWebhookPresenceCacheByDb.get(db);
  if (
    cachedResult &&
    Date.now() - cachedResult.fetchedAtMs < ACTIVE_WEBHOOK_PRESENCE_CACHE_TTL_MS
  ) {
    return cachedResult.hasActive;
  }

  const cached = hasActiveWebhookChannelsStatementByDb.get(db);
  const statement = cached ?? db.prepare(HAS_ACTIVE_WEBHOOK_CHANNELS_SQL);
  if (!cached) {
    hasActiveWebhookChannelsStatementByDb.set(db, statement);
  }

  const { results } = await statement.all<unknown>();
  const hasActive = (results?.length ?? 0) > 0;
  activeWebhookPresenceCacheByDb.set(db, { fetchedAtMs: Date.now(), hasActive });
  return hasActive;
}

const listDueMonitorsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const hasSchedulableMonitorsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const persistStatementTemplatesByDb = new WeakMap<D1Database, PersistStatementTemplates>();
const hasActiveWebhookChannelsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const activeWebhookPresenceCacheByDb = new WeakMap<
  D1Database,
  { fetchedAtMs: number; hasActive: boolean }
>();

const HAS_ACTIVE_WEBHOOK_CHANNELS_SQL = `
  SELECT 1 AS present
  FROM notification_channels
  WHERE is_active = 1 AND type = 'webhook'
  LIMIT 1
`;
const ACTIVE_WEBHOOK_PRESENCE_CACHE_TTL_MS = 60_000;

const LIST_DUE_MONITORS_SQL = `
  SELECT
    m.id,
    m.name,
    m.type,
    m.target,
    m.display_url,
    m.interval_sec,
    m.created_at,
    m.timeout_ms,
    m.http_method,
    m.http_headers_json,
    m.http_body,
    m.follow_redirects,
    m.expected_status_json,
    m.forbidden_status_json,
    m.response_keyword,
    m.response_keyword_mode,
    m.response_forbidden_keyword,
    m.response_forbidden_keyword_mode,
    s.status AS state_status,
    s.last_error AS state_last_error,
    s.last_checked_at,
    s.last_changed_at,
    s.consecutive_failures,
    s.consecutive_successes
  FROM monitors m
  LEFT JOIN monitor_state s ON s.monitor_id = m.id
  WHERE m.is_active = 1
    AND (s.status IS NULL OR s.status != 'paused')
    AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1 - m.interval_sec)
  ORDER BY m.id
`;

const HAS_SCHEDULABLE_MONITORS_SQL = `
  SELECT 1 AS present
  FROM monitors m
  LEFT JOIN monitor_state s ON s.monitor_id = m.id
  WHERE m.is_active = 1
    AND (s.status IS NULL OR s.status != 'paused')
  LIMIT 1
`;

const PERSIST_STATEMENTS_SQL = {
  openOutageIfMissing: `
    INSERT INTO outages (monitor_id, started_at, ended_at, initial_error, last_error)
    SELECT ?1, ?2, NULL, ?3, ?4
    WHERE EXISTS (
      SELECT 1
      FROM monitor_state
      WHERE monitor_id = ?5
        AND last_checked_at = ?6
        AND status = 'down'
    )
      AND NOT EXISTS (
        SELECT 1 FROM outages WHERE monitor_id = ?7 AND ended_at IS NULL
      )
  `,
  closeOutage: `
    UPDATE outages
    SET ended_at = ?1
    WHERE monitor_id = ?2 AND ended_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM monitor_state
        WHERE monitor_id = ?2
          AND last_checked_at = ?1
          AND status != 'down'
      )
  `,
  updateOutageLastError: `
    UPDATE outages
    SET last_error = ?1
    WHERE monitor_id = ?2 AND ended_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM monitor_state
        WHERE monitor_id = ?2
          AND last_checked_at = ?3
          AND status = 'down'
      )
  `,
} as const;

export type CompletedDueMonitor = {
  row: DueMonitorRow;
  checkedAt: number;
  prevStatus: MonitorStatus | null;
  outcome: CheckOutcome;
  next: NextState;
  outageAction: OutageAction;
  stateLastError: string | null;
  maintenanceSuppressed: boolean;
};

type InitializedNotifications = {
  module: typeof import('./notifications') | null;
  notify: NotifyContext | null;
};

function toHttpMethod(
  value: string | null,
): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | null {
  const normalized = (value ?? 'GET').toUpperCase();
  switch (normalized) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return normalized;
    default:
      return null;
  }
}

function toMonitorStatus(value: string | null): MonitorStatus | null {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

function toBooleanDefaultTrue(value: boolean | number | null | undefined): boolean {
  return value !== false && value !== 0;
}

async function listDueMonitors(db: D1Database, checkedAt: number): Promise<DueMonitorRow[]> {
  const cached = listDueMonitorsStatementByDb.get(db);
  const statement = cached ?? db.prepare(LIST_DUE_MONITORS_SQL);
  if (!cached) {
    listDueMonitorsStatementByDb.set(db, statement);
  }

  const { results } = await statement.bind(checkedAt).all<DueMonitorRow>();

  return results ?? [];
}

async function hasSchedulableMonitors(db: D1Database): Promise<boolean> {
  const cached = hasSchedulableMonitorsStatementByDb.get(db);
  const statement = cached ?? db.prepare(HAS_SCHEDULABLE_MONITORS_SQL);
  if (!cached) {
    hasSchedulableMonitorsStatementByDb.set(db, statement);
  }

  const row = await statement.first<{ present: number }>();
  return row !== null;
}

export async function listMonitorRowsByIds(
  db: D1Database,
  ids: number[],
): Promise<DueMonitorRow[]> {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(', ');
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.type,
        m.target,
        m.display_url,
        m.interval_sec,
        m.created_at,
        m.timeout_ms,
        m.http_method,
        m.http_headers_json,
        m.http_body,
        m.follow_redirects,
        m.expected_status_json,
        m.forbidden_status_json,
        m.response_keyword,
        m.response_keyword_mode,
        m.response_forbidden_keyword,
        m.response_forbidden_keyword_mode,
        s.status AS state_status,
        s.last_error AS state_last_error,
        s.last_checked_at,
        s.last_changed_at,
        s.consecutive_failures,
        s.consecutive_successes
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND (s.status IS NULL OR s.status != 'paused')
        AND m.id IN (${placeholders})
      ORDER BY m.id
    `,
    )
    .bind(...uniqueIds)
    .all<DueMonitorRow>();

  return results ?? [];
}

function normalizePositiveIntegerIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const next: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

function buildBatchExecutionLockName(checkedAt: number, ids: readonly number[]): string {
  return `${BATCH_EXECUTION_LOCK_PREFIX}${checkedAt}:${[...ids].sort((a, b) => a - b).join(',')}`;
}

function buildMonitorExecutionLockName(checkedAt: number, id: number): string {
  return `${MONITOR_EXECUTION_LOCK_PREFIX}${checkedAt}:${id}`;
}

type MonitorExecutionLease = {
  id: number;
  name: string;
  expiresAt: number;
};

async function claimMonitorExecutionLeases(
  db: D1Database,
  checkedAt: number,
  ids: readonly number[],
  now: number,
): Promise<{ claimedIds: number[]; leases: MonitorExecutionLease[] }> {
  const claimedIds: number[] = [];
  const expiresAt = now + MONITOR_EXECUTION_LOCK_LEASE_SECONDS;

  const attempts = await Promise.all(
    ids.map(async (id) => {
      const name = buildMonitorExecutionLockName(checkedAt, id);
      const acquired = await acquireLease(db, name, now, MONITOR_EXECUTION_LOCK_LEASE_SECONDS);
      return acquired ? { id, name, expiresAt } : null;
    }),
  );

  const leases: MonitorExecutionLease[] = [];
  for (const lease of attempts) {
    if (!lease) {
      continue;
    }
    claimedIds.push(lease.id);
    leases.push(lease);
  }

  return { claimedIds, leases };
}

async function listPendingMonitorRowsByIds(
  db: D1Database,
  ids: readonly number[],
  checkedAt: number,
): Promise<DueMonitorRow[]> {
  const normalizedIds = normalizePositiveIntegerIds(ids);
  if (normalizedIds.length === 0) {
    return [];
  }

  const fetchedRows = await listMonitorRowsByIds(db, normalizedIds);
  const rowById = new Map(fetchedRows.map((row) => [row.id, row]));
  return normalizedIds
    .map((id) => rowById.get(id) ?? null)
    .filter((row): row is DueMonitorRow => row !== null)
    .filter((row) => row.last_checked_at === null || row.last_checked_at < checkedAt);
}

export async function runExclusivePersistedMonitorBatch(opts: {
  db: D1Database;
  ids: readonly number[];
  checkedAt: number;
  suppressedMonitorIds?: ReadonlySet<number>;
  abortSignal?: AbortSignal;
  stateMachineConfig: {
    failuresToDownFromUp: number;
    successesToUpFromDown: number;
  };
  onPersistedMonitor?: (completed: CompletedDueMonitor) => void;
  trace?: Trace;
  trustSchedulerLease?: boolean;
}): Promise<MonitorBatchExecutionResult> {
  const ids = normalizePositiveIntegerIds(opts.ids);
  opts.trace?.setLabel('batch_ids', ids.length);
  if (ids.length === 0) {
    return createEmptyMonitorBatchExecutionResult();
  }

  if (opts.trustSchedulerLease) {
    opts.trace?.setLabel('batch_lock', 'trusted_scheduler_lease');
    const rows = opts.trace
      ? await opts.trace.timeAsync(
          'batch_list_pending_rows',
          async () => await listPendingMonitorRowsByIds(opts.db, ids, opts.checkedAt),
        )
      : await listPendingMonitorRowsByIds(opts.db, ids, opts.checkedAt);
    opts.trace?.setLabel('batch_pending_rows', rows.length);
    if (rows.length === 0) {
      return createEmptyMonitorBatchExecutionResult();
    }
    return await runPersistedMonitorBatch({
      db: opts.db,
      rows,
      checkedAt: opts.checkedAt,
      stateMachineConfig: opts.stateMachineConfig,
      ...(opts.suppressedMonitorIds ? { suppressedMonitorIds: opts.suppressedMonitorIds } : {}),
      ...(opts.onPersistedMonitor ? { onPersistedMonitor: opts.onPersistedMonitor } : {}),
      ...(opts.trace ? { trace: opts.trace } : {}),
      beforePersist: () => {
        if (opts.abortSignal?.aborted) {
          throw new LeaseLostError('scheduled batch: trusted scheduler lease aborted by caller');
        }
      },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + BATCH_EXECUTION_LOCK_LEASE_SECONDS;
  const lockName = buildBatchExecutionLockName(opts.checkedAt, ids);
  const acquired = opts.trace
    ? await opts.trace.timeAsync(
        'batch_acquire_lease',
        async () => await acquireLease(opts.db, lockName, now, BATCH_EXECUTION_LOCK_LEASE_SECONDS),
      )
    : await acquireLease(opts.db, lockName, now, BATCH_EXECUTION_LOCK_LEASE_SECONDS);
  if (!acquired) {
    opts.trace?.setLabel('batch_lock', 'skipped');
    return createEmptyMonitorBatchExecutionResult();
  }
  opts.trace?.setLabel('batch_lock', 'acquired');

  const batchLease = startRenewableLease({
    db: opts.db,
    name: lockName,
    leaseSeconds: BATCH_EXECUTION_LOCK_LEASE_SECONDS,
    initialExpiresAt: expiresAt,
    renewIntervalMs: BATCH_EXECUTION_LOCK_RENEW_INTERVAL_MS,
    renewMinRemainingSeconds: BATCH_EXECUTION_LOCK_RENEW_MIN_REMAINING_SECONDS,
    logPrefix: 'scheduled batch',
  });
  let claimedIds: number[] = [];
  let claimedMonitorLeases: MonitorExecutionLease[] = [];

  try {
    const claimed = opts.trace
      ? await opts.trace.timeAsync(
          'batch_claim_monitor_leases',
          async () => await claimMonitorExecutionLeases(opts.db, opts.checkedAt, ids, now),
        )
      : await claimMonitorExecutionLeases(opts.db, opts.checkedAt, ids, now);
    claimedIds = claimed.claimedIds;
    claimedMonitorLeases = claimed.leases;
    opts.trace?.setLabel('batch_claimed_ids', claimedIds.length);
    const skippedLockCount = Math.max(0, ids.length - claimedIds.length);
    const rows = opts.trace
      ? await opts.trace.timeAsync(
          'batch_list_pending_rows',
          async () => await listPendingMonitorRowsByIds(opts.db, claimedIds, opts.checkedAt),
        )
      : await listPendingMonitorRowsByIds(opts.db, claimedIds, opts.checkedAt);
    opts.trace?.setLabel('batch_pending_rows', rows.length);
    if (rows.length === 0) {
      return {
        ...createEmptyMonitorBatchExecutionResult(),
        stats: {
          ...createEmptyMonitorBatchExecutionResult().stats,
          rejectedCount: skippedLockCount,
        },
      };
    }

    const result = await runPersistedMonitorBatch({
      db: opts.db,
      rows,
      checkedAt: opts.checkedAt,
      stateMachineConfig: opts.stateMachineConfig,
      ...(opts.suppressedMonitorIds ? { suppressedMonitorIds: opts.suppressedMonitorIds } : {}),
      ...(opts.onPersistedMonitor ? { onPersistedMonitor: opts.onPersistedMonitor } : {}),
      ...(opts.trace ? { trace: opts.trace } : {}),
      beforePersist: () => {
        if (opts.abortSignal?.aborted) {
          throw new LeaseLostError(`scheduled batch: ${lockName} aborted by caller`);
        }
        batchLease.assertHeld(`persisting ${lockName}`);
        for (const lease of claimedMonitorLeases) {
          if (Math.floor(Date.now() / 1000) >= lease.expiresAt) {
            throw new LeaseLostError(`scheduled batch monitor: ${lease.name} lease expired`);
          }
        }
      },
    });
    result.stats.rejectedCount += skippedLockCount;
    return result;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      throw err;
    }
    throw err;
  } finally {
    const releaseBatchLeases = async () => {
      await Promise.all(
        claimedMonitorLeases.map(async (lease) => {
          await releaseLease(opts.db, lease.name, lease.expiresAt).catch((err) => {
            console.warn('scheduled: failed to release monitor execution lease', err);
          });
        }),
      );
      await batchLease.stop().catch((err) => {
        console.warn('scheduled batch: lease renewal task failed', err);
      });
      await releaseLease(opts.db, lockName, batchLease.getExpiresAt()).catch((err) => {
        console.warn('scheduled: failed to release batch execution lease', err);
      });
    };
    if (opts.trace) {
      await opts.trace.timeAsync('batch_release_leases', releaseBatchLeases);
    } else {
      await releaseBatchLeases();
    }
  }
}

function computeStateLastError(
  nextStatus: MonitorStatus,
  outcome: CheckOutcome,
  prevLastError: string | null,
): string | null {
  if (nextStatus === 'down') {
    return outcome.status === 'up' ? prevLastError : outcome.error;
  }
  if (nextStatus === 'up') {
    return outcome.status === 'up' ? null : outcome.error;
  }
  return outcome.status === 'up' ? null : outcome.error;
}

type PersistStatementTemplates = {
  insertCheckResultByRowCount: Map<number, D1PreparedStatement>;
  upsertMonitorStateByRowCount: Map<number, D1PreparedStatement>;
  openOutageIfMissing: D1PreparedStatement;
  closeOutage: D1PreparedStatement;
  updateOutageLastError: D1PreparedStatement;
};

function buildNumberedTuplePlaceholders(rowCount: number, bindingsPerRow: number): string {
  const tuples: string[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const base = rowIndex * bindingsPerRow;
    const placeholders = Array.from(
      { length: bindingsPerRow },
      (_, bindingIndex) => `?${base + bindingIndex + 1}`,
    );
    tuples.push(`(${placeholders.join(', ')})`);
  }
  return tuples.join(', ');
}

function getInsertCheckResultStatement(
  db: D1Database,
  templates: PersistStatementTemplates,
  rowCount: number,
): D1PreparedStatement {
  const cached = templates.insertCheckResultByRowCount.get(rowCount);
  if (cached) {
    return cached;
  }

  const statement = db.prepare(`
    INSERT INTO check_results (
      monitor_id,
      checked_at,
      status,
      latency_ms,
      http_status,
      error,
      location,
      attempt
    ) VALUES ${buildNumberedTuplePlaceholders(rowCount, CHECK_RESULT_BINDINGS_PER_ROW)}
  `);
  templates.insertCheckResultByRowCount.set(rowCount, statement);
  return statement;
}

function getUpsertMonitorStateStatement(
  db: D1Database,
  templates: PersistStatementTemplates,
  rowCount: number,
): D1PreparedStatement {
  const cached = templates.upsertMonitorStateByRowCount.get(rowCount);
  if (cached) {
    return cached;
  }

  const statement = db.prepare(`
    INSERT INTO monitor_state (
      monitor_id,
      status,
      last_checked_at,
      last_changed_at,
      last_latency_ms,
      last_error,
      consecutive_failures,
      consecutive_successes
    ) VALUES ${buildNumberedTuplePlaceholders(rowCount, MONITOR_STATE_BINDINGS_PER_ROW)}
    ON CONFLICT(monitor_id) DO UPDATE SET
      status = excluded.status,
      last_checked_at = excluded.last_checked_at,
      last_changed_at = excluded.last_changed_at,
      last_latency_ms = excluded.last_latency_ms,
      last_error = excluded.last_error,
      consecutive_failures = excluded.consecutive_failures,
      consecutive_successes = excluded.consecutive_successes
    WHERE monitor_state.last_checked_at IS NULL
      OR excluded.last_checked_at >= monitor_state.last_checked_at
  `);
  templates.upsertMonitorStateByRowCount.set(rowCount, statement);
  return statement;
}

function toCheckResultBindings(completed: CompletedDueMonitor): unknown[] {
  const { row, checkedAt, outcome } = completed;
  const checkError = outcome.status === 'up' ? null : outcome.error;
  return [
    row.id,
    checkedAt,
    outcome.status,
    outcome.latencyMs,
    outcome.httpStatus,
    checkError,
    null,
    outcome.attempts,
  ];
}

function toMonitorStateBindings(completed: CompletedDueMonitor): unknown[] {
  const { row, checkedAt, outcome, next, stateLastError } = completed;
  return [
    row.id,
    next.status,
    checkedAt,
    next.lastChangedAt,
    outcome.latencyMs,
    stateLastError,
    next.consecutiveFailures,
    next.consecutiveSuccesses,
  ];
}

function buildOutageStatements(
  completed: CompletedDueMonitor,
  templates: PersistStatementTemplates,
): D1PreparedStatement[] {
  const { row, checkedAt, outcome, outageAction } = completed;
  const checkError = outcome.status === 'up' ? null : outcome.error;

  const statements: D1PreparedStatement[] = [];

  if (outageAction === 'open') {
    statements.push(
      templates.openOutageIfMissing.bind(
        row.id,
        checkedAt,
        checkError ?? 'down',
        checkError ?? 'down',
        row.id,
        checkedAt,
        row.id,
      ),
    );
  } else if (outageAction === 'close') {
    statements.push(templates.closeOutage.bind(checkedAt, row.id));
  } else if (outageAction === 'update' && checkError) {
    statements.push(templates.updateOutageLastError.bind(checkError, row.id, checkedAt));
  }

  return statements;
}

function toMonitorRuntimeUpdate(completed: CompletedDueMonitor): MonitorRuntimeUpdate {
  return {
    monitor_id: completed.row.id,
    interval_sec: completed.row.interval_sec,
    created_at: completed.row.created_at,
    checked_at: completed.checkedAt,
    check_status: completed.outcome.status,
    next_status: completed.next.status,
    latency_ms: normalizeRuntimeUpdateLatencyMs(completed.outcome.latencyMs),
  };
}

function summarizeCompletedMonitors(
  completed: CompletedDueMonitor[],
  rejectedCount: number,
): MonitorBatchStats {
  let httpCount = 0;
  let tcpCount = 0;
  let assertionCount = 0;
  let attemptTotal = 0;
  let downCount = 0;
  let unknownCount = 0;

  for (const monitor of completed) {
    attemptTotal += monitor.outcome.attempts;
    if (monitor.outcome.status === 'down') {
      downCount += 1;
    } else if (monitor.outcome.status === 'unknown') {
      unknownCount += 1;
    }

    if (monitor.row.type === 'http') {
      httpCount += 1;
      if (monitor.row.response_keyword || monitor.row.response_forbidden_keyword) {
        assertionCount += 1;
      }
    } else if (monitor.row.type === 'tcp') {
      tcpCount += 1;
    }
  }

  return {
    processedCount: completed.length,
    rejectedCount,
    attemptTotal,
    httpCount,
    tcpCount,
    assertionCount,
    downCount,
    unknownCount,
  };
}

async function runDueMonitor(
  row: DueMonitorRow,
  checkedAt: number,
  maintenanceSuppressed: boolean,
  stateMachineConfig: { failuresToDownFromUp: number; successesToUpFromDown: number },
): Promise<CompletedDueMonitor> {
  const prevStatus = toMonitorStatus(row.state_status);
  const prev: MonitorStateSnapshot | null =
    prevStatus === null
      ? null
      : {
          status: prevStatus,
          lastChangedAt: row.last_changed_at,
          consecutiveFailures: row.consecutive_failures ?? 0,
          consecutiveSuccesses: row.consecutive_successes ?? 0,
        };

  let outcome: CheckOutcome;

  try {
    if (row.type === 'http') {
      const httpMethod = toHttpMethod(row.http_method);
      if (!httpMethod) {
        outcome = {
          status: 'unknown',
          latencyMs: null,
          httpStatus: null,
          error: 'Invalid http_method',
          attempts: 1,
        };
      } else {
        const cached = cachedMonitorHttpJsonById.get(row.id);
        const cachedMatches =
          cached &&
          cached.http_headers_json === row.http_headers_json &&
          cached.expected_status_json === row.expected_status_json &&
          cached.forbidden_status_json === row.forbidden_status_json;

        const httpHeaders = cachedMatches
          ? cached.httpHeaders
          : parseDbJsonNullable(httpHeadersJsonSchema, row.http_headers_json, {
              field: 'http_headers_json',
            });
        const expectedStatus = cachedMatches
          ? cached.expectedStatus
          : parseDbJsonNullable(expectedStatusJsonSchema, row.expected_status_json, {
              field: 'expected_status_json',
            });
        const forbiddenStatus = cachedMatches
          ? cached.forbiddenStatus
          : parseDbJsonNullable(forbiddenStatusJsonSchema, row.forbidden_status_json, {
              field: 'forbidden_status_json',
            });

        if (!cachedMatches) {
          cachedMonitorHttpJsonById.set(row.id, {
            http_headers_json: row.http_headers_json,
            expected_status_json: row.expected_status_json,
            forbidden_status_json: row.forbidden_status_json,
            httpHeaders,
            expectedStatus,
            forbiddenStatus,
          });
        }

        const { runHttpCheck } = await getHttpCheckModule();
        outcome = await runHttpCheck({
          url: row.target,
          timeoutMs: row.timeout_ms,
          method: httpMethod,
          headers: httpHeaders,
          body: row.http_body,
          followRedirects: toBooleanDefaultTrue(row.follow_redirects),
          expectedStatus,
          forbiddenStatus,
          responseKeyword: row.response_keyword,
          responseKeywordMode: row.response_keyword_mode,
          responseForbiddenKeyword: row.response_forbidden_keyword,
          responseForbiddenKeywordMode: row.response_forbidden_keyword_mode,
        });
      }
    } else if (row.type === 'tcp') {
      const { runTcpCheck } = await getTcpCheckModule();
      outcome = await runTcpCheck({ target: row.target, timeoutMs: row.timeout_ms });
    } else {
      outcome = {
        status: 'unknown',
        latencyMs: null,
        httpStatus: null,
        error: `Unsupported monitor type: ${String(row.type)}`,
        attempts: 1,
      };
    }
  } catch (err) {
    outcome = {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      attempts: 1,
    };
  }

  const { next, outageAction } = computeNextState(prev, outcome, checkedAt, stateMachineConfig);
  const stateLastError = computeStateLastError(next.status, outcome, row.state_last_error);

  return {
    row,
    checkedAt,
    prevStatus,
    outcome,
    next,
    outageAction,
    stateLastError,
    maintenanceSuppressed,
  };
}

async function persistCompletedMonitors(
  db: D1Database,
  completed: CompletedDueMonitor[],
): Promise<void> {
  const cached = persistStatementTemplatesByDb.get(db);
  const templates = cached ?? {
    insertCheckResultByRowCount: new Map<number, D1PreparedStatement>(),
    upsertMonitorStateByRowCount: new Map<number, D1PreparedStatement>(),
    openOutageIfMissing: db.prepare(PERSIST_STATEMENTS_SQL.openOutageIfMissing),
    closeOutage: db.prepare(PERSIST_STATEMENTS_SQL.closeOutage),
    updateOutageLastError: db.prepare(PERSIST_STATEMENTS_SQL.updateOutageLastError),
  };
  if (!cached) {
    persistStatementTemplatesByDb.set(db, templates);
  }

  for (let i = 0; i < completed.length; i += PERSIST_BATCH_SIZE) {
    const chunk = completed.slice(i, i + PERSIST_BATCH_SIZE);
    const statements: D1PreparedStatement[] = [];

    if (chunk.length > 0) {
      const checkResultBindings = chunk.flatMap((monitor) => toCheckResultBindings(monitor));
      statements.push(
        getInsertCheckResultStatement(db, templates, chunk.length).bind(...checkResultBindings),
      );

      const monitorStateBindings = chunk.flatMap((monitor) => toMonitorStateBindings(monitor));
      statements.push(
        getUpsertMonitorStateStatement(db, templates, chunk.length).bind(...monitorStateBindings),
      );
    }

    for (const monitor of chunk) {
      statements.push(...buildOutageStatements(monitor, templates));
    }

    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
}

export async function runPersistedMonitorBatch(opts: {
  db: D1Database;
  rows: DueMonitorRow[];
  checkedAt: number;
  suppressedMonitorIds?: ReadonlySet<number>;
  stateMachineConfig: {
    failuresToDownFromUp: number;
    successesToUpFromDown: number;
  };
  onPersistedMonitor?: (completed: CompletedDueMonitor) => void;
  beforePersist?: () => void | Promise<void>;
  trace?: Trace;
}): Promise<MonitorBatchExecutionResult> {
  opts.trace?.setLabel('batch_rows', opts.rows.length);
  const limit = pLimit(CHECK_CONCURRENCY);
  const suppressedMonitorIds = opts.suppressedMonitorIds ?? new Set<number>();
  const checksStart = performance.now();
  const runChecks = async () =>
    await Promise.allSettled(
      opts.rows.map((row) =>
        limit(() =>
          runDueMonitor(
            row,
            opts.checkedAt,
            suppressedMonitorIds.has(row.id),
            opts.stateMachineConfig,
          ),
        ),
      ),
    );
  const settled = opts.trace
    ? await opts.trace.timeAsync('batch_checks', runChecks)
    : await runChecks();
  const checksDurMs = performance.now() - checksStart;

  const rejectedCount = settled.filter((result) => result.status === 'rejected').length;
  const completed = settled
    .filter(
      (result): result is PromiseFulfilledResult<CompletedDueMonitor> =>
        result.status === 'fulfilled',
    )
    .map((result) => result.value);

  let persistDurMs = 0;
  if (completed.length > 0) {
    if (opts.beforePersist) {
      if (opts.trace) {
        await opts.trace.timeAsync(
          'batch_before_persist',
          async () => await opts.beforePersist?.(),
        );
      } else {
        await opts.beforePersist();
      }
    }
    const persistStart = performance.now();
    if (opts.trace) {
      await opts.trace.timeAsync(
        'batch_persist_completed',
        async () => await persistCompletedMonitors(opts.db, completed),
      );
    } else {
      await persistCompletedMonitors(opts.db, completed);
    }
    persistDurMs = performance.now() - persistStart;

    if (opts.onPersistedMonitor) {
      const notifyPersisted = () => {
        for (const monitor of completed) {
          opts.onPersistedMonitor?.(monitor);
        }
      };
      if (opts.trace) {
        opts.trace.time('batch_on_persisted', notifyPersisted);
      } else {
        notifyPersisted();
      }
    }
  }

  // Promise.allSettled preserves input order, so keep the existing monitor ordering here.
  const runtimeUpdates = opts.trace
    ? opts.trace.time('batch_runtime_updates', () => completed.map(toMonitorRuntimeUpdate))
    : completed.map(toMonitorRuntimeUpdate);

  return {
    runtimeUpdates,
    stats: summarizeCompletedMonitors(completed, rejectedCount),
    checksDurMs,
    persistDurMs,
  };
}

function mergeBatchStats(target: MonitorBatchStats, source: MonitorBatchStats): void {
  target.processedCount += source.processedCount;
  target.rejectedCount += source.rejectedCount;
  target.attemptTotal += source.attemptTotal;
  target.httpCount += source.httpCount;
  target.tcpCount += source.tcpCount;
  target.assertionCount += source.assertionCount;
  target.downCount += source.downCount;
  target.unknownCount += source.unknownCount;
}

function chunkDueMonitorRows(rows: DueMonitorRow[], size: number): DueMonitorRow[][] {
  if (rows.length === 0) {
    return [];
  }

  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: DueMonitorRow[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function runScheduledTick(env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const checkedAt = Math.floor(now / 60) * 60;
  const claimedLeaseExpiresAt = now + LOCK_LEASE_SECONDS;
  const totalStart = performance.now();
  const currentNow = () => Math.floor(Date.now() / 1000);
  const queueShardedPublicSnapshotWork = () =>
    runScheduledShardedPublicSnapshotWork(env).catch((err) => {
      console.warn('scheduled sharded public snapshot work failed', err);
    });
  const queueHomepageRefresh = (
    runtimeUpdates?: MonitorRuntimeUpdate[],
    runtimeSnapshotBaseline?: PublicMonitorRuntimeSnapshot,
  ) => {
    if (shouldSkipScheduledHomepageRefreshForShardedSnapshots(env)) {
      if (shouldLogScheduledRefresh(env)) {
        console.log(
          `scheduled: homepage_refresh_skip reason=sharded_public_snapshots runtime_updates=${runtimeUpdates?.length ?? 0}`,
        );
      }
      return shouldUseScheduledShardedContinuation(env)
        ? startShardedPublicSnapshotContinuationViaService(env, {
            refreshRuntimeFragments: false,
          }).catch((err) => {
            console.warn('scheduled sharded public snapshot continuation failed', err);
            return queueShardedPublicSnapshotWork();
          })
        : queueShardedPublicSnapshotWork();
    }

    let refreshPromise: Promise<void>;
    if (shouldRefreshHomepageDirect(env)) {
      refreshPromise = runInternalHomepageRefreshCore({
        env,
        now: currentNow(),
        scheduledRefreshRequest: true,
        ...(runtimeUpdates?.length ? { runtimeUpdates } : {}),
        trace: null,
        preferCachedBaseSnapshot: true,
        ...(runtimeUpdates?.length && runtimeSnapshotBaseline
          ? { scheduledRuntimeSnapshotBaseline: runtimeSnapshotBaseline }
          : {}),
      })
        .then((result) => {
          console.log(
            `scheduled: homepage_refresh_direct route=internal/homepage-refresh mode=scheduled direct=1 ok=${result.ok ? 1 : 0} refreshed=${result.refreshed ? 1 : 0} runtime_updates=${runtimeUpdates?.length ?? 0} base_snapshot=${result.baseSnapshotSource ?? '-'} skip=${result.skip ?? '-'} error=${result.error ? 1 : 0}`,
          );
        })
        .catch((err) => {
          console.warn('homepage snapshot: direct refresh failed', err);
        });
    } else {
      refreshPromise = env.SELF
        ? refreshHomepageSnapshotViaService(env, runtimeUpdates ? { runtimeUpdates } : undefined)
            .then(async (result) => {
              if (!runtimeUpdates?.length || result.refreshed !== false) {
                return;
              }
              await refreshHomepageSnapshotInline(env, currentNow()).catch((fallbackErr) => {
                console.warn('homepage snapshot: refresh failed', fallbackErr);
              });
            })
            .catch(async (err) => {
              console.warn('homepage snapshot: service refresh failed', err);
              await refreshHomepageSnapshotInline(env, currentNow()).catch((fallbackErr) => {
                console.warn('homepage snapshot: refresh failed', fallbackErr);
              });
            })
        : refreshHomepageSnapshotInline(env, currentNow()).catch((err) => {
            console.warn('homepage snapshot: refresh failed', err);
          });
    }

    return refreshPromise.then(async () => {
      await queueShardedPublicSnapshotWork();
      const { refreshQueuedStatusPageSnapshots } = await import(
        '../internal/status-page-refresh-core'
      );
      const result = await refreshQueuedStatusPageSnapshots({
        env,
        now: currentNow(),
        limit: SHARDED_FRAGMENT_SEED_BATCH_SIZE,
      });
      if (result.refreshedPageIds.length > 0 && shouldLogScheduledRefresh(env)) {
        console.log(
          `scheduled: status_page_refresh pages=${result.refreshedPageIds.length} has_more=${result.hasMore ? 1 : 0}`,
        );
      }
    });
  };

  const initializeNotifications = async (): Promise<InitializedNotifications> => {
    const hasWebhookNotifications = await hasActiveWebhookChannels(env.DB);
    if (!hasWebhookNotifications) {
      return { module: null, notify: null };
    }

    const notificationsModule = await import('./notifications');
    const notify = await notificationsModule.createNotifyContext(env, ctx);
    if (notify) {
      await notificationsModule.emitMaintenanceWindowNotifications(env, notify, now);
    }
    return { module: notificationsModule, notify };
  };

  const queueIdleWork = async (): Promise<void> => {
    if (shouldLogScheduledRefresh(env)) {
      console.log('scheduled: idle no runnable monitors');
    }
    await initializeNotifications();
    ctx.waitUntil(queueHomepageRefresh());
  };

  if (!(await hasSchedulableMonitors(env.DB))) {
    await queueIdleWork();
    return;
  }

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) {
    return;
  }
  const schedulerLease = startRenewableLease({
    db: env.DB,
    name: LOCK_NAME,
    leaseSeconds: LOCK_LEASE_SECONDS,
    initialExpiresAt: claimedLeaseExpiresAt,
    renewIntervalMs: LOCK_RENEW_INTERVAL_MS,
    renewMinRemainingSeconds: LOCK_RENEW_MIN_REMAINING_SECONDS,
    logPrefix: 'scheduled',
  });

  try {
    const useRuntimeFragmentPipeline = shouldUseScheduledRuntimeFragmentPipeline(env);

    const due = await listDueMonitors(env.DB, checkedAt);

    if (due.length === 0) {
      const hasRunnableMonitor = await hasSchedulableMonitors(env.DB);
      if (!hasRunnableMonitor) {
        await queueIdleWork();
        return;
      }
      await initializeNotifications();
      schedulerLease.assertHeld('queueing homepage refresh');
      ctx.waitUntil(queueHomepageRefresh());
      return;
    }

    const [settings, notifications] = await Promise.all([
      readSettings(env.DB),
      initializeNotifications(),
    ]);
    const setupDurMs = performance.now() - totalStart;
    const notificationsModule = notifications.module;
    const notify = notifications.notify;

    const stateMachineConfig = {
      failuresToDownFromUp: settings.state_failures_to_down_from_up,
      successesToUpFromDown: settings.state_successes_to_up_from_down,
    };

    // Maintenance suppression is monitor-scoped.
    const dueMonitorIds = due.map((m) => m.id);
    const suppressedMonitorIds =
      notify === null || notificationsModule === null
        ? new Set<number>()
        : await notificationsModule.listMaintenanceSuppressedMonitorIds(env.DB, now, dueMonitorIds);

    const internalScheduledBatchSize = readBoundedPositiveIntegerEnv(
      env,
      'UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE',
      INTERNAL_SCHEDULED_BATCH_SIZE,
      1,
      INTERNAL_SCHEDULED_BATCH_SIZE,
    );
    const internalScheduledBatchConcurrency = readBoundedPositiveIntegerEnv(
      env,
      'UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY',
      INTERNAL_SCHEDULED_BATCH_CONCURRENCY,
      1,
      INTERNAL_SCHEDULED_BATCH_CONCURRENCY,
    );
    const serviceBatchRows =
      env.SELF && due.length > internalScheduledBatchSize
        ? chunkDueMonitorRows(due, internalScheduledBatchSize)
        : null;
    const activeRuntimeFragmentPipeline = useRuntimeFragmentPipeline && serviceBatchRows !== null;
    const splitRuntimeFragmentWrites =
      activeRuntimeFragmentPipeline && shouldSplitInternalCheckBatchFragmentWrites(env);

    const inlineNotificationHandler =
      notificationsModule && notify
        ? (completed: CompletedDueMonitor) =>
            notificationsModule?.queueMonitorNotification(env, notify, completed)
        : undefined;

    let checksDurMs = 0;
    let persistDurMs = 0;
    let batchWallDurMs = 0;
    let runtimeSnapshotDurMs = 0;
    let runtimeUpdates: MonitorRuntimeUpdate[] = [];
    let runtimeSnapshotBaseline: PublicMonitorRuntimeSnapshot | undefined;
    let requiresRuntimeSnapshotRebuild = false;
    let requiresFullHomepageRefresh = false;
    const aggregateStats: MonitorBatchStats = {
      processedCount: 0,
      rejectedCount: 0,
      attemptTotal: 0,
      httpCount: 0,
      tcpCount: 0,
      assertionCount: 0,
      downCount: 0,
      unknownCount: 0,
    };

    if (serviceBatchRows) {
      const batchesStart = performance.now();
      const batchLimit = pLimit(internalScheduledBatchConcurrency);
      const batchResults = await Promise.all(
        serviceBatchRows.map((rows, batchIndex) =>
          batchLimit(async () => {
            schedulerLease.assertHeld('dispatching scheduled service batch');
            const batchStart = performance.now();
            const ids = rows.map((row) => row.id);
            const suppressedIds = ids.filter((id) => suppressedMonitorIds.has(id));
            try {
              return await runScheduledCheckBatchViaService(
                env,
                {
                  ids,
                  checkedAt,
                  suppressedMonitorIds: suppressedIds,
                  stateMachineConfig,
                  allowNotifications: Boolean(notify),
                  ...(activeRuntimeFragmentPipeline ? { runtimeFragmentsOnly: true } : {}),
                  ...(splitRuntimeFragmentWrites ? { splitRuntimeFragmentWrites: true } : {}),
                },
                schedulerLease.signal,
              );
            } catch (err) {
              schedulerLease.assertHeld('dispatching inline fallback for service batch');
              const firstId = ids[0] ?? null;
              const lastId = ids[ids.length - 1] ?? null;
              console.warn(
                `scheduled: service batch failed, falling back inline checked_at=${checkedAt} batch_index=${batchIndex + 1} batch_count=${serviceBatchRows.length} ids=${ids.length} first_id=${firstId ?? '-'} last_id=${lastId ?? '-'} dur_service=${(performance.now() - batchStart).toFixed(2)}`,
                err,
              );
              const fallbackBatch = await runExclusivePersistedMonitorBatch({
                db: env.DB,
                ids,
                checkedAt,
                abortSignal: schedulerLease.signal,
                suppressedMonitorIds: new Set(suppressedIds),
                stateMachineConfig,
                ...(inlineNotificationHandler
                  ? { onPersistedMonitor: inlineNotificationHandler }
                  : {}),
              });
              if (activeRuntimeFragmentPipeline) {
                requiresRuntimeSnapshotRebuild = true;
                requiresFullHomepageRefresh = true;
              } else if (fallbackBatch.stats.processedCount === 0 && ids.length > 0) {
                requiresRuntimeSnapshotRebuild = true;
                requiresFullHomepageRefresh = true;
              }
              return fallbackBatch;
            }
          }),
        ),
      );
      batchWallDurMs = performance.now() - batchesStart;

      for (const batch of batchResults) {
        runtimeUpdates.push(...batch.runtimeUpdates);
        checksDurMs += batch.checksDurMs;
        persistDurMs += batch.persistDurMs;
        mergeBatchStats(aggregateStats, batch.stats);
      }

      if (splitRuntimeFragmentWrites && runtimeUpdates.length > 0) {
        const runtimeFragmentWriteStart = performance.now();
        try {
          await writeRuntimeUpdateFragmentsViaService(env, runtimeUpdates, schedulerLease.signal);
          runtimeUpdates = [];
          runtimeSnapshotDurMs = performance.now() - runtimeFragmentWriteStart;
        } catch (err) {
          console.warn('runtime update fragments write: service write failed', err);
          requiresRuntimeSnapshotRebuild = true;
          requiresFullHomepageRefresh = true;
        }
      }
    } else {
      const batch = await runPersistedMonitorBatch({
        db: env.DB,
        rows: due,
        checkedAt,
        suppressedMonitorIds,
        stateMachineConfig,
        ...(inlineNotificationHandler ? { onPersistedMonitor: inlineNotificationHandler } : {}),
        beforePersist: () => {
          schedulerLease.assertHeld('persisting inline scheduled batch');
        },
      });
      batchWallDurMs = batch.checksDurMs + batch.persistDurMs;
      runtimeUpdates = batch.runtimeUpdates;
      checksDurMs = batch.checksDurMs;
      persistDurMs = batch.persistDurMs;
      mergeBatchStats(aggregateStats, batch.stats);
    }

    const runtimeSnapshotNow = currentNow();

    if (requiresRuntimeSnapshotRebuild) {
      const runtimeSnapshotStart = performance.now();
      const rebuiltSnapshot = await rebuildPublicMonitorRuntimeSnapshot(env.DB, runtimeSnapshotNow);
      await writePublicMonitorRuntimeSnapshot(env.DB, rebuiltSnapshot, runtimeSnapshotNow);
      runtimeSnapshotBaseline = rebuiltSnapshot;
      runtimeSnapshotDurMs = performance.now() - runtimeSnapshotStart;
    } else if (runtimeUpdates.length > 0) {
      const runtimeSnapshotStart = performance.now();
      runtimeSnapshotBaseline = await refreshPublicMonitorRuntimeSnapshot({
        db: env.DB,
        now: runtimeSnapshotNow,
        updates: runtimeUpdates,
        rebuild: async () => await rebuildPublicMonitorRuntimeSnapshot(env.DB, runtimeSnapshotNow),
      });
      runtimeSnapshotDurMs = performance.now() - runtimeSnapshotStart;
    }

    const batchMode = serviceBatchRows ? 'service' : 'inline';
    const batchCount = serviceBatchRows?.length ?? 1;

    if (aggregateStats.rejectedCount > 0) {
      console.error(
        `scheduled: ${aggregateStats.rejectedCount}/${due.length} monitors failed at ${checkedAt} attempts=${aggregateStats.attemptTotal} http=${aggregateStats.httpCount} tcp=${aggregateStats.tcpCount} assertions=${aggregateStats.assertionCount} down=${aggregateStats.downCount} unknown=${aggregateStats.unknownCount} batch_mode=${batchMode} batch_count=${batchCount} dur_setup=${setupDurMs.toFixed(2)} dur_checks=${checksDurMs.toFixed(2)} dur_persist=${persistDurMs.toFixed(2)} dur_batch=${batchWallDurMs.toFixed(2)} dur_runtime=${runtimeSnapshotDurMs.toFixed(2)} dur_total=${(performance.now() - totalStart).toFixed(2)}`,
      );
    } else if (shouldLogScheduledRefresh(env)) {
      console.log(
        `scheduled: processed ${aggregateStats.processedCount} monitors at ${checkedAt} attempts=${aggregateStats.attemptTotal} http=${aggregateStats.httpCount} tcp=${aggregateStats.tcpCount} assertions=${aggregateStats.assertionCount} down=${aggregateStats.downCount} unknown=${aggregateStats.unknownCount} batch_mode=${batchMode} batch_count=${batchCount} dur_setup=${setupDurMs.toFixed(2)} dur_checks=${checksDurMs.toFixed(2)} dur_persist=${persistDurMs.toFixed(2)} dur_batch=${batchWallDurMs.toFixed(2)} dur_runtime=${runtimeSnapshotDurMs.toFixed(2)} dur_total=${(performance.now() - totalStart).toFixed(2)}`,
      );
    }

    const queuePostCheckRefresh = () => {
      if (
        shouldUseScheduledShardedContinuation(env) &&
        shouldSkipScheduledHomepageRefreshForShardedSnapshots(env) &&
        !requiresFullHomepageRefresh
      ) {
        return startShardedPublicSnapshotContinuationViaService(env, {
          refreshRuntimeFragments: activeRuntimeFragmentPipeline,
        }).catch(async (err) => {
          console.warn('sharded continuation: service start failed', err);
          if (activeRuntimeFragmentPipeline) {
            await refreshRuntimeFragmentsViaService(env).catch((refreshErr) => {
              console.warn('runtime fragments refresh: service refresh failed', refreshErr);
            });
          }
          await queueHomepageRefresh();
        });
      }

      if (activeRuntimeFragmentPipeline && !requiresFullHomepageRefresh) {
        return refreshRuntimeFragmentsViaService(env)
          .then(() => queueHomepageRefresh())
          .catch(async (err) => {
            console.warn('runtime fragments refresh: service refresh failed', err);
            await queueHomepageRefresh();
          });
      }

      return queueHomepageRefresh(
        requiresFullHomepageRefresh ? undefined : runtimeUpdates,
        requiresFullHomepageRefresh ? undefined : runtimeSnapshotBaseline,
      );
    };

    ctx.waitUntil(queuePostCheckRefresh());
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(err.message);
      return;
    }
    throw err;
  } finally {
    await schedulerLease.stop().catch((err) => {
      console.warn('scheduled: lease renewal task failed', err);
    });
    await releaseLease(env.DB, LOCK_NAME, schedulerLease.getExpiresAt()).catch((err) => {
      console.warn('scheduled: failed to release lease', err);
    });
  }
}
