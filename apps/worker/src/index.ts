import { z } from 'zod';
import { getSiteCoordinator } from './coordinator-binding';
import { runtimeProfile } from './runtime-profile';
import paidCrons from './scheduler/paid-crons.json';

// Initialize reusable schemas/modules during isolate startup (1s budget), not
// during a Free Plan request's 10ms CPU window. No I/O runs in module scope.
import './hono-app';
import './routes/public-ui';
import './routes/public';
import './routes/admin';
import './public/homepage';
import './public/status';
import './snapshots/public-homepage';
import './snapshots/public-homepage-read';
import './snapshots/public-status-read';
import './internal/sharded-public-snapshot-continuation';
import './scheduler/daily-rollup';
import './scheduler/daily-rollup-sql';
import './scheduler/retention';
import './monitor/http';
import './monitor/tcp';
import './scheduler/notifications';
import { handleFetch } from './fetch-handler';
import {
  runScheduledTick,
  runScheduledBatchCohort,
  batchResultToWire,
} from './scheduler/scheduled';

import type { Env } from './env';
import { usesBoundedPublicSeeds, usesAtomicPublicPublication } from './public/refresh-profile';
import type { Trace } from './observability/trace';
import {
  normalizeInternalTruthy,
  runInternalHomepageRefreshCore,
} from './internal/homepage-refresh-core';
import {
  encodeMonitorRuntimeUpdatesCompact,
  parseMonitorRuntimeUpdates,
  type MonitorRuntimeUpdate,
} from './public/monitor-runtime';
import type { CompletedDueMonitor } from './scheduler/scheduled';
import { LeaseLostError } from './scheduler/lease-guard';

const INTERNAL_REQUEST_MAX_BYTES = 256 * 1024;
const INTERNAL_PROTOCOL_FORMAT = 'compact-v1';

function normalizeTruthyHeader(value: string | null): boolean {
  return normalizeInternalTruthy(value);
}

function readBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function hasValidInternalAuth(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) {
    return false;
  }
  const authorization = request.headers.get('Authorization');
  return (
    authorization === `Bearer ${env.ADMIN_TOKEN}` ||
    readBearerToken(authorization) === env.ADMIN_TOKEN
  );
}

function isInternalServiceRequest(request: Request): boolean {
  try {
    return new URL(request.url).hostname === 'internal';
  } catch {
    return false;
  }
}

function isRequestBodyTooLarge(request: Request): boolean {
  const raw = request.headers.get('Content-Length');
  if (!raw) {
    return false;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > INTERNAL_REQUEST_MAX_BYTES;
}

function isScheduledRefreshRequest(request: Request): boolean {
  return request.headers.get('X-Uptimer-Refresh-Source') === 'scheduled';
}

function wantsCompactInternalFormat(request: Request): boolean {
  return request.headers.get('X-Uptimer-Internal-Format') === INTERNAL_PROTOCOL_FORMAT;
}

function wantsRuntimeUpdateFragmentsOnly(request: Request): boolean {
  return normalizeTruthyHeader(request.headers.get('X-Uptimer-Runtime-Fragments-Only'));
}

function shouldLogInternalCheckBatchDiagnostics(env: Env): boolean {
  return normalizeTruthyHeader(env.UPTIMER_INTERNAL_CHECK_BATCH_DIAGNOSTICS ?? null);
}

type InternalCheckBatchDiagnosticTimings = Record<string, number>;

async function timeInternalCheckBatchDiagnostic<T>(
  enabled: boolean,
  timings: InternalCheckBatchDiagnosticTimings,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return await fn();
  }
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = performance.now() - startedAt;
  }
}

function timeInternalCheckBatchDiagnosticSync<T>(
  enabled: boolean,
  timings: InternalCheckBatchDiagnosticTimings,
  label: string,
  fn: () => T,
): T {
  if (!enabled) {
    return fn();
  }
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    timings[label] = performance.now() - startedAt;
  }
}

function formatDiagnosticMs(value: number | undefined): string {
  return (value ?? 0).toFixed(2);
}

function logInternalCheckBatchDiagnostics(opts: {
  enabled: boolean;
  timings: InternalCheckBatchDiagnosticTimings;
  startedAt: number;
  idCount: number;
  runtimeFragmentsOnly: boolean;
  fragmentWriteCount: number;
  runtimeUpdateCount: number;
  processedCount: number;
  rejectedCount: number;
  attemptTotal: number;
  httpCount: number;
  tcpCount: number;
  checksDurMs: number;
  persistDurMs: number;
}): void {
  if (!opts.enabled) return;
  console.log(
    [
      'internal_check_batch',
      `ids=${opts.idCount}`,
      `runtime_fragments_only=${opts.runtimeFragmentsOnly ? 1 : 0}`,
      `fragment_writes=${opts.fragmentWriteCount}`,
      `runtime_updates=${opts.runtimeUpdateCount}`,
      `processed=${opts.processedCount}`,
      `rejected=${opts.rejectedCount}`,
      `attempts=${opts.attemptTotal}`,
      `http=${opts.httpCount}`,
      `tcp=${opts.tcpCount}`,
      `checks_ms=${opts.checksDurMs.toFixed(2)}`,
      `persist_ms=${opts.persistDurMs.toFixed(2)}`,
      `parse_ms=${formatDiagnosticMs(opts.timings.parse)}`,
      `import_ms=${formatDiagnosticMs(opts.timings.imports)}`,
      `notify_ms=${formatDiagnosticMs(opts.timings.notify)}`,
      `run_ms=${formatDiagnosticMs(opts.timings.run)}`,
      `fragment_import_ms=${formatDiagnosticMs(opts.timings.fragmentImports)}`,
      `fragment_build_ms=${formatDiagnosticMs(opts.timings.fragmentBuild)}`,
      `fragment_write_ms=${formatDiagnosticMs(opts.timings.fragmentWrite)}`,
      `stringify_ms=${formatDiagnosticMs(opts.timings.stringify)}`,
      `total_ms=${(performance.now() - opts.startedAt).toFixed(2)}`,
    ].join(' '),
  );
}

function buildInternalRefreshResponse(ok: boolean, refreshed: boolean): Response {
  return new Response(JSON.stringify({ ok, refreshed }), {
    status: ok ? 200 : 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildInternalJsonResponse(body: unknown, ok: boolean): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildNotFoundJsonResponse(origin: string | null): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  }
  return new Response(
    JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found',
      },
    }),
    {
      status: 404,
      headers,
    },
  );
}

const internalRefreshJsonBodySchema = z.object({
  token: z.string().optional(),
  runtime_updates: z.array(z.unknown()).optional(),
});

const internalRuntimeUpdateFragmentsWriteBodySchema = z.object({
  runtime_updates: z.array(z.unknown()),
});

const internalShardedPublicSnapshotBodySchema = z.object({
  kind: z.enum(['homepage', 'status']),
  assembly: z.enum(['validated', 'json']).optional().default('validated'),
  measure_body_bytes: z.boolean().optional().default(false),
  publish: z.boolean().optional().default(false),
});

const internalShardedPublicSnapshotSeedBodySchema = z.object({
  kind: z.enum(['homepage', 'status']),
  part: z.enum(['envelope', 'monitors', 'all']).optional().default('envelope'),
  monitor_offset: z.number().int().min(0).optional().default(0),
  monitor_limit: z.number().int().min(1).max(10).optional().default(5),
});

const internalShardedPublicSnapshotContinuationBodySchema = z.discriminatedUnion('step', [
  z.object({
    generation_at: z.number().int().min(0).optional(),
    step: z.literal('runtime'),
    update_offset: z.number().int().min(0).optional(),
    update_limit: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    generation_at: z.number().int().min(0).optional(),
    step: z.literal('seed'),
    kind: z.enum(['homepage', 'status']),
    part: z.enum(['envelope', 'monitors']),
    monitor_offset: z.number().int().min(0).optional().default(0),
    monitor_limit: z.number().int().min(1).max(10).optional().default(5),
  }),
  z.object({
    generation_at: z.number().int().min(0).optional(),
    step: z.literal('assemble'),
    kind: z.enum(['homepage', 'status']),
  }),
  z.object({
    generation_at: z.number().int().min(0).optional(),
    step: z.literal('artifact'),
    kind: z.literal('homepage'),
    generated_at: z.number().int().min(0).optional(),
  }),
]);

type InternalScheduledCheckBatchBody = {
  token?: string;
  ids: number[];
  checked_at: number;
  suppressed_monitor_ids?: number[];
  state_failures_to_down_from_up: number;
  state_successes_to_up_from_down: number;
  allow_notifications?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isInternalRefreshBody(
  value: unknown,
): value is { token?: string; runtime_updates?: unknown } {
  return isRecord(value);
}

function parseInternalRefreshRuntimeUpdates(
  value: unknown,
): { runtime_updates?: MonitorRuntimeUpdate[] } | null {
  if (!isInternalRefreshBody(value)) {
    return null;
  }
  if (value.token !== undefined && typeof value.token !== 'string') {
    return null;
  }
  if (value.runtime_updates === undefined) {
    return {};
  }

  const runtimeUpdates = parseMonitorRuntimeUpdates(value.runtime_updates);
  return runtimeUpdates ? { runtime_updates: runtimeUpdates } : null;
}

function parseInternalScheduledCheckBatchBody(
  value: unknown,
): InternalScheduledCheckBatchBody | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.token !== undefined && typeof value.token !== 'string') {
    return null;
  }
  if (!Array.isArray(value.ids) || value.ids.length === 0 || !value.ids.every(isPositiveInteger)) {
    return null;
  }
  if (!isNonNegativeInteger(value.checked_at)) {
    return null;
  }
  if (
    value.suppressed_monitor_ids !== undefined &&
    (!Array.isArray(value.suppressed_monitor_ids) ||
      !value.suppressed_monitor_ids.every(isPositiveInteger))
  ) {
    return null;
  }
  if (
    !isPositiveInteger(value.state_failures_to_down_from_up) ||
    value.state_failures_to_down_from_up > 10 ||
    !isPositiveInteger(value.state_successes_to_up_from_down) ||
    value.state_successes_to_up_from_down > 10
  ) {
    return null;
  }
  if (value.allow_notifications !== undefined && typeof value.allow_notifications !== 'boolean') {
    return null;
  }

  return {
    ...(value.token !== undefined ? { token: value.token } : {}),
    ids: value.ids,
    checked_at: value.checked_at,
    ...(value.suppressed_monitor_ids !== undefined
      ? { suppressed_monitor_ids: value.suppressed_monitor_ids }
      : {}),
    state_failures_to_down_from_up: value.state_failures_to_down_from_up,
    state_successes_to_up_from_down: value.state_successes_to_up_from_down,
    ...(value.allow_notifications !== undefined
      ? { allow_notifications: value.allow_notifications }
      : {}),
  };
}

function finalizeInternalRefreshResponse(
  res: Response,
  trace: Trace | null,
  traceMod: typeof import('./observability/trace') | null,
  info: { refreshed?: boolean; error?: boolean },
): Response {
  if (!trace?.enabled || !traceMod) {
    return res;
  }

  if (typeof info.refreshed === 'boolean') {
    trace.setLabel('refreshed', info.refreshed);
  }
  if (info.error) {
    trace.setLabel('error', '1');
  }

  trace.finish('total');
  const traceInfo = trace.toInfoHeader();
  const serverTiming = trace.toServerTiming('w');
  traceMod.applyTraceToResponse({ res, trace, prefix: 'w', info: traceInfo, serverTiming });
  console.log(
    info.error
      ? `internal-refresh: id=${trace.id} failed=1 timing=${serverTiming} info=${traceInfo}`
      : `internal-refresh: id=${trace.id} refreshed=${info.refreshed} timing=${serverTiming} info=${traceInfo}`,
  );
  return res;
}

function finalizeInternalCheckBatchResponse(
  res: Response,
  trace: Trace | null,
  traceMod: typeof import('./observability/trace') | null,
  info: { ok?: boolean; error?: boolean },
): Response {
  if (!trace?.enabled || !traceMod) {
    return res;
  }

  if (typeof info.ok === 'boolean') {
    trace.setLabel('ok', info.ok);
  }
  if (info.error) {
    trace.setLabel('error', '1');
  }

  trace.finish('total');
  const traceInfo = trace.toInfoHeader();
  const serverTiming = trace.toServerTiming('w');
  traceMod.applyTraceToResponse({ res, trace, prefix: 'w', info: traceInfo, serverTiming });
  console.log(
    info.error
      ? `internal-check-batch: id=${trace.id} failed=1 timing=${serverTiming} info=${traceInfo}`
      : `internal-check-batch: id=${trace.id} ok=${info.ok} timing=${serverTiming} info=${traceInfo}`,
  );
  return res;
}

async function handleInternalHomepageRefresh(request: Request, env: Env): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  let traceMod: typeof import('./observability/trace') | null = null;
  let trace: Trace | null = null;
  if (normalizeTruthyHeader(request.headers.get('X-Uptimer-Trace'))) {
    traceMod = await import('./observability/trace');
    trace = new traceMod.Trace(
      traceMod.resolveTraceOptions({
        header: (name) => request.headers.get(name) ?? undefined,
        env: env as unknown as Record<string, unknown>,
      }),
    );
  }

  let runtimeUpdates: MonitorRuntimeUpdate[] | undefined;
  const scheduledRefreshRequest = isScheduledRefreshRequest(request);
  const contentType = request.headers.get('Content-Type') ?? '';
  const traceResidualDetails =
    trace?.enabled === true && normalizeTruthyHeader(env.UPTIMER_HOMEPAGE_RESIDUAL_TRACE ?? null);
  const detailTrace: Trace | undefined = traceResidualDetails && trace ? trace : undefined;

  if (trace?.enabled && traceResidualDetails) {
    trace.setLabel('request_content_length', request.headers.get('Content-Length') ?? 'unknown');
    trace.setLabel(
      'internal_format',
      wantsCompactInternalFormat(request) ? 'compact-v1' : 'default',
    );
  }

  if (contentType.includes('application/json')) {
    const rawBody = detailTrace
      ? await detailTrace.timeAsync(
          'homepage_refresh_body_json_read',
          async () => await request.json().catch(() => null),
        )
      : await request.json().catch(() => null);
    const parseBody = () =>
      scheduledRefreshRequest
        ? parseInternalRefreshRuntimeUpdates(rawBody)
        : (() => {
            const parsed = internalRefreshJsonBodySchema.safeParse(rawBody);
            if (!parsed.success) {
              return null;
            }

            const runtime_updates = parsed.data.runtime_updates;
            if (runtime_updates === undefined) {
              return {};
            }

            const parsedRuntimeUpdates = parseMonitorRuntimeUpdates(runtime_updates);
            return parsedRuntimeUpdates ? { runtime_updates: parsedRuntimeUpdates } : null;
          })();
    const parsedBody = detailTrace
      ? detailTrace.time('homepage_refresh_body_parse_validate', parseBody)
      : parseBody();
    if (!parsedBody) {
      return new Response('Forbidden', { status: 403 });
    }

    runtimeUpdates = parsedBody.runtime_updates;
  }

  const result = await runInternalHomepageRefreshCore({
    env,
    now: Math.floor(Date.now() / 1000),
    scheduledRefreshRequest,
    ...(runtimeUpdates ? { runtimeUpdates } : {}),
    trace,
  });

  return finalizeInternalRefreshResponse(
    buildInternalRefreshResponse(result.ok, result.refreshed),
    trace,
    traceMod,
    { refreshed: result.refreshed, ...(result.error ? { error: true } : {}) },
  );
}
async function handleInternalShardedPublicSnapshotAssemble(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!normalizeTruthyHeader(env.UPTIMER_PUBLIC_SHARDED_ASSEMBLER ?? null)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const parsed = internalShardedPublicSnapshotBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const { assembleShardedPublicSnapshot } = await import('./internal/sharded-public-snapshot-core');
  const canPublish =
    parsed.data.publish &&
    normalizeTruthyHeader(env.UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH ?? null);
  const result = await assembleShardedPublicSnapshot({
    env,
    kind: parsed.data.kind,
    mode: parsed.data.assembly,
    measureBodyBytes: parsed.data.measure_body_bytes,
    publish: canPublish,
    now: Math.floor(Date.now() / 1000),
  });
  return buildInternalJsonResponse(
    {
      ok: result.ok,
      assembled: result.assembled,
      kind: result.kind,
      assembly: result.mode,
      monitor_count: result.monitorCount,
      invalid_count: result.invalidCount,
      stale_count: result.staleCount,
      ...(result.generatedAt !== undefined ? { generated_at: result.generatedAt } : {}),
      ...(result.bodyBytes !== undefined ? { body_bytes: result.bodyBytes } : {}),
      ...(result.published !== undefined ? { published: result.published } : {}),
      ...(result.artifactPublished !== undefined
        ? { artifact_published: result.artifactPublished }
        : {}),
      ...(result.writeCount !== undefined ? { write_count: result.writeCount } : {}),
      ...(result.skip ? { skip: result.skip } : {}),
      ...(result.error ? { error: true } : {}),
      ...(result.errorName ? { error_name: result.errorName } : {}),
      ...(result.errorMessage ? { error_message: result.errorMessage } : {}),
    },
    result.ok,
  );
}

async function handleInternalShardedPublicSnapshotSeed(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!normalizeTruthyHeader(env.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED ?? null)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const parsed = internalShardedPublicSnapshotSeedBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const { seedShardedPublicSnapshotFragments } =
    await import('./internal/sharded-public-snapshot-core');
  const result = await seedShardedPublicSnapshotFragments({
    env,
    kind: parsed.data.kind,
    part: parsed.data.part,
    now: Math.floor(Date.now() / 1000),
    offset: parsed.data.monitor_offset,
    limit: parsed.data.monitor_limit,
  });
  return buildInternalJsonResponse(
    {
      ok: result.ok,
      seeded: result.seeded,
      kind: result.kind,
      part: result.part,
      monitor_count: result.monitorCount,
      monitor_offset: result.monitorOffset,
      monitor_limit: result.monitorLimit,
      write_count: result.writeCount,
      ...(result.generatedAt !== undefined ? { generated_at: result.generatedAt } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
    },
    result.ok,
  );
}

async function handleInternalShardedPublicSnapshotContinuation(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!normalizeTruthyHeader(env.UPTIMER_SCHEDULED_SHARDED_CONTINUATION ?? null)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const parsed = internalShardedPublicSnapshotContinuationBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const { runShardedPublicSnapshotContinuation } =
    await import('./internal/sharded-public-snapshot-continuation');
  const result = await runShardedPublicSnapshotContinuation({
    env,
    ctx,
    now: parsed.data.generation_at ?? Math.floor(Date.now() / 1000),
    step:
      parsed.data.step === 'runtime'
        ? {
            step: 'runtime',
            ...(parsed.data.update_offset !== undefined
              ? { updateOffset: parsed.data.update_offset }
              : {}),
            ...(parsed.data.update_limit !== undefined
              ? { updateLimit: parsed.data.update_limit }
              : {}),
          }
        : parsed.data.step === 'assemble'
          ? { step: 'assemble', kind: parsed.data.kind }
          : parsed.data.step === 'artifact'
            ? {
                step: 'artifact',
                kind: 'homepage',
                ...(parsed.data.generated_at !== undefined
                  ? { generatedAt: parsed.data.generated_at }
                  : {}),
              }
            : {
                step: 'seed',
                kind: parsed.data.kind,
                part: parsed.data.part,
                monitorOffset: parsed.data.monitor_offset,
                monitorLimit: parsed.data.monitor_limit,
              },
  });
  const toResponseStep = (step: NonNullable<typeof result.nextStep>) =>
    step.step === 'runtime'
      ? {
          step: 'runtime',
          ...(step.updateOffset !== undefined ? { update_offset: step.updateOffset } : {}),
          ...(step.updateLimit !== undefined ? { update_limit: step.updateLimit } : {}),
        }
      : step.step === 'assemble'
        ? { step: 'assemble', kind: step.kind }
        : step.step === 'artifact'
          ? {
              step: 'artifact',
              kind: step.kind,
              ...(step.generatedAt !== undefined ? { generated_at: step.generatedAt } : {}),
            }
          : {
              step: 'seed',
              kind: step.kind,
              part: step.part,
              monitor_offset: step.monitorOffset ?? 0,
              monitor_limit: step.monitorLimit ?? 5,
            };
  const nextStep = result.nextStep ? toResponseStep(result.nextStep) : undefined;
  const nextSteps = result.nextSteps?.map(toResponseStep);
  return buildInternalJsonResponse(
    {
      ok: result.ok,
      step: result.step,
      continued: result.continued,
      ...(result.refreshed !== undefined ? { refreshed: result.refreshed } : {}),
      ...(result.seeded !== undefined ? { seeded: result.seeded } : {}),
      ...(result.assembled !== undefined ? { assembled: result.assembled } : {}),
      ...(result.published !== undefined ? { published: result.published } : {}),
      ...(result.artifactPublished !== undefined
        ? { artifact_published: result.artifactPublished }
        : {}),
      ...(result.kind ? { kind: result.kind } : {}),
      ...(result.part ? { part: result.part } : {}),
      ...(result.generatedAt !== undefined ? { generated_at: result.generatedAt } : {}),
      ...(result.monitorCount !== undefined ? { monitor_count: result.monitorCount } : {}),
      ...(result.monitorOffset !== undefined ? { monitor_offset: result.monitorOffset } : {}),
      ...(result.monitorLimit !== undefined ? { monitor_limit: result.monitorLimit } : {}),
      ...(result.writeCount !== undefined ? { write_count: result.writeCount } : {}),
      ...(result.invalidCount !== undefined ? { invalid_count: result.invalidCount } : {}),
      ...(result.staleCount !== undefined ? { stale_count: result.staleCount } : {}),
      ...(result.updateOffset !== undefined ? { update_offset: result.updateOffset } : {}),
      ...(result.updateLimit !== undefined ? { update_limit: result.updateLimit } : {}),
      ...(result.rowCount !== undefined ? { row_count: result.rowCount } : {}),
      ...(result.hasMore !== undefined ? { has_more: result.hasMore } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.error ? { error: true } : {}),
      ...(result.errorName ? { error_name: result.errorName } : {}),
      ...(result.errorMessage ? { error_message: result.errorMessage } : {}),
      ...(result.diagnosticStep ? { diagnostic_step: result.diagnosticStep } : {}),
      ...(result.operationMs !== undefined ? { operation_ms: result.operationMs } : {}),
      ...(result.queueMs !== undefined ? { queue_ms: result.queueMs } : {}),
      ...(result.totalMs !== undefined ? { total_ms: result.totalMs } : {}),
      ...(nextStep ? { next_step: nextStep } : {}),
      ...(nextSteps && nextSteps.length > 0 ? { next_steps: nextSteps } : {}),
    },
    result.ok,
  );
}

async function handleInternalRuntimeUpdateFragmentsWrite(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!normalizeTruthyHeader(env.UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES ?? null)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const parsed = internalRuntimeUpdateFragmentsWriteBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response('Bad Request', { status: 400 });
  }
  const updates = parseMonitorRuntimeUpdates(parsed.data.runtime_updates);
  if (!updates) {
    return new Response('Bad Request', { status: 400 });
  }

  const [{ buildMonitorRuntimeUpdateFragmentWrites }, { writePublicSnapshotFragments }] =
    await Promise.all([
      import('./snapshots/public-monitor-fragments'),
      import('./snapshots/public-fragments'),
    ]);
  const now = Math.floor(Date.now() / 1000);
  const fragmentWrites = buildMonitorRuntimeUpdateFragmentWrites(updates, now);
  if (fragmentWrites.length > 0) {
    await writePublicSnapshotFragments(env.DB, fragmentWrites);
  }

  return buildInternalJsonResponse(
    {
      ok: true,
      written: fragmentWrites.length > 0,
      update_count: updates.length,
      write_count: fragmentWrites.length,
    },
    true,
  );
}

async function handleInternalRuntimeFragmentsRefresh(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const { refreshMonitorRuntimeSnapshotFromUpdateFragments } =
    await import('./internal/runtime-fragments-refresh-core');
  const result = await refreshMonitorRuntimeSnapshotFromUpdateFragments({
    env,
    now: Math.floor(Date.now() / 1000),
  });
  return buildInternalJsonResponse(
    {
      ok: result.ok,
      refreshed: result.refreshed,
      update_count: result.updateCount,
      invalid_count: result.invalidCount,
      stale_count: result.staleCount,
      ...(result.skip ? { skip: result.skip } : {}),
    },
    result.ok,
  );
}

async function handleInternalScheduledCheckBatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const maxPastCheckedAtSkewSeconds = 5 * 60;
  const diagnosticsEnabled = shouldLogInternalCheckBatchDiagnostics(env);
  const diagnosticsStartedAt = diagnosticsEnabled ? performance.now() : 0;
  const diagnosticsTimings: InternalCheckBatchDiagnosticTimings = {};
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  let traceMod: typeof import('./observability/trace') | null = null;
  let trace: Trace | null = null;
  if (normalizeTruthyHeader(request.headers.get('X-Uptimer-Trace'))) {
    traceMod = await import('./observability/trace');
    trace = new traceMod.Trace(
      traceMod.resolveTraceOptions({
        header: (name) => request.headers.get(name) ?? undefined,
        env: env as unknown as Record<string, unknown>,
      }),
    );
  }
  trace?.setLabel('route', 'internal/scheduled-check-batch');

  const rawBody = await timeInternalCheckBatchDiagnostic(
    diagnosticsEnabled,
    diagnosticsTimings,
    'parse',
    async () =>
      trace
        ? await trace.timeAsync(
            'check_batch_parse_body',
            async () => await request.json().catch(() => null),
          )
        : await request.json().catch(() => null),
  );
  const parsedBody = parseInternalScheduledCheckBatchBody(rawBody);
  if (!parsedBody) {
    return new Response('Forbidden', { status: 403 });
  }
  const now = Math.floor(Date.now() / 1000);
  trace?.setLabel('now', now);
  trace?.setLabel('checked_at', parsedBody.checked_at);
  trace?.setLabel('ids', parsedBody.ids.length);
  trace?.setLabel('allow_notifications', parsedBody.allow_notifications === true);
  const currentCheckedAt = Math.floor(now / 60) * 60;
  if (
    parsedBody.checked_at > currentCheckedAt ||
    parsedBody.checked_at < currentCheckedAt - maxPastCheckedAtSkewSeconds
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const ids = [...new Set(parsedBody.ids)];
  const suppressedMonitorIds = new Set(parsedBody.suppressed_monitor_ids ?? []);
  const trustSchedulerLease =
    normalizeTruthyHeader(env.UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE ?? null) &&
    runtimeProfile(env.UPTIMER_RUNTIME_PROFILE) !== 'paid';
  const [{ runExclusivePersistedMonitorBatch }, notificationsModule] =
    await timeInternalCheckBatchDiagnostic(
      diagnosticsEnabled,
      diagnosticsTimings,
      'imports',
      async () =>
        await (trace
          ? trace.timeAsync(
              'check_batch_import_modules',
              async () =>
                await Promise.all([
                  import('./scheduler/scheduled'),
                  parsedBody.allow_notifications === true
                    ? import('./scheduler/notifications')
                    : Promise.resolve(null),
                ]),
            )
          : Promise.all([
              import('./scheduler/scheduled'),
              parsedBody.allow_notifications === true
                ? import('./scheduler/notifications')
                : Promise.resolve(null),
            ])),
    );

  const notify = notificationsModule
    ? await timeInternalCheckBatchDiagnostic(
        diagnosticsEnabled,
        diagnosticsTimings,
        'notify',
        async () =>
          trace
            ? await trace.timeAsync(
                'check_batch_notify_context',
                async () => await notificationsModule.createNotifyContext(env, ctx),
              )
            : await notificationsModule.createNotifyContext(env, ctx),
      )
    : null;
  let result;
  try {
    const runBatch = async () =>
      await runExclusivePersistedMonitorBatch({
        db: env.DB,
        ids,
        checkedAt: parsedBody.checked_at,
        bufferSamples: usesBoundedPublicSeeds(env),
        abortSignal: request.signal,
        suppressedMonitorIds,
        trustSchedulerLease,
        sharedMonitorLeases: runtimeProfile(env.UPTIMER_RUNTIME_PROFILE) === 'paid',
        stateMachineConfig: {
          failuresToDownFromUp: parsedBody.state_failures_to_down_from_up,
          successesToUpFromDown: parsedBody.state_successes_to_up_from_down,
        },
        ...(notificationsModule && notify
          ? {
              onPersistedMonitor: (completed: CompletedDueMonitor) =>
                notificationsModule.queueMonitorNotification(env, notify, completed),
            }
          : {}),
        ...(trace ? { trace } : {}),
      });
    result = await timeInternalCheckBatchDiagnostic(
      diagnosticsEnabled,
      diagnosticsTimings,
      'run',
      async () => (trace ? await trace.timeAsync('check_batch_run', runBatch) : await runBatch()),
    );
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(err.message);
      return finalizeInternalCheckBatchResponse(
        new Response('Service Unavailable', {
          status: 503,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
        trace,
        traceMod,
        { ok: false },
      );
    }
    console.error('internal scheduled check batch failed', err);
    return finalizeInternalCheckBatchResponse(
      new Response('Internal Server Error', {
        status: 500,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
      trace,
      traceMod,
      { ok: false, error: true },
    );
  }

  const monitorUpdateFragmentWritesEnabled =
    !usesBoundedPublicSeeds(env) &&
    normalizeTruthyHeader(env.UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES ?? null);
  const runtimeFragmentsOnly =
    monitorUpdateFragmentWritesEnabled && wantsRuntimeUpdateFragmentsOnly(request);
  let fragmentWriteCount = 0;
  if (monitorUpdateFragmentWritesEnabled) {
    const [{ buildMonitorRuntimeUpdateFragmentWrites }, { writePublicSnapshotFragments }] =
      await timeInternalCheckBatchDiagnostic(
        diagnosticsEnabled,
        diagnosticsTimings,
        'fragmentImports',
        async () =>
          await Promise.all([
            import('./snapshots/public-monitor-fragments'),
            import('./snapshots/public-fragments'),
          ]),
      );
    const fragmentWrites = timeInternalCheckBatchDiagnosticSync(
      diagnosticsEnabled,
      diagnosticsTimings,
      'fragmentBuild',
      () => buildMonitorRuntimeUpdateFragmentWrites(result.runtimeUpdates, now),
    );
    fragmentWriteCount = fragmentWrites.length;
    if (trace?.enabled) {
      trace.setLabel('monitor_update_fragment_write_count', fragmentWrites.length);
      trace.setLabel('runtime_updates_fragmented', runtimeFragmentsOnly ? 1 : 0);
    }
    if (fragmentWrites.length > 0) {
      const writeFragments = () =>
        writePublicSnapshotFragments(env.DB, fragmentWrites).catch((err) => {
          console.warn('internal scheduled check batch: monitor update fragment write failed', err);
        });
      if (runtimeFragmentsOnly) {
        await timeInternalCheckBatchDiagnostic(
          diagnosticsEnabled,
          diagnosticsTimings,
          'fragmentWrite',
          writeFragments,
        );
      } else {
        ctx.waitUntil(writeFragments());
      }
    }
  }

  const responseRuntimeUpdates =
    runtimeFragmentsOnly || usesBoundedPublicSeeds(env) ? [] : result.runtimeUpdates;
  const responsePayload = {
    ok: true,
    runtime_updates: wantsCompactInternalFormat(request)
      ? encodeMonitorRuntimeUpdatesCompact(responseRuntimeUpdates)
      : responseRuntimeUpdates,
    ...(runtimeFragmentsOnly ? { runtime_updates_fragmented: true } : {}),
    processed_count: result.stats.processedCount,
    rejected_count: result.stats.rejectedCount,
    attempt_total: result.stats.attemptTotal,
    http_count: result.stats.httpCount,
    tcp_count: result.stats.tcpCount,
    assertion_count: result.stats.assertionCount,
    down_count: result.stats.downCount,
    unknown_count: result.stats.unknownCount,
    checks_duration_ms: result.checksDurMs,
    persist_duration_ms: result.persistDurMs,
  };
  const bodyText = timeInternalCheckBatchDiagnosticSync(
    diagnosticsEnabled,
    diagnosticsTimings,
    'stringify',
    () =>
      trace
        ? trace.time('check_batch_stringify_response', () => JSON.stringify(responsePayload))
        : JSON.stringify(responsePayload),
  );
  logInternalCheckBatchDiagnostics({
    enabled: diagnosticsEnabled,
    timings: diagnosticsTimings,
    startedAt: diagnosticsStartedAt,
    idCount: ids.length,
    runtimeFragmentsOnly,
    fragmentWriteCount,
    runtimeUpdateCount: result.runtimeUpdates.length,
    processedCount: result.stats.processedCount,
    rejectedCount: result.stats.rejectedCount,
    attemptTotal: result.stats.attemptTotal,
    httpCount: result.stats.httpCount,
    tcpCount: result.stats.tcpCount,
    checksDurMs: result.checksDurMs,
    persistDurMs: result.persistDurMs,
  });
  return finalizeInternalCheckBatchResponse(
    new Response(bodyText, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }),
    trace,
    traceMod,
    { ok: true },
  );
}

const scheduledCohortBodySchema = z.object({
  batches: z
    .array(z.array(z.number().int().positive()).min(1).max(2))
    .min(1)
    .max(5)
    .refine((batches) => new Set(batches.flat()).size === batches.flat().length),
  checked_at: z.number().int().nonnegative(),
  suppressed_monitor_ids: z.array(z.number().int().positive()).optional().default([]),
  state_failures_to_down_from_up: z.number().int().min(1).max(10),
  state_successes_to_up_from_down: z.number().int().min(1).max(10),
  allow_notifications: z.boolean().optional().default(false),
});
async function handleInternalScheduledCohort(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isInternalServiceRequest(request) || !usesAtomicPublicPublication(env))
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!hasValidInternalAuth(request, env)) return new Response('Forbidden', { status: 403 });
  if (isRequestBodyTooLarge(request)) return new Response('Payload Too Large', { status: 413 });
  const parsed = scheduledCohortBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const now = Math.floor(Date.now() / 60000) * 60;
  if (parsed.data.checked_at > now || parsed.data.checked_at < now - 300)
    return new Response('Forbidden', { status: 403 });
  try {
    const result = await runScheduledBatchCohort(
      env,
      ctx,
      {
        batches: parsed.data.batches,
        checkedAt: parsed.data.checked_at,
        suppressedMonitorIds: parsed.data.suppressed_monitor_ids,
        allowNotifications: parsed.data.allow_notifications,
        stateMachineConfig: {
          failuresToDownFromUp: parsed.data.state_failures_to_down_from_up,
          successesToUpFromDown: parsed.data.state_successes_to_up_from_down,
        },
      },
      request.signal,
    );
    return buildInternalJsonResponse(batchResultToWire(result), true);
  } catch (error) {
    console.warn('scheduled cohort failed', error);
    return buildInternalJsonResponse({ ok: false }, false);
  }
}

const maintenanceBodySchema = z.object({
  job: z.enum(['daily-rollup', 'retention']),
  scheduled_time: z.number().int().nonnegative(),
});

async function runMaintenance(
  env: Env,
  ctx: ExecutionContext,
  job: 'daily-rollup' | 'retention',
  controller: ScheduledController,
): Promise<void> {
  if (job === 'daily-rollup') {
    const { runDailyRollup } = await import('./scheduler/daily-rollup');
    await runDailyRollup(env, controller, ctx);
  } else {
    const { runRetention } = await import('./scheduler/retention');
    await runRetention(env, controller);
  }
}

async function handleInternalMaintenance(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isInternalServiceRequest(request))
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!hasValidInternalAuth(request, env)) return new Response('Forbidden', { status: 403 });
  if (isRequestBodyTooLarge(request)) return new Response('Payload Too Large', { status: 413 });
  const parsed = maintenanceBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  await runMaintenance(env, ctx, parsed.data.job, {
    scheduledTime: parsed.data.scheduled_time,
  } as ScheduledController);
  return buildInternalJsonResponse({ ok: true }, true);
}

function queueMaintenance(
  env: Env,
  ctx: ExecutionContext,
  job: 'daily-rollup' | 'retention',
  controller: ScheduledController,
): void {
  const work =
    usesBoundedPublicSeeds(env) && env.SELF && env.ADMIN_TOKEN
      ? env.SELF.fetch(
          new Request('http://internal/api/v1/internal/maintenance', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.ADMIN_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ job, scheduled_time: controller.scheduledTime ?? Date.now() }),
          }),
        ).then(async (response) => {
          await response.body?.cancel();
          if (!response.ok) throw new Error(`Maintenance failed (HTTP ${response.status})`);
        })
      : runMaintenance(env, ctx, job, controller);
  ctx.waitUntil(work.catch((error) => console.error(`scheduled: ${job} failed`, error)));
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/internal/maintenance') {
      return handleInternalMaintenance(request, env, ctx);
    }
    if (url.pathname === '/api/v1/internal/refresh/homepage') {
      return handleInternalHomepageRefresh(request, env);
    }
    if (url.pathname === '/api/v1/internal/scheduled/check-batches') {
      return handleInternalScheduledCohort(request, env, ctx);
    }
    if (url.pathname === '/api/v1/internal/scheduled/check-batch') {
      return handleInternalScheduledCheckBatch(request, env, ctx);
    }
    if (url.pathname === '/api/v1/internal/refresh/runtime-fragments') {
      return handleInternalRuntimeFragmentsRefresh(request, env);
    }
    if (url.pathname === '/api/v1/internal/write/runtime-update-fragments') {
      return handleInternalRuntimeUpdateFragmentsWrite(request, env);
    }
    if (url.pathname === '/api/v1/internal/assemble/sharded-public-snapshot') {
      return handleInternalShardedPublicSnapshotAssemble(request, env);
    }
    if (url.pathname === '/api/v1/internal/seed/sharded-public-snapshot') {
      return handleInternalShardedPublicSnapshotSeed(request, env);
    }
    if (url.pathname === '/api/v1/internal/continue/sharded-public-snapshot') {
      return handleInternalShardedPublicSnapshotContinuation(request, env, ctx);
    }

    return handleFetch(request, env, ctx, url);
  },
  scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    const paidLaneIndex = paidCrons.indexOf(controller.cron);
    // Old Paid triggers can arrive during the switch back to Free. Do not
    // multiply coordinator calls or maintenance work during propagation.
    if (paidLaneIndex >= 0 && runtimeProfile(env.UPTIMER_RUNTIME_PROFILE) !== 'paid') return;
    const coordinator = getSiteCoordinator(env);
    if (coordinator) {
      await coordinator.scheduled({
        cron: controller.cron,
        scheduledTime: controller.scheduledTime ?? Date.now(),
      });
      return;
    }
    const scheduledAt = controller.scheduledTime ?? Date.now();
    const scheduledDate = new Date(scheduledAt);
    const isConsolidatedMinuteCron = controller.cron === '* * * * *';
    const isLegacyDailyRollupCron = controller.cron === '0 0 * * *';
    const isLegacyRetentionCron = controller.cron === '30 0 * * *';
    const shouldRunDailyRollup =
      isLegacyDailyRollupCron ||
      (isConsolidatedMinuteCron &&
        scheduledDate.getUTCHours() === 0 &&
        scheduledDate.getUTCMinutes() === 0);
    const shouldRunRetention =
      isLegacyRetentionCron ||
      (isConsolidatedMinuteCron &&
        scheduledDate.getUTCHours() === 0 &&
        scheduledDate.getUTCMinutes() === 30);

    // Keep legacy cron branches during Cloudflare's trigger propagation window,
    // but only the consolidated minute cron runs the monitor tick.
    if (shouldRunDailyRollup) queueMaintenance(env, ctx, 'daily-rollup', controller);
    if (shouldRunRetention) queueMaintenance(env, ctx, 'retention', controller);

    if (isLegacyDailyRollupCron || isLegacyRetentionCron) {
      return;
    }

    if (paidLaneIndex >= 0) {
      await runScheduledTick(env, ctx, `scheduler:paid-lane:${paidLaneIndex + 1}`);
    } else {
      await runScheduledTick(env, ctx);
    }
  },
} satisfies ExportedHandler<Env>;
