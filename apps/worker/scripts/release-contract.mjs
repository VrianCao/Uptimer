import { createHash } from 'node:crypto';
import { z } from 'zod';
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const revision = z.string().regex(/^[a-f0-9]{40}$/);
export const targetSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  worker: name,
  database: name,
  databaseId: z.string().uuid().nullable(),
  pages: name,
  hosting: z.enum(['pages', 'single_worker']),
  profile: z.enum(['free', 'paid']),
  operation: z.enum(['install', 'upgrade']),
  workerUrl: z.string().url(),
  apiBase: z.string(),
  apiOrigin: z.string().url(),
});
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sorted(value[k])]),
    );
  return value;
}
export function sha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(sorted(value)),
    )
    .digest('hex');
}
export function assertTarget(input, repository) {
  const t = targetSchema.parse(input);
  if (t.repository !== repository) throw Error('Package repository differs from this run');
  for (const raw of [t.workerUrl, t.apiOrigin]) {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw Error('Deployment origins must be HTTPS origins');
  }
  if (
    t.repository === 'VrianCao/UptimerDev' &&
    (t.accountId !== 'd0e503309591b218a458127b73b0d227' ||
      t.worker !== 'uptimerdev' ||
      t.database !== 'uptimerdev' ||
      t.pages !== 'uptimerdev' ||
      t.databaseId !== '5f5382be-6cf2-4315-a6a3-6d78d42fe3b3' ||
      t.operation !== 'upgrade')
  )
    throw Error('Dev can only use its existing authorized resources');
  if (
    t.repository === 'VrianCao/UptimerDev' &&
    (!/^uptimerdev\.[a-z0-9-]+\.workers\.dev$/.test(new URL(t.workerUrl).hostname) ||
      t.apiOrigin !== t.workerUrl)
  )
    throw Error('Dev API origin must be its own Worker');
  if (t.operation === 'upgrade' && !t.databaseId)
    throw Error('Upgrade requires an explicit UPTIMER_D1_ID');
  return t;
}
export const migrationSchema = z
  .array(z.object({ name: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/), sha256: digest }))
  .min(25);
export function migrationState(filesInput, appliedInput) {
  const files = migrationSchema.parse(filesInput),
    applied = z.array(z.string()).parse(appliedInput);
  if (new Set(applied).size !== applied.length) throw Error('Duplicate remote migration records');
  if (files.some((f, i) => Number(f.name.slice(0, 4)) !== i + 1))
    throw Error('Migration files must form an ordered, immutable sequence');
  const legacy = applied.filter((n) => n === '0014_check_results_without_autoincrement.sql');
  const regular = applied.filter((n) => !legacy.includes(n));
  if (regular.some((n, i) => n !== files[i]?.name))
    throw Error('Unknown or non-prefix migrations; inspect before continuing');
  return {
    applied: regular,
    legacy,
    pending: files.slice(regular.length).map((f) => f.name),
    structural: regular.length > 0 && regular.length < 19,
  };
}
export function planHash(plan) {
  const body = { ...plan };
  delete body.createdAt;
  delete body.hash;
  return sha256(body);
}
export function assertPlan(plan, expected) {
  digest.parse(expected);
  if (plan.hash !== expected || planHash(plan) !== expected)
    throw Error('Reviewed deployment plan hash does not match');
  revision.parse(plan.sourceSha);
  assertTarget(plan.target, plan.repository);
  migrationSchema.parse(plan.migrations);
  return plan;
}
export function deploymentSteps(plan, live) {
  const t = plan.target,
    before = plan.before;
  if (live.databaseId !== (t.databaseId ?? live.databaseId))
    throw Error('Database identity changed');
  if (t.operation === 'upgrade' && !live.databaseId)
    throw Error('Existing database required; automatic replacement is forbidden');
  const state = migrationState(plan.migrations, live.appliedMigrations);
  const original = migrationState(plan.migrations, before.appliedMigrations);
  if (state.applied.length < original.applied.length)
    throw Error('Migration history moved backwards');
  const workerReady =
    live.worker?.fingerprint === plan.fingerprint &&
    live.worker?.sourceSha === plan.sourceSha &&
    live.worker?.profile === t.profile &&
    live.worker?.databaseId === live.databaseId &&
    live.worker?.hosting === t.hosting;
  if (!workerReady && live.worker?.versionId !== before.worker?.versionId)
    throw Error('Worker changed outside this reviewed deployment');
  if (live.worker && live.worker.hosting !== t.hosting)
    throw Error('Hosting changes require a separate migration plan');
  const pagesReady =
    t.hosting !== 'pages' ||
    (live.pages?.sourceSha === plan.sourceSha && live.pages?.fingerprint === plan.fingerprint);
  if (
    !pagesReady &&
    live.pages?.deploymentId !== before.pages?.deploymentId &&
    !(!before.pages && !live.pages?.deploymentId) &&
    live.pages?.fingerprint !== plan.fingerprint
  )
    throw Error('Pages changed outside this reviewed deployment');
  if (!live.databaseId && (live.worker || live.pages))
    throw Error('Refusing to attach existing services to a new empty database');
  if (
    !t.databaseId &&
    before.databaseId !== live.databaseId &&
    live.databaseId &&
    !live.emptyProjectDatabase &&
    !workerReady
  )
    throw Error('Unreviewed database appeared; generate a new plan');
  return {
    createDatabase: !live.databaseId,
    migrate: state.pending.length > 0,
    pendingMigrations: state.pending,
    worker: !workerReady,
    initializeSecret: !live.worker?.secretNames?.includes('ADMIN_TOKEN'),
    pages: t.hosting === 'pages' && !pagesReady,
    createPages: t.hosting === 'pages' && !live.pages,
    structuralUpgrade: state.structural,
    profileChange: !!live.worker?.profile && live.worker.profile !== t.profile,
  };
}
export function assertImmutableMigrationDiff(changes) {
  for (const { status, path } of changes)
    if (/^apps\/worker\/migrations\/.*\.sql$/.test(path) && status !== 'A')
      throw Error('Published migrations cannot be modified or deleted: ' + path);
}
