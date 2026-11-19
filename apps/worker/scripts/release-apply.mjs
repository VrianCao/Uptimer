import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  deploymentSteps,
  migrationState,
  requiresMigrationMaintenance,
} from './release-contract.mjs';
import {
  command,
  workerDeployArgs,
  publicState,
  verifyReviewedPackage,
} from './release-package.mjs';
import { writeJson } from './release-config.mjs';
import {
  captureLegacySnapshots,
  eligibleLegacyUpgrade,
  initialFence,
  legacyCapabilityProbe,
  legacyMigrationBatch,
  prepareLegacySnapshots,
  releaseConfigForLegacy,
  resumeWriter,
} from './release-legacy.mjs';
export async function applyRelease({
  root,
  directory,
  plan,
  manifest,
  cloud,
  env,
  run = command,
  request = fetch,
}) {
  await verifyReviewedPackage(directory, plan, manifest, env);
  if (cloud.target.accountId !== plan.target.accountId)
    throw Error('Cloudflare client does not use the reviewed account');
  env = { ...env, CLOUDFLARE_ACCOUNT_ID: plan.target.accountId };
  if (plan.legacyUpgrade === true) cloud.reviewedLegacyPlan = plan;
  let live = await cloud.inspect(),
    steps = deploymentSteps(plan, publicState(live));
  const checkpoint = {
    format: 1,
    planHash: plan.hash,
    sourceSha: plan.sourceSha,
    startedAt: new Date().toISOString(),
    completed: [],
    before: publicState(live),
  };
  const save = async (stage) => {
    if (stage) checkpoint.completed.push(stage);
    await writeJson(join(directory, 'checkpoint.json'), checkpoint);
  };
  const legacy = plan.legacyUpgrade === true;
  if (
    plan.blockers?.length ||
    (!legacy && requiresMigrationMaintenance(live, steps)) ||
    steps.profileChange
  )
    throw Error(
      'Blocked before any remote mutation: migration/profile maintenance review required',
    );
  if (!live.worker?.secretNames.includes('ADMIN_TOKEN') && !env.UPTIMER_ADMIN_TOKEN)
    throw Error('Missing initial admin secret; no mutations were made');
  if (
    legacy &&
    !eligibleLegacyUpgrade(plan, migrationState(plan.migrations, plan.before.appliedMigrations))
  )
    throw Error('This plan does not authorize the legacy upgrade procedure');
  if (!legacy && (live.worker?.maintenance || (live.legacy && live.legacy.phase !== 'open')))
    throw Error('Resume the original legacy upgrade plan');
  if (!legacy && live.legacy?.plan_hash !== plan.before.legacy?.plan_hash)
    throw Error('The reviewed D1 write protection changed');
  const work = await mkdtemp(join(tmpdir(), 'uptimer-release-apply-'));
  const cfg = JSON.parse(await readFile(join(directory, 'worker/wrangler.json'), 'utf8'));
  cfg.main = join(directory, 'worker', cfg.main);
  cfg.d1_databases[0].migrations_dir = join(directory, 'migrations');
  if (cfg.assets) cfg.assets.directory = join(directory, 'web');
  const config = join(work, 'wrangler.json');
  try {
    if (!steps.worker) assertRuntimeConfiguration(live.worker, cfg);
    if (steps.createDatabase) {
      const db = await cloud.request('/d1/database', {
        method: 'POST',
        body: { name: plan.target.database },
      });
      cloud.target.databaseId = z
        .string()
        .uuid()
        .parse(db.uuid ?? db.id);
      checkpoint.createdDatabaseId = cloud.target.databaseId;
      await save('database-created');
      live = await cloud.inspect();
      if (live.databaseId !== checkpoint.createdDatabaseId || !live.emptyProjectDatabase)
        throw Error('Created D1 database identity or empty state could not be verified');
    }
    cfg.d1_databases[0].database_id = cloud.target.databaseId;
    await writeJson(config, cfg);
    if (legacy) {
      live = await prepareLegacyDatabase({
        cloud,
        plan,
        live,
        config,
        cfg,
        directory,
        root,
        env,
        run,
        save,
        request,
      });
      steps = deploymentSteps(plan, publicState(live));
      if (steps.migrate) throw Error('The guarded upgrade did not finish every migration');
    }
    if (steps.migrate) {
      await run(
        [
          '--filter',
          '@uptimer/worker',
          'exec',
          'wrangler',
          'd1',
          'migrations',
          'apply',
          plan.target.database,
          '--remote',
          '--config',
          config,
        ],
        { cwd: root, env, timeout: 900000 },
      );
      await save('migrations-applied');
    }
    live = await cloud.inspect();
    const afterMigrations = migrationState(plan.migrations, live.appliedMigrations);
    if (afterMigrations.pending.length)
      throw Error('Pending migrations remain; not deploying the Worker');
    const currentSteps = deploymentSteps(plan, publicState(live), checkpoint.createdDatabaseId);
    // The reviewed package is deployed directly; there is no source rebuild here.
    if (currentSteps.worker) {
      await run(workerDeployArgs(config), { cwd: root, env });
      await save('worker-deployed');
    }
    live = await cloud.inspect();
    const verifyWorker = () => {
      const stages = deploymentSteps(plan, publicState(live), checkpoint.createdDatabaseId);
      if (stages.worker) throw Error('Active Worker does not match the reviewed candidate');
      assertRuntimeConfiguration(live.worker, cfg);
      return stages;
    };
    let workerStages = verifyWorker();
    if (workerStages.initializeSecret) {
      if (!env.UPTIMER_ADMIN_TOKEN) throw Error('Missing initial admin secret');
      await run(
        [
          '--filter',
          '@uptimer/worker',
          'exec',
          'wrangler',
          'secret',
          'put',
          'ADMIN_TOKEN',
          '--name',
          plan.target.worker,
          '--config',
          config,
        ],
        { cwd: root, env, input: env.UPTIMER_ADMIN_TOKEN },
      );
      await save('admin-secret-initialized');
      live = await cloud.inspect();
      workerStages = verifyWorker();
    }
    if (
      !plan.before.worker?.secretNames.every((name) => live.worker.secretNames.includes(name)) &&
      plan.before.worker
    )
      throw Error('An existing Worker secret was lost');
    if (legacy && live.legacy?.phase === 'maintenance') {
      await cloud.writeLegacyBatch(resumeWriter(plan.hash));
      live = await cloud.inspect();
      if (live.legacy?.phase !== 'open' || live.legacy.plan_hash !== plan.hash)
        throw Error('Database writer continuity could not be verified');
      workerStages = verifyWorker();
      await save('legacy-upgrade-open');
    }
    if (workerStages.pages) {
      if (!live.pages) {
        const branch = env.DEFAULT_BRANCH || 'master';
        const project = await cloud.request('/pages/projects', {
          method: 'POST',
          body: { name: plan.target.pages, production_branch: branch },
        });
        checkpoint.createdPagesProjectId = project.id;
        await save('pages-project-created');
        live = await cloud.inspect();
        if (
          !project.id ||
          live.pages?.projectId !== project.id ||
          live.pages.productionBranch !== branch
        )
          throw Error('Created Pages project identity could not be verified');
      }
      // Backend origins are not credentials. Preserve every unrelated env value
      // via Wrangler's single-key secret operation; never replace an env map.
      await run(
        [
          '--filter',
          '@uptimer/worker',
          'exec',
          'wrangler',
          'pages',
          'secret',
          'put',
          'UPTIMER_API_ORIGIN',
          '--project-name',
          plan.target.pages,
        ],
        { cwd: root, env, input: plan.target.apiOrigin },
      );
      const pinned =
        live.pages.project.deployment_configs?.production?.env_vars?.UPTIMER_API_SENSITIVE_ORIGIN;
      if (plan.target.apiBase.startsWith('/') && !pinned)
        await run(
          [
            '--filter',
            '@uptimer/worker',
            'exec',
            'wrangler',
            'pages',
            'secret',
            'put',
            'UPTIMER_API_SENSITIVE_ORIGIN',
            '--project-name',
            plan.target.pages,
          ],
          { cwd: root, env, input: plan.target.apiOrigin },
        );
      await run(
        [
          '--filter',
          '@uptimer/worker',
          'exec',
          'wrangler',
          'pages',
          'deploy',
          join(directory, 'web'),
          '--project-name',
          plan.target.pages,
          '--branch',
          live.pages.productionBranch,
          '--commit-hash',
          plan.sourceSha,
          '--commit-message',
          'uptimer-release:' + plan.fingerprint,
          '--commit-dirty=true',
        ],
        { cwd: root, env },
      );
      await save('pages-deployed');
    }
    const after = await cloud.inspect();
    const remaining = deploymentSteps(plan, publicState(after), checkpoint.createdDatabaseId);
    if (remaining.worker || remaining.pages || remaining.migrate || remaining.initializeSecret)
      throw Error('Deployment verification found unfinished stages');
    checkpoint.after = publicState(after);
    checkpoint.completedAt = new Date().toISOString();
    checkpoint.idempotentNoop = !checkpoint.completed.length;
    await save('identity-verified');
    return checkpoint;
  } catch (error) {
    checkpoint.error = { message: String(error.message).slice(0, 500) };
    // Preserve the database and all completed deployments for explicit inspection/resume.
    await save();
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function prepareLegacyDatabase({
  cloud,
  plan,
  live,
  config,
  cfg,
  directory,
  root,
  env,
  run,
  save,
  request,
}) {
  const pending = migrationState(plan.migrations, live.appliedMigrations).pending;
  if (live.legacy && live.legacy.plan_hash !== plan.hash)
    throw Error('A different plan owns the database maintenance window');
  if (!pending.length) {
    if (!live.legacy) throw Error('Legacy migrations advanced outside the reviewed upgrade');
    return live;
  }
  if (
    live.legacy?.phase === 'open' ||
    (live.legacy?.phase === 'maintenance' && !live.worker?.maintenance)
  )
    throw Error('D1 is still migrating and the reviewed maintenance Worker is no longer active');
  if (
    live.legacy?.phase !== 'maintenance' &&
    (!live.legacyCatalog ||
      migrationState(plan.migrations, live.appliedMigrations).applied.length !== 14)
  )
    throw Error('Legacy migrations advanced outside the reviewed upgrade');

  const maintenanceConfig = releaseConfigForLegacy(cfg, { maintenance: true });
  if (!live.legacy) {
    const result = await cloud.writeLegacyBatch(legacyCapabilityProbe());
    const unmarked = result[0];
    const marked = result.at(-1);
    if (unmarked.results[0]?.enabled !== 0 || marked.results[0]?.enabled !== 1)
      throw Error('Cloudflare D1 could not confirm transaction-scoped write protection');
    const snapshots = await captureLegacySnapshots(plan.target.workerUrl, request);
    const bookmark = await cloud.legacyRecoveryBookmark();
    const previousVersion = live.worker.versionId;
    live = await cloud.inspect();
    if (live.worker?.versionId !== previousVersion || live.legacy)
      throw Error('Worker or D1 changed before capturing the public snapshot');
    await cloud.writeLegacyBatch(prepareLegacySnapshots(plan.hash, bookmark, snapshots));
    live = await cloud.inspect();
    if (live.legacy?.plan_hash !== plan.hash || live.legacy.phase !== 'prepared')
      throw Error('The public snapshot was not captured for this plan');
    await save('legacy-snapshot-captured');
  }
  if (!live.worker?.maintenance) {
    const path = join(dirname(config), 'maintenance.json');
    await writeJson(path, maintenanceConfig);
    await run(workerDeployArgs(path), { cwd: root, env });
    live = await cloud.inspect();
    await save('legacy-maintenance-worker');
  }
  function verifyMaintenance(state) {
    if (
      !state.worker?.maintenance ||
      state.worker.fingerprint !== plan.fingerprint ||
      state.worker.sourceSha !== plan.sourceSha ||
      !plan.before.worker.secretNames.every((name) => state.worker.secretNames.includes(name))
    )
      throw Error('Active Worker is not the reviewed maintenance version');
    assertRuntimeConfiguration(state.worker, maintenanceConfig);
    deploymentSteps(plan, publicState(state));
  }
  verifyMaintenance(live);
  const maintenanceVersion = live.worker.versionId;
  if (live.legacy?.phase === 'prepared') {
    await waitForMaintenance(plan.target.workerUrl, request);
    live = await cloud.inspect();
    verifyMaintenance(live);
    if (
      live.worker.versionId !== maintenanceVersion ||
      live.legacy?.phase !== 'prepared' ||
      live.legacy.plan_hash !== plan.hash ||
      !live.legacyCatalog ||
      migrationState(plan.migrations, live.appliedMigrations).applied.length !== 14
    )
      throw Error('Worker or D1 changed before the write fence was recorded');
    await cloud.writeLegacyBatch(initialFence(plan.hash));
    live = await cloud.inspect();
    await save('legacy-d1-fenced');
  }
  for (const migration of pending) {
    verifyMaintenance(live);
    if (
      live.legacy?.phase !== 'maintenance' ||
      live.legacy.plan_hash !== plan.hash ||
      live.worker.versionId !== maintenanceVersion ||
      migrationState(plan.migrations, live.appliedMigrations).pending[0] !== migration
    )
      throw Error('Legacy upgrade state changed during migration');
    await cloud.writeLegacyBatch(
      await legacyMigrationBatch(directory, migration, plan.hash, live.appliedMigrations.length),
    );
    live = await cloud.inspect();
    if (!live.appliedMigrations.includes(migration)) throw Error('Migration was not recorded');
    await save(migration);
  }
  verifyMaintenance(live);
  if (live.worker.versionId !== maintenanceVersion || live.legacy?.plan_hash !== plan.hash)
    throw Error('Legacy maintenance ownership changed');
  return live;
}

async function waitForMaintenance(workerUrl, request) {
  const endpoint = new URL('/api/v1/public/homepage', workerUrl);
  endpoint.searchParams.set('uptimer', 'maintenance');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await request(endpoint, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    await response?.body?.cancel();
    if (response?.headers.get('X-Uptimer-Maintenance') === 'upgrade' && response.status === 200)
      return;
    await wait(3000);
  }
  throw Error('Maintenance Worker did not respond at its reviewed public origin');
}

export function assertRuntimeConfiguration(worker, cfg) {
  const c = worker?.configuration;
  if (!c) throw Error('Worker configuration metadata missing');
  const expected = cfg.vars ?? {};
  if (
    Object.keys(c.vars).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => c.vars[k] !== String(v)) ||
    c.selfService !== cfg.name ||
    c.coordinatorBound !== (expected.UPTIMER_RUNTIME_PROFILE === 'free') ||
    c.assetsBound !== !!cfg.assets ||
    (cfg.limits?.cpu_ms !== undefined && c.cpuMs !== cfg.limits.cpu_ms) ||
    JSON.stringify([...c.crons].sort()) !== JSON.stringify([...cfg.triggers.crons].sort())
  )
    throw Error(
      'Live Worker configuration differs from the reviewed package; stop before continuing',
    );
}
