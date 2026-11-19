import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  sha256,
  revision,
  planHash,
  deploymentSteps,
  migrationState,
  requiresMigrationMaintenance,
  assertTarget,
} from './release-contract.mjs';
import {
  targetInput,
  deploymentConfig,
  migrationFiles,
  treeHashes,
  portableConfig,
  writeJson,
} from './release-config.mjs';
import { eligibleLegacyUpgrade, releaseConfigForLegacy } from './release-legacy.mjs';
// Used by both package validation and live apply. No release-only flags may
// bypass the parser/build validation of the project's locked Wrangler version.
export function workerDeployArgs(config) {
  return [
    '--filter',
    '@uptimer/worker',
    'exec',
    'wrangler',
    'deploy',
    '--no-bundle',
    '--config',
    config,
  ];
}
export async function command(args, { cwd, env = process.env, input, timeout = 300000 } = {}) {
  return new Promise((resolveDone, reject) => {
    const child = spawn('pnpm', args, {
      cwd,
      env: {
        ...env,
        CI: '1',
        WRANGLER_LOG_PATH: env.WRANGLER_LOG_PATH || '/tmp/uptimer-release-wrangler.log',
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    });
    let killTimer;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeout);
    if (input !== undefined) child.stdin.end(input);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (code === 0) resolveDone();
      else reject(Error('Release command failed: ' + (signal ?? code)));
    });
  });
}
export function publicState(state) {
  const { worker, pages, ...rest } = state;
  return {
    ...rest,
    worker: worker
      ? {
          versionId: worker.versionId,
          sourceSha: worker.sourceSha,
          fingerprint: worker.fingerprint,
          profile: worker.profile,
          ...(worker.maintenance ? { maintenance: true } : {}),
          databaseId: worker.databaseId,
          hosting: worker.hosting,
          secretNames: worker.secretNames,
        }
      : null,
    pages: pages
      ? {
          projectId: pages.projectId,
          origin: pages.origin,
          deploymentId: pages.deploymentId,
          sourceSha: pages.sourceSha,
          fingerprint: pages.fingerprint,
          productionBranch: pages.productionBranch,
        }
      : null,
  };
}
export function buildInputHash(env, target) {
  return sha256({
    target,
    adminPathHash: sha256(env.VITE_ADMIN_PATH || env.UPTIMER_ADMIN_PATH || ''),
    canonicalConfigHash: env.canonicalConfigHash,
  });
}
export async function preparePackage({ root, directory, cloud, env, run = command }) {
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length) throw Error('Prepare requires an empty output directory');
  const sourceSha = revision.parse(env.GITHUB_SHA),
    live = await cloud.inspect(),
    target = assertTarget(cloud.target, env.GITHUB_REPOSITORY);
  if (target.operation === 'upgrade' && !live.databaseId)
    throw Error('An existing database ID is required for an upgrade');
  if (target.operation === 'install' && (live.databaseId || live.worker || live.pages))
    throw Error(
      'Install planning requires unused resource names; use upgrade with the exact existing D1 ID',
    );
  const migrations = await migrationFiles(root);
  if (live.worker && live.worker.hosting !== target.hosting)
    throw Error('Keep the existing hosting mode during this upgrade');
  await mkdir(join(directory, 'worker'), { recursive: true });
  await mkdir(join(directory, 'web'), { recursive: true });
  await mkdir(join(directory, 'migrations'), { recursive: true });
  const legacyUpgrade = eligibleLegacyUpgrade(
    { target, before: publicState(live) },
    migrationState(migrations, live.appliedMigrations),
  );
  const baseConfig = await deploymentConfig(root, target, sourceSha, live.databaseId);
  const cfg = legacyUpgrade || live.legacy ? releaseConfigForLegacy(baseConfig) : baseConfig;
  // Full build happens before any remote mutation, including migration/provisioning.
  const buildEnv = {
    ...env,
    VITE_API_BASE: target.apiBase,
    VITE_ADMIN_PATH: env.VITE_ADMIN_PATH || env.UPTIMER_ADMIN_PATH || '',
  };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'UPTIMER_ADMIN_TOKEN', 'GITHUB_TOKEN'])
    delete buildEnv[key];
  await run(
    ['--filter', '@uptimer/web', 'exec', 'vite', 'build', '--outDir', join(directory, 'web')],
    { cwd: root, env: buildEnv },
  );
  const buildConfig = join(directory, 'build.json');
  await writeJson(buildConfig, {
    ...cfg,
    ...(cfg.assets ? { assets: { ...cfg.assets, directory: join(directory, 'web') } } : {}),
  });
  await run(
    [
      '--filter',
      '@uptimer/worker',
      'exec',
      'wrangler',
      'deploy',
      '--dry-run',
      '--config',
      buildConfig,
      '--outdir',
      join(directory, 'worker'),
    ],
    { cwd: root, env: buildEnv },
  );
  await rm(buildConfig);
  const js = (await readdir(join(directory, 'worker'))).filter((n) => n.endsWith('.js'));
  if (js.length !== 1) throw Error('Expected the canonical single bundled Worker module');
  if (js[0] !== 'worker-entry.js') throw Error('Unexpected Worker bundle name');
  for (const file of migrations)
    await copyFile(
      join(root, 'apps/worker/migrations', file.name),
      join(directory, 'migrations', file.name),
    );
  const deployConfig = portableConfig(cfg, directory);
  await writeJson(join(directory, 'worker/wrangler.json'), deployConfig);
  await run([...workerDeployArgs(join(directory, 'worker/wrangler.json')), '--dry-run'], {
    cwd: root,
    env: buildEnv,
  });
  const lockfileHash = sha256(await readFile(join(root, 'pnpm-lock.yaml')));
  const inputHash = buildInputHash(
    {
      ...env,
      canonicalConfigHash: sha256(await readFile(join(root, 'apps/worker/wrangler.toml'))),
    },
    target,
  );
  const buildFiles = await treeHashes(directory);
  const fingerprint = sha256({ sourceSha, lockfileHash, inputHash, files: buildFiles });
  deployConfig.vars.UPTIMER_RELEASE_FINGERPRINT = fingerprint;
  await writeJson(join(directory, 'worker/wrangler.json'), deployConfig);
  const manifest = {
    format: 1,
    sourceSha,
    lockfileHash,
    inputHash,
    fingerprint,
    storageContract: 'buckets-pending-scope-v1',
    files: await treeHashes(directory),
  };
  await writeJson(join(directory, 'manifest.json'), manifest);
  const plan = {
    format: 1,
    createdAt: new Date().toISOString(),
    repository: target.repository,
    sourceSha,
    target,
    fingerprint,
    manifestHash: sha256(manifest),
    migrations,
    before: publicState(live),
    ...(legacyUpgrade ? { legacyUpgrade: true } : {}),
    warnings: [],
    checks: { builtBeforeMutation: true, remoteMutations: 0 },
  };
  plan.blockers = [];
  plan.steps = deploymentSteps(plan, plan.before);
  if (live.worker?.maintenance || (live.legacy && live.legacy.phase !== 'open'))
    plan.blockers.push('An approved legacy upgrade is in progress. Resume its original Apply.');
  if (legacyUpgrade)
    plan.warnings.push('Apply will pause probes and admin writes during the one-time D1 upgrade.');
  if (!legacyUpgrade && requiresMigrationMaintenance(live, plan.steps))
    plan.blockers.push(
      'Existing database has pending migrations: a separately rehearsed maintenance/forward-recovery procedure is required. This workflow will not apply them.',
    );
  if (live.worker && live.worker.profile !== target.profile)
    plan.blockers.push(
      'Runtime profile changes require a separate Cron propagation and overlap review. Keep the deployed profile for this release.',
    );
  plan.hash = planHash(plan);
  await writeJson(join(directory, 'plan.json'), plan);
  return plan;
}
export async function verifyReviewedPackage(directory, plan, manifest, env) {
  const { assertPlan } = await import('./release-contract.mjs');
  const { verifyPackage } = await import('./release-config.mjs');
  assertPlan(plan, env.RELEASE_PLAN_SHA);
  if (plan.sourceSha !== env.GITHUB_SHA)
    throw Error('Apply must use the same frozen source revision as the reviewed package');
  assertTarget(plan.target, env.GITHUB_REPOSITORY);
  if (
    plan.manifestHash !== sha256(manifest) ||
    manifest.sourceSha !== plan.sourceSha ||
    manifest.fingerprint !== plan.fingerprint
  )
    throw Error('Package manifest differs from the reviewed plan');
  const expectedTarget = targetInput(
    {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID || plan.target.accountId,
      UPTIMER_D1_ID: env.UPTIMER_D1_ID || plan.target.databaseId,
      UPTIMER_D1_NAME:
        env.UPTIMER_D1_NAME || (plan.target.operation === 'upgrade' ? plan.target.database : ''),
    },
    new URL(plan.target.workerUrl).hostname.split('.').slice(1, -2).join('.'),
  );
  if (sha256(expectedTarget) !== sha256(plan.target))
    throw Error('Deployment variables changed since planning; generate a new plan');
  if (env.RELEASE_ROOT) {
    const currentInput = buildInputHash(
      {
        ...env,
        canonicalConfigHash: sha256(
          await readFile(join(env.RELEASE_ROOT, 'apps/worker/wrangler.toml')),
        ),
      },
      expectedTarget,
    );
    if (currentInput !== manifest.inputHash) throw Error('Build inputs changed since planning');
    if (sha256(await readFile(join(env.RELEASE_ROOT, 'pnpm-lock.yaml'))) !== manifest.lockfileHash)
      throw Error('Lockfile differs from reviewed package');
  }
  await verifyPackage(directory, manifest);
}
export const readJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
