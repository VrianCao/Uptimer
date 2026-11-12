import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentSteps, migrationState } from './release-contract.mjs';
import {
  command,
  workerDeployArgs,
  publicState,
  verifyReviewedPackage,
} from './release-package.mjs';
import { writeJson } from './release-config.mjs';
export async function applyRelease({ root, directory, plan, manifest, cloud, env, run = command }) {
  await verifyReviewedPackage(directory, plan, manifest, env);
  if (env.CLOUDFLARE_ACCOUNT_ID !== plan.target.accountId)
    throw Error('Reviewed account differs from this run');
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
  if (plan.blockers?.length || (live.worker && steps.migrate) || steps.profileChange)
    throw Error(
      'Blocked before any remote mutation: migration/profile maintenance review required',
    );
  if (!live.worker?.secretNames.includes('ADMIN_TOKEN') && !env.UPTIMER_ADMIN_TOKEN)
    throw Error('Missing initial admin secret; no mutations were made');
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
      cloud.target.databaseId = db.uuid ?? db.id;
      checkpoint.createdDatabaseId = cloud.target.databaseId;
      await save('database-created');
    }
    cfg.d1_databases[0].database_id = cloud.target.databaseId;
    await writeJson(config, cfg);
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
    // The reviewed package is deployed directly; there is no source rebuild here.
    if (steps.worker) {
      await run(workerDeployArgs(config), { cwd: root, env });
      await save('worker-deployed');
    }
    live = await cloud.inspect();
    if (!live.worker?.secretNames.includes('ADMIN_TOKEN')) {
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
    }
    if (
      live.worker?.fingerprint !== plan.fingerprint ||
      live.worker.sourceSha !== plan.sourceSha ||
      live.worker.profile !== plan.target.profile ||
      live.worker.databaseId !== cloud.target.databaseId
    )
      throw Error('Active Worker does not match the reviewed candidate');
    assertRuntimeConfiguration(live.worker, cfg);
    if (
      !plan.before.worker?.secretNames.every((name) => live.worker.secretNames.includes(name)) &&
      plan.before.worker
    )
      throw Error('An existing Worker secret was lost');
    if (steps.pages) {
      if (!live.pages) {
        await cloud.request('/pages/projects', {
          method: 'POST',
          body: { name: plan.target.pages, production_branch: env.DEFAULT_BRANCH || 'master' },
        });
        await save('pages-project-created');
        live = await cloud.inspect();
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
    const remaining = deploymentSteps(plan, publicState(after));
    if (remaining.worker || remaining.pages || remaining.migrate || remaining.initializeSecret)
      throw Error('Deployment verification found unfinished stages');
    checkpoint.after = publicState(after);
    checkpoint.completedAt = new Date().toISOString();
    checkpoint.idempotentNoop =
      !steps.worker && !steps.pages && !steps.migrate && !steps.initializeSecret;
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
