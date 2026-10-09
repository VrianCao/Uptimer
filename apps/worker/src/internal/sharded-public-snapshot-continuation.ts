import type { Env } from '../env';
import {
  refreshMonitorRuntimeSnapshotFromUpdateFragments,
  refreshMonitorRuntimeSnapshotFromUpdateFragmentsPage,
} from './runtime-fragments-refresh-core';
import {
  assembleShardedPublicSnapshot,
  publishHomepageArtifactSnapshotFromPublishedHomepage,
  seedShardedPublicSnapshotFragments,
  type ShardedPublicSnapshotAssemblyMode,
  type ShardedPublicSnapshotKind,
  type ShardedPublicSnapshotSeedPart,
} from './sharded-public-snapshot-core';

export type ShardedPublicSnapshotContinuationStep =
  | { step: 'runtime'; updateOffset?: number; updateLimit?: number }
  | {
      step: 'seed';
      kind: ShardedPublicSnapshotKind;
      part: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
      monitorOffset?: number;
      monitorLimit?: number;
    }
  | { step: 'assemble'; kind: ShardedPublicSnapshotKind }
  | { step: 'artifact'; kind: 'homepage'; generatedAt?: number };

export type ShardedPublicSnapshotContinuationResult = {
  ok: boolean;
  step: ShardedPublicSnapshotContinuationStep['step'];
  continued: boolean;
  nextStep?: ShardedPublicSnapshotContinuationStep;
  nextSteps?: ShardedPublicSnapshotContinuationStep[];
  refreshed?: boolean;
  seeded?: boolean;
  assembled?: boolean;
  published?: boolean;
  artifactPublished?: boolean;
  kind?: ShardedPublicSnapshotKind;
  part?: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
  generatedAt?: number;
  monitorCount?: number;
  monitorOffset?: number;
  monitorLimit?: number;
  writeCount?: number;
  invalidCount?: number;
  staleCount?: number;
  updateOffset?: number;
  updateLimit?: number;
  rowCount?: number;
  hasMore?: boolean;
  skipped?: string;
  error?: boolean;
  errorName?: string;
  errorMessage?: string;
  diagnosticStep?: string;
  operationMs?: number;
  queueMs?: number;
  totalMs?: number;
};

const CONTINUATION_PATH = '/api/v1/internal/continue/sharded-public-snapshot';
const DEFAULT_MONITOR_LIMIT = 5;

function isTruthyEnvFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readBoundedMonitorLimit(env: Env, requested?: number): number {
  const raw =
    requested ??
    (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE;
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_MONITOR_LIMIT;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function readOptionalBoundedRuntimeUpdateLimit(env: Env, requested?: number): number | null {
  const raw =
    requested ??
    (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_RUNTIME_UPDATE_BATCH_SIZE;
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function readAssemblyMode(env: Env): ShardedPublicSnapshotAssemblyMode {
  const raw = (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_ASSEMBLER_MODE;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'json' ? 'json' : 'validated';
}

function canRefreshRuntimeFragments(env: Env): boolean {
  return isTruthyEnvFlag(
    (env as unknown as Record<string, unknown>).UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH,
  );
}

function canSeedShardedFragments(env: Env): boolean {
  const raw = env as unknown as Record<string, unknown>;
  return (
    isTruthyEnvFlag(raw.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED) &&
    isTruthyEnvFlag(raw.UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED)
  );
}

function canAssembleShardedSnapshots(env: Env): boolean {
  const raw = env as unknown as Record<string, unknown>;
  return (
    isTruthyEnvFlag(raw.UPTIMER_PUBLIC_SHARDED_ASSEMBLER) &&
    isTruthyEnvFlag(raw.UPTIMER_SCHEDULED_SHARDED_ASSEMBLER)
  );
}

function shouldPublishShardedSnapshots(env: Env): boolean {
  const raw = env as unknown as Record<string, unknown>;
  return (
    isTruthyEnvFlag(raw.UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH) &&
    isTruthyEnvFlag(raw.UPTIMER_SCHEDULED_SHARDED_PUBLISH)
  );
}

function shouldLogDiagnostics(env: Env): boolean {
  return isTruthyEnvFlag(
    (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_CONTINUATION_DIAGNOSTICS,
  );
}

function diagnosticStepName(step: ShardedPublicSnapshotContinuationStep): string {
  if (step.step === 'runtime') {
    return step.updateLimit !== undefined ? `runtime:${step.updateOffset ?? 0}` : 'runtime';
  }
  if (step.step === 'assemble') return `assemble:${step.kind}`;
  if (step.step === 'artifact') return 'artifact:homepage';
  return `seed:${step.kind}:${step.part}:${step.monitorOffset ?? 0}`;
}

function logContinuationDiagnostics(
  env: Env,
  result: ShardedPublicSnapshotContinuationResult,
): void {
  if (!shouldLogDiagnostics(env)) return;
  const fields = [
    'sharded_continuation_step',
    `step=${result.diagnosticStep ?? result.step}`,
    result.kind ? `kind=${result.kind}` : null,
    result.part ? `part=${result.part}` : null,
    result.generatedAt !== undefined ? `generated_at=${result.generatedAt}` : null,
    result.monitorOffset !== undefined ? `offset=${result.monitorOffset}` : null,
    result.monitorLimit !== undefined ? `limit=${result.monitorLimit}` : null,
    `ok=${result.ok ? 1 : 0}`,
    `continued=${result.continued ? 1 : 0}`,
    result.refreshed !== undefined ? `refreshed=${result.refreshed ? 1 : 0}` : null,
    result.seeded !== undefined ? `seeded=${result.seeded ? 1 : 0}` : null,
    result.assembled !== undefined ? `assembled=${result.assembled ? 1 : 0}` : null,
    result.published !== undefined ? `published=${result.published ? 1 : 0}` : null,
    result.artifactPublished !== undefined
      ? `artifact_published=${result.artifactPublished ? 1 : 0}`
      : null,
    result.monitorCount !== undefined ? `monitors=${result.monitorCount}` : null,
    result.writeCount !== undefined ? `writes=${result.writeCount}` : null,
    result.updateOffset !== undefined ? `update_offset=${result.updateOffset}` : null,
    result.updateLimit !== undefined ? `update_limit=${result.updateLimit}` : null,
    result.rowCount !== undefined ? `rows=${result.rowCount}` : null,
    result.hasMore !== undefined ? `has_more=${result.hasMore ? 1 : 0}` : null,
    result.invalidCount !== undefined ? `invalid=${result.invalidCount}` : null,
    result.staleCount !== undefined ? `stale=${result.staleCount}` : null,
    result.skipped ? `skipped=${result.skipped}` : null,
    result.error ? 'error=1' : null,
    result.operationMs !== undefined ? `operation_ms=${result.operationMs}` : null,
    result.queueMs !== undefined ? `queue_ms=${result.queueMs}` : null,
    result.totalMs !== undefined ? `total_ms=${result.totalMs}` : null,
  ].filter((field): field is string => Boolean(field));
  console.log(fields.join(' '));
}

function nextSeedStep(opts: {
  kind: ShardedPublicSnapshotKind;
  part: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
  monitorOffset: number;
  monitorLimit: number;
  monitorCount: number;
}): ShardedPublicSnapshotContinuationStep {
  if (opts.part === 'envelope') {
    return opts.monitorCount > 0
      ? {
          step: 'seed',
          kind: opts.kind,
          part: 'monitors',
          monitorOffset: 0,
          monitorLimit: opts.monitorLimit,
        }
      : { step: 'assemble', kind: opts.kind };
  }

  const nextOffset = opts.monitorOffset + opts.monitorLimit;
  if (nextOffset < opts.monitorCount) {
    return {
      step: 'seed',
      kind: opts.kind,
      part: 'monitors',
      monitorOffset: nextOffset,
      monitorLimit: opts.monitorLimit,
    };
  }

  return { step: 'assemble', kind: opts.kind };
}

function firstSeedSteps(monitorLimit: number): ShardedPublicSnapshotContinuationStep[] {
  return [
    {
      step: 'seed',
      kind: 'homepage',
      part: 'envelope',
      monitorOffset: 0,
      monitorLimit,
    },
    {
      step: 'seed',
      kind: 'status',
      part: 'envelope',
      monitorOffset: 0,
      monitorLimit,
    },
  ];
}

function toWireStep(step: ShardedPublicSnapshotContinuationStep): Record<string, unknown> {
  if (step.step === 'seed') {
    return {
      step: step.step,
      kind: step.kind,
      part: step.part,
      monitor_offset: step.monitorOffset ?? 0,
      monitor_limit: step.monitorLimit ?? DEFAULT_MONITOR_LIMIT,
    };
  }
  if (step.step === 'assemble') {
    return { step: step.step, kind: step.kind };
  }
  if (step.step === 'artifact') {
    return {
      step: step.step,
      kind: step.kind,
      ...(step.generatedAt !== undefined ? { generated_at: step.generatedAt } : {}),
    };
  }
  return {
    step: step.step,
    ...(step.updateOffset !== undefined ? { update_offset: step.updateOffset } : {}),
    ...(step.updateLimit !== undefined ? { update_limit: step.updateLimit } : {}),
  };
}

function queueContinuation(
  env: Env,
  ctx: ExecutionContext,
  nextStep: ShardedPublicSnapshotContinuationStep | null,
): boolean {
  return queueContinuations(env, ctx, nextStep ? [nextStep] : []) > 0;
}

function queueContinuations(
  env: Env,
  ctx: ExecutionContext,
  nextSteps: readonly ShardedPublicSnapshotContinuationStep[],
): number {
  if (nextSteps.length === 0 || !env.SELF || !env.ADMIN_TOKEN) {
    return 0;
  }

  let queued = 0;
  for (const nextStep of nextSteps) {
    queued += 1;
    ctx.waitUntil(
      env.SELF.fetch(
        new Request(`http://internal${CONTINUATION_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(toWireStep(nextStep)),
        }),
      )
        .then(async (res) => {
          const bodyText = await res.text().catch(() => '');
          if (!res.ok) {
            throw new Error(
              `sharded public snapshot continuation failed: HTTP ${res.status} ${bodyText}`.trim(),
            );
          }
        })
        .catch((err) => {
          console.warn('sharded public snapshot continuation dispatch failed', err);
        }),
    );
  }
  return queued;
}

export async function runShardedPublicSnapshotContinuation(opts: {
  env: Env;
  ctx: ExecutionContext;
  now: number;
  step: ShardedPublicSnapshotContinuationStep;
}): Promise<ShardedPublicSnapshotContinuationResult> {
  const diagnostics = shouldLogDiagnostics(opts.env);
  const startedAt = diagnostics ? Date.now() : 0;
  const diagnosticStep = diagnosticStepName(opts.step);

  if (opts.step.step === 'runtime') {
    if (!canRefreshRuntimeFragments(opts.env)) {
      const skippedResult: ShardedPublicSnapshotContinuationResult = {
        ok: true,
        step: 'runtime',
        continued: false,
        skipped: 'runtime_disabled',
        ...(diagnostics ? { diagnosticStep, totalMs: Date.now() - startedAt } : {}),
      };
      logContinuationDiagnostics(opts.env, skippedResult);
      return skippedResult;
    }
    const runtimeLimit = readOptionalBoundedRuntimeUpdateLimit(opts.env, opts.step.updateLimit);
    const updateOffset = Math.max(0, Math.floor(opts.step.updateOffset ?? 0));
    const operationStartedAt = diagnostics ? Date.now() : 0;
    const result = runtimeLimit
      ? await refreshMonitorRuntimeSnapshotFromUpdateFragmentsPage({
          env: opts.env,
          now: opts.now,
          offset: updateOffset,
          limit: runtimeLimit,
        })
      : await refreshMonitorRuntimeSnapshotFromUpdateFragments({
          env: opts.env,
          now: opts.now,
        });
    const operationMs = diagnostics ? Date.now() - operationStartedAt : undefined;
    const nextSteps: ShardedPublicSnapshotContinuationStep[] = !result.ok
      ? []
      : runtimeLimit && result.hasMore
        ? [
            {
              step: 'runtime',
              updateOffset: updateOffset + runtimeLimit,
              updateLimit: runtimeLimit,
            },
          ]
        : firstSeedSteps(readBoundedMonitorLimit(opts.env));
    const queueStartedAt = diagnostics ? Date.now() : 0;
    const continuedCount = queueContinuations(opts.env, opts.ctx, nextSteps);
    const queueMs = diagnostics ? Date.now() - queueStartedAt : undefined;
    const continued = continuedCount > 0;
    const continuationResult: ShardedPublicSnapshotContinuationResult = {
      ok: result.ok,
      step: 'runtime',
      refreshed: result.refreshed,
      invalidCount: result.invalidCount,
      staleCount: result.staleCount,
      monitorCount: result.updateCount,
      continued,
      ...(continued ? { nextSteps: nextSteps.slice(0, continuedCount) } : {}),
      ...(result.skip ? { skipped: result.skip } : {}),
      ...(runtimeLimit
        ? {
            updateOffset: result.updateOffset ?? updateOffset,
            updateLimit: result.updateLimit ?? runtimeLimit,
            rowCount: result.rowCount ?? 0,
            hasMore: result.hasMore ?? false,
          }
        : {}),
      ...(diagnostics
        ? {
            diagnosticStep,
            operationMs: operationMs ?? 0,
            queueMs: queueMs ?? 0,
            totalMs: Date.now() - startedAt,
          }
        : {}),
    };
    logContinuationDiagnostics(opts.env, continuationResult);
    return continuationResult;
  }

  if (opts.step.step === 'seed') {
    const monitorLimit = readBoundedMonitorLimit(opts.env, opts.step.monitorLimit);
    const monitorOffset = Math.max(0, Math.floor(opts.step.monitorOffset ?? 0));
    if (!canSeedShardedFragments(opts.env)) {
      const skippedResult: ShardedPublicSnapshotContinuationResult = {
        ok: true,
        step: 'seed',
        kind: opts.step.kind,
        part: opts.step.part,
        monitorOffset,
        monitorLimit,
        continued: false,
        skipped: 'seed_disabled',
        ...(diagnostics ? { diagnosticStep, totalMs: Date.now() - startedAt } : {}),
      };
      logContinuationDiagnostics(opts.env, skippedResult);
      return skippedResult;
    }
    const operationStartedAt = diagnostics ? Date.now() : 0;
    const result = await seedShardedPublicSnapshotFragments({
      env: opts.env,
      kind: opts.step.kind,
      part: opts.step.part,
      now: opts.now,
      offset: monitorOffset,
      limit: monitorLimit,
    });
    const operationMs = diagnostics ? Date.now() - operationStartedAt : undefined;
    const nextStep = result.ok
      ? nextSeedStep({
          kind: opts.step.kind,
          part: opts.step.part,
          monitorOffset,
          monitorLimit,
          monitorCount: result.monitorCount,
        })
      : null;
    const queueStartedAt = diagnostics ? Date.now() : 0;
    const continued = queueContinuation(opts.env, opts.ctx, nextStep);
    const queueMs = diagnostics ? Date.now() - queueStartedAt : undefined;
    const continuationResult: ShardedPublicSnapshotContinuationResult = {
      ok: result.ok,
      step: 'seed',
      seeded: result.seeded,
      kind: result.kind,
      part: opts.step.part,
      monitorCount: result.monitorCount,
      monitorOffset,
      monitorLimit,
      writeCount: result.writeCount,
      continued,
      ...(continued && nextStep ? { nextStep } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.error ? { error: true } : {}),
      ...(diagnostics
        ? {
            diagnosticStep,
            operationMs: operationMs ?? 0,
            queueMs: queueMs ?? 0,
            totalMs: Date.now() - startedAt,
          }
        : {}),
    };
    logContinuationDiagnostics(opts.env, continuationResult);
    return continuationResult;
  }

  if (opts.step.step === 'artifact') {
    if (!shouldPublishShardedSnapshots(opts.env)) {
      const skippedResult: ShardedPublicSnapshotContinuationResult = {
        ok: true,
        step: 'artifact',
        kind: 'homepage',
        continued: false,
        skipped: 'artifact_publish_disabled',
        ...(diagnostics ? { diagnosticStep, totalMs: Date.now() - startedAt } : {}),
      };
      logContinuationDiagnostics(opts.env, skippedResult);
      return skippedResult;
    }
    const operationStartedAt = diagnostics ? Date.now() : 0;
    const result = await publishHomepageArtifactSnapshotFromPublishedHomepage({
      env: opts.env,
      now: opts.now,
      ...(opts.step.generatedAt !== undefined ? { generatedAt: opts.step.generatedAt } : {}),
    });
    const operationMs = diagnostics ? Date.now() - operationStartedAt : undefined;
    const continuationResult: ShardedPublicSnapshotContinuationResult = {
      ok: result.ok,
      step: 'artifact',
      kind: 'homepage',
      ...(result.generatedAt !== undefined ? { generatedAt: result.generatedAt } : {}),
      monitorCount: result.monitorCount,
      published: result.published,
      artifactPublished: result.artifactPublished,
      writeCount: result.writeCount,
      continued: false,
      ...(result.skip ? { skipped: result.skip } : {}),
      ...(result.error ? { error: true } : {}),
      ...(result.errorName ? { errorName: result.errorName } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(diagnostics
        ? { diagnosticStep, operationMs: operationMs ?? 0, totalMs: Date.now() - startedAt }
        : {}),
    };
    logContinuationDiagnostics(opts.env, continuationResult);
    return continuationResult;
  }

  if (!canAssembleShardedSnapshots(opts.env)) {
    const skippedResult: ShardedPublicSnapshotContinuationResult = {
      ok: true,
      step: 'assemble',
      kind: opts.step.kind,
      continued: false,
      skipped: 'assemble_disabled',
      ...(diagnostics ? { diagnosticStep, totalMs: Date.now() - startedAt } : {}),
    };
    logContinuationDiagnostics(opts.env, skippedResult);
    return skippedResult;
  }
  const publishShardedSnapshots = shouldPublishShardedSnapshots(opts.env);
  const operationStartedAt = diagnostics ? Date.now() : 0;
  const result = await assembleShardedPublicSnapshot({
    env: opts.env,
    kind: opts.step.kind,
    mode: readAssemblyMode(opts.env),
    now: opts.now,
    publish: publishShardedSnapshots,
    publishArtifact: false,
  });
  const operationMs = diagnostics ? Date.now() - operationStartedAt : undefined;
  const nextStep: ShardedPublicSnapshotContinuationStep | null =
    publishShardedSnapshots && result.ok && result.assembled && result.kind === 'homepage'
      ? {
          step: 'artifact',
          kind: 'homepage',
          ...(result.generatedAt !== undefined ? { generatedAt: result.generatedAt } : {}),
        }
      : null;
  const queueStartedAt = diagnostics ? Date.now() : 0;
  const continued = queueContinuation(opts.env, opts.ctx, nextStep);
  const queueMs = diagnostics ? Date.now() - queueStartedAt : undefined;
  const continuationResult: ShardedPublicSnapshotContinuationResult = {
    ok: result.ok,
    step: 'assemble',
    assembled: result.assembled,
    kind: result.kind,
    ...(result.generatedAt !== undefined ? { generatedAt: result.generatedAt } : {}),
    monitorCount: result.monitorCount,
    invalidCount: result.invalidCount,
    staleCount: result.staleCount,
    continued,
    ...(continued && nextStep ? { nextStep } : {}),
    ...(result.skip ? { skipped: result.skip } : {}),
    ...(result.published !== undefined ? { published: result.published } : {}),
    ...(result.artifactPublished !== undefined
      ? { artifactPublished: result.artifactPublished }
      : {}),
    ...(result.writeCount !== undefined ? { writeCount: result.writeCount } : {}),
    ...(result.error ? { error: true } : {}),
    ...(result.errorName ? { errorName: result.errorName } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(diagnostics
      ? {
          diagnosticStep,
          operationMs: operationMs ?? 0,
          queueMs: queueMs ?? 0,
          totalMs: Date.now() - startedAt,
        }
      : {}),
  };
  logContinuationDiagnostics(opts.env, continuationResult);
  return continuationResult;
}
