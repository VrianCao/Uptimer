import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTarget,
  migrationState,
  sha256,
  planHash,
  assertPlan,
  deploymentSteps,
  assertImmutableMigrationDiff,
} from './release-contract.mjs';
const migrations = Array.from({ length: 25 }, (_, i) => ({
  name: String(i + 1).padStart(4, '0') + '_test.sql',
  sha256: 'a'.repeat(64),
}));
const target = {
  repository: 'alice/uptimer',
  accountId: 'a'.repeat(32),
  worker: 'uptimer',
  database: 'uptimer',
  databaseId: '12345678-1234-4123-8123-123456789abc',
  pages: 'uptimer',
  hosting: 'pages',
  profile: 'free',
  operation: 'upgrade',
  workerUrl: 'https://uptimer.alice.workers.dev',
  apiBase: '/api/v1',
  apiOrigin: 'https://uptimer.alice.workers.dev',
};
const before = {
  databaseId: target.databaseId,
  appliedMigrations: migrations.map((m) => m.name),
  worker: {
    versionId: 'old',
    profile: 'free',
    databaseId: target.databaseId,
    hosting: 'pages',
    secretNames: ['ADMIN_TOKEN'],
  },
  pages: { projectId: 'pages-id', productionBranch: 'master', deploymentId: 'old-page' },
};
const candidate = () => {
  const p = {
    createdAt: 'then',
    repository: target.repository,
    target,
    sourceSha: 'b'.repeat(40),
    fingerprint: 'c'.repeat(64),
    migrations,
    before: structuredClone(before),
  };
  p.hash = planHash(p);
  return p;
};
test('canonical hashes do not depend on object key insertion order', () => {
  assert.equal(sha256({ a: 1, b: { d: 4, c: 3 } }), sha256({ b: { c: 3, d: 4 }, a: 1 }));
});
test('Dev guards reject another account, namespace or a new database', () => {
  assert.throws(() =>
    assertTarget({ ...target, repository: 'VrianCao/UptimerDev' }, 'VrianCao/UptimerDev'),
  );
  assert.throws(() => assertTarget(target, 'other/repo'));
  assert.throws(() =>
    assertTarget({ ...target, apiOrigin: 'http://bad.example' }, target.repository),
  );
});
test('migration tracker preserves known history, rejects holes and unknown files', () => {
  const names = migrations.slice(0, 14).map((m) => m.name);
  assert.equal(
    migrationState(migrations, [...names, '0014_check_results_without_autoincrement.sql']).legacy
      .length,
    1,
  );
  assert.throws(() => migrationState(migrations, [names[0], names[2]]));
  assert.throws(() => migrationState(migrations, [...names, 'unknown.sql']));
  assert.throws(() => migrationState(migrations, [names[0], names[0]]));
});
test('approved plan binds artifact/source/target and excludes its creation clock', () => {
  const p = candidate();
  assertPlan({ ...p, createdAt: 'later' }, p.hash);
  assert.throws(() => assertPlan({ ...p, sourceSha: 'e'.repeat(40) }, p.hash));
  assert.throws(() => assertPlan({ ...p, target: { ...target, worker: 'other' } }, p.hash));
});
test('successful repeat skips deployment and never rotates an existing token', () => {
  const p = candidate(),
    live = structuredClone(before);
  live.worker = {
    ...live.worker,
    versionId: 'new',
    fingerprint: p.fingerprint,
    sourceSha: p.sourceSha,
  };
  live.pages = {
    ...live.pages,
    deploymentId: 'new-page',
    sourceSha: p.sourceSha,
    fingerprint: p.fingerprint,
  };
  const s = deploymentSteps(p, live);
  assert.equal(s.worker, false);
  assert.equal(s.pages, false);
  assert.equal(s.migrate, false);
  assert.equal(s.initializeSecret, false);
});
test('Pages failure resumes with the already updated Worker', () => {
  const p = candidate(),
    live = structuredClone(before);
  live.worker = {
    ...live.worker,
    versionId: 'new',
    fingerprint: p.fingerprint,
    sourceSha: p.sourceSha,
  };
  assert.equal(deploymentSteps(p, live).worker, false);
  assert.equal(deploymentSteps(p, live).pages, true);
});
test('partial migrations are resumed by prefix, never reapplied or reverted', () => {
  const p = candidate();
  p.before.appliedMigrations = migrations.slice(0, 14).map((m) => m.name);
  const live = structuredClone(before);
  live.appliedMigrations = migrations.slice(0, 18).map((m) => m.name);
  const s = deploymentSteps(p, live);
  assert.equal(s.pendingMigrations.length, 7);
  assert.equal(s.pendingMigrations[0], migrations[18].name);
  assert.equal(s.structuralUpgrade, true);
});
test('external version drift, hosting change and replacement database fail closed', () => {
  const p = candidate();
  assert.throws(() =>
    deploymentSteps(p, { ...before, worker: { ...before.worker, versionId: 'foreign' } }),
  );
  assert.throws(() =>
    deploymentSteps(p, { ...before, worker: { ...before.worker, hosting: 'single_worker' } }),
  );
  assert.throws(() => deploymentSteps(p, { ...before, databaseId: null }));
  assert.throws(() =>
    deploymentSteps(p, { ...before, databaseId: '87654321-1234-4123-8123-123456789abc' }),
  );
  for (const pages of [
    null,
    { ...before.pages, projectId: 'replacement-pages' },
    { ...before.pages, productionBranch: 'preview' },
  ])
    assert.throws(() => deploymentSteps(p, { ...before, pages }), /Pages project identity/);
});
test('migration immutability permits additions only', () => {
  assertImmutableMigrationDiff([{ status: 'A', path: 'apps/worker/migrations/0026_new.sql' }]);
  assert.throws(() =>
    assertImmutableMigrationDiff([{ status: 'M', path: 'apps/worker/migrations/0016_old.sql' }]),
  );
  assert.throws(() =>
    assertImmutableMigrationDiff([{ status: 'D', path: 'apps/worker/migrations/0025_old.sql' }]),
  );
});
