import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { preparePackage, verifyReviewedPackage, readJson } from './release-package.mjs';
import { deploymentConfig, targetInput } from './release-config.mjs';
import { applyRelease, assertRuntimeConfiguration } from './release-apply.mjs';
import { ReleaseCloud } from './release-cloud.mjs';
import { verifyRelease } from './release.mjs';
const root = resolve(import.meta.dirname, '../../..');
const baseEnv = {
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_REPOSITORY: 'alice/uptimer',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  UPTIMER_D1_ID: '12345678-1234-4123-8123-123456789abc',
  UPTIMER_ADMIN_TOKEN: 'test-only-admin-value',
  UPTIMER_WORKER_URL: 'https://uptimer.alice.workers.dev',
};
async function fixture(t, override = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'uptimer-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...baseEnv, ...override },
    target = targetInput(env, 'alice');
  const names = (await import('./release-config.mjs')).migrationFiles;
  let live = {
    databaseId: target.databaseId,
    emptyProjectDatabase: false,
    appliedMigrations: (await names(root)).map((m) => m.name),
    worker: {
      versionId: 'old',
      sourceSha: 'a'.repeat(40),
      fingerprint: null,
      profile: 'free',
      databaseId: target.databaseId,
      hosting: 'pages',
      secretNames: ['ADMIN_TOKEN', 'WEBHOOK_KEY'],
    },
    pages: {
      deploymentId: 'old-pages',
      productionBranch: 'master',
      project: {
        deployment_configs: {
          production: { env_vars: { UPTIMER_API_SENSITIVE_ORIGIN: { type: 'secret_text' } } },
        },
      },
    },
    ...options.live,
  };
  const cloud = {
    target,
    inspect: async () => structuredClone(live),
    request: async () => {
      throw Error('Unexpected mutation');
    },
  };
  const built = [];
  const build = async (args) => {
    built.push(args);
    if (args.includes('vite')) {
      await writeFile(
        join(directory, 'web/index.html'),
        '<div id="root"></div><script src="/entry.js"></script>',
      );
      await writeFile(join(directory, 'web/entry.js'), 'const compiled=true;');
    } else if (args.includes('--outdir'))
      await writeFile(
        join(directory, 'worker/worker-entry.js'),
        'export default {fetch(){return new Response("ok")}}',
      );
  };
  const plan = await preparePackage({ root, directory, cloud, env, run: build });
  env.RELEASE_PLAN_SHA = plan.hash;
  const manifest = await readJson(join(directory, 'manifest.json'));
  const cfg = await readJson(join(directory, 'worker/wrangler.json'));
  const configuration = {
    vars: Object.fromEntries(Object.entries(cfg.vars).map(([k, v]) => [k, String(v)])),
    selfService: cfg.name,
    coordinatorBound: target.profile === 'free',
    assetsBound: !!cfg.assets,
    cpuMs: cfg.limits?.cpu_ms,
    crons: cfg.triggers.crons,
  };
  const inspect = cloud.inspect;
  cloud.inspect = async () => {
    const state = await inspect();
    if (state.worker) state.worker.configuration = configuration;
    return state;
  };
  return {
    directory,
    env,
    cloud,
    plan,
    manifest,
    built,
    configuration,
    cfg,
    getLive: () => live,
    setLive: (s) => {
      live = s;
    },
  };
}
test('all four configurations preserve migration/class history and scope their bindings', async () => {
  for (const profile of ['free', 'paid'])
    for (const hosting of ['pages', 'single_worker']) {
      const target = targetInput(
        { ...baseEnv, RELEASE_HOSTING: hosting, RELEASE_PROFILE: profile },
        'alice',
      );
      const cfg = await deploymentConfig(root, target, baseEnv.GITHUB_SHA, target.databaseId);
      assert.equal(!!cfg.assets, hosting === 'single_worker');
      assert.equal(
        cfg.durable_objects?.bindings?.some((b) => b.name === 'COORDINATOR') ?? false,
        profile === 'free',
      );
      assert.equal(cfg.triggers.crons.length, profile === 'paid' ? 6 : 1);
      assert.equal(cfg.limits?.cpu_ms, profile === 'paid' ? 30000 : undefined);
      assert.ok(cfg.migrations.some((m) => m.new_sqlite_classes?.includes('SiteCoordinator')));
      assert.equal(cfg.services[0].service, target.worker);
      assert.equal(cfg.d1_databases[0].database_id, target.databaseId);
    }
});
test('package includes both builds before mutation, hashes all files and rejects tampering', async (t) => {
  const f = await fixture(t);
  assert.equal(f.built.length, 3);
  await verifyReviewedPackage(f.directory, f.plan, f.manifest, f.env);
  assert.equal(JSON.stringify(f.plan).includes(baseEnv.UPTIMER_ADMIN_TOKEN), false);
  await writeFile(join(f.directory, 'web/entry.js'), 'tampered');
  await assert.rejects(
    verifyReviewedPackage(f.directory, f.plan, f.manifest, f.env),
    /hash mismatch/,
  );
});
test('source, target and build-input drift reject apply before effects', async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { GITHUB_SHA: 'd'.repeat(40) },
    { UPTIMER_WORKER_NAME: 'another' },
    { RELEASE_PROFILE: 'paid' },
    { VITE_ADMIN_PATH: '/changed', RELEASE_ROOT: root },
  ])
    await assert.rejects(
      verifyReviewedPackage(f.directory, f.plan, f.manifest, { ...f.env, ...changed }),
    );
  await writeFile(join(f.directory, 'unreviewed.txt'), 'extra');
  await assert.rejects(
    verifyReviewedPackage(f.directory, f.plan, f.manifest, f.env),
    /Unmanifested/,
  );
});
test('API planner cannot mutate or reach an unapproved resource', async () => {
  const cloud = new ReleaseCloud(targetInput(baseEnv, 'alice'), 'test-token');
  await assert.rejects(
    cloud.request('/d1/database', { method: 'POST', body: { name: 'uptimer' } }),
    /Plan cannot mutate/,
  );
  await assert.rejects(cloud.request('/workers/scripts/other/settings'), /scope guard/);
  await assert.rejects(cloud.sql('DELETE FROM monitors'), /Read-only/);
  await assert.rejects(
    cloud.request('/d1/database/' + baseEnv.UPTIMER_D1_ID + '/query', {
      method: 'POST',
      body: { sql: 'DROP TABLE monitors' },
    }),
    /mutation guard/,
  );
});
test('existing pending migrations and profile switches are blocked before any write', async (t) => {
  const f = await fixture(t, {}, { live: { appliedMigrations: [] } });
  assert.ok(f.plan.blockers.length);
  let calls = 0;
  await assert.rejects(
    applyRelease({
      ...f,
      root,
      run: async () => {
        calls++;
      },
    }),
    /Blocked before/,
  );
  assert.equal(calls, 0);
});
test('Pages failure resumes without redeploying Worker; successful repeat has zero commands', async (t) => {
  const f = await fixture(t);
  const calls = [];
  let failPages = true;
  const run = async (args) => {
    calls.push(args.join(' '));
    const live = f.getLive();
    if (args.includes('deploy') && !args.includes('pages')) {
      live.worker = {
        ...live.worker,
        versionId: 'new-worker',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
    } else if (args.includes('pages') && args.includes('deploy')) {
      if (failPages) throw Error('Synthetic Pages failure');
      live.pages = {
        ...live.pages,
        deploymentId: 'new-pages',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
    }
  };
  await assert.rejects(applyRelease({ ...f, root, run }), /Synthetic Pages/);
  failPages = false;
  const resumed = await applyRelease({ ...f, root, run });
  assert.equal(resumed.after.worker.versionId, 'new-worker');
  assert.equal(calls.filter((s) => s.includes('--no-bundle')).length, 1);
  assert.equal(
    calls.some((s) => s.includes('secret put ADMIN_TOKEN')),
    false,
  );
  calls.length = 0;
  const repeated = await applyRelease({ ...f, root, run });
  assert.equal(repeated.idempotentNoop, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(repeated.after.worker.secretNames, ['ADMIN_TOKEN', 'WEBHOOK_KEY']);
});
test('initial secret version is captured after secret initialization; unrelated secrets preserved', async (t) => {
  const f = await fixture(
    t,
    {},
    {
      live: {
        worker: {
          versionId: 'old',
          profile: 'free',
          databaseId: baseEnv.UPTIMER_D1_ID,
          hosting: 'pages',
          secretNames: ['WEBHOOK_KEY'],
        },
      },
    },
  );
  const run = async (args, options) => {
    const live = f.getLive();
    if (args.includes('--no-bundle'))
      live.worker = {
        ...live.worker,
        versionId: 'bundle-version',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
    if (args.includes('ADMIN_TOKEN')) {
      assert.equal(options.input, baseEnv.UPTIMER_ADMIN_TOKEN);
      live.worker.versionId = 'secret-version';
      live.worker.secretNames.push('ADMIN_TOKEN');
    }
    if (args.includes('pages') && args.includes('deploy'))
      live.pages = {
        ...live.pages,
        deploymentId: 'new-pages',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
  };
  const checkpoint = await applyRelease({ ...f, root, run });
  assert.equal(checkpoint.after.worker.versionId, 'secret-version');
  assert.ok(checkpoint.after.worker.secretNames.includes('WEBHOOK_KEY'));
});
test('smoke rejects HTTP-200 stale data and proves two advancing publications without admin writes', async () => {
  const target = targetInput(baseEnv, 'alice');
  let clock = 1700000000000,
    stale = false;
  const requests = [];
  const request = async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/'))
      return new Response('<div id="root"></div><script src="/entry.js"></script>');
    if (url.endsWith('.js')) return new Response('entry');
    if (url.includes('/internal/')) return new Response('', { status: 404 });
    if (url.endsWith('/admin/monitors'))
      return new Response('{}', { status: options.headers.Authorization ? 200 : 401 });
    return Response.json({ generated_at: Math.floor(clock / 60000) * 60 - (stale ? 180 : 0) });
  };
  const options = {
    request,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  };
  const result = await verifyRelease({ target }, 'test-admin', options);
  assert.equal(result.advancingPublications, 2);
  assert.equal(requests.filter(([, o]) => o.headers.Authorization).length, 1);
  assert.ok(requests.every(([, o]) => !o.method));
  stale = true;
  await assert.rejects(verifyRelease({ target }, 'test-admin', options), /stale/);
});
test('symlink artifact entries are refused', async (t) => {
  const f = await fixture(t);
  const { symlink } = await import('node:fs/promises');
  await mkdir(join(f.directory, 'extra'));
  await symlink(join(f.directory, 'web/entry.js'), join(f.directory, 'extra/link'));
  await assert.rejects(verifyReviewedPackage(f.directory, f.plan, f.manifest, f.env), /symlinks/);
  assert.ok(await readFile(join(f.directory, 'manifest.json')));
});

test('fresh install resumes partial migrations and repeat skips all cloud mutations', async (t) => {
  const f = await fixture(
    t,
    { RELEASE_OPERATION: 'install', UPTIMER_D1_ID: '' },
    {
      live: {
        databaseId: null,
        appliedMigrations: [],
        worker: null,
        pages: null,
        emptyProjectDatabase: true,
      },
    },
  );
  const allocated = baseEnv.UPTIMER_D1_ID;
  let created = 0,
    failOnce = true;
  f.cloud.request = async (path) => {
    const live = f.getLive();
    if (path === '/d1/database') {
      created++;
      live.databaseId = allocated;
      return { uuid: allocated };
    }
    if (path === '/pages/projects') {
      live.pages = { productionBranch: 'master', deploymentId: null, project: {} };
      return {};
    }
    throw Error('Unexpected request');
  };
  const run = async (args) => {
    const live = f.getLive();
    if (args.includes('migrations')) {
      if (failOnce) {
        failOnce = false;
        live.appliedMigrations = f.plan.migrations.slice(0, 14).map((m) => m.name);
        throw Error('Interrupted install');
      }
      live.appliedMigrations = f.plan.migrations.map((m) => m.name);
    }
    if (args.includes('--no-bundle'))
      live.worker = {
        versionId: 'install-bundle',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
        profile: 'free',
        databaseId: allocated,
        hosting: 'pages',
        secretNames: [],
      };
    if (args.includes('ADMIN_TOKEN')) {
      live.worker.secretNames = ['ADMIN_TOKEN'];
      live.worker.versionId = 'install-secret';
    }
    if (args.includes('pages') && args.includes('deploy'))
      live.pages = {
        ...live.pages,
        deploymentId: 'install-pages',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
  };
  await assert.rejects(applyRelease({ ...f, root, run }), /Interrupted install/);
  await applyRelease({ ...f, root, run });
  assert.equal(created, 1);
  f.getLive().emptyProjectDatabase = false;
  const final = await applyRelease({
    ...f,
    root,
    run: async () => {
      throw Error('Repeat must be a no-op');
    },
  });
  assert.equal(final.idempotentNoop, true);
  assert.equal(final.after.worker.versionId, 'install-secret');
});
test('profile changes and failed frontend builds never start remote mutations', async (t) => {
  const f = await fixture(t, { RELEASE_PROFILE: 'paid' });
  assert.ok(f.plan.blockers.some((b) => b.includes('Runtime profile')));
  await assert.rejects(
    applyRelease({
      ...f,
      root,
      run: async () => {
        throw Error('Unexpected command');
      },
    }),
    /Blocked before/,
  );
  const directory = await mkdtemp(join(tmpdir(), 'uptimer-release-failed-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    preparePackage({
      root,
      directory,
      cloud: f.cloud,
      env: f.env,
      run: async () => {
        throw Error('Build failed');
      },
    }),
    /Build failed/,
  );
});
test('plan provenance rejects other repositories, old revisions and failed runs', async () => {
  const { checkProvenance } = await import('./release-provenance.mjs');
  const env = {
    ...baseEnv,
    RELEASE_ACTION: 'apply',
    RELEASE_OPERATION: 'upgrade',
    RELEASE_PLAN_SHA: 'c'.repeat(64),
    RELEASE_PLAN_RUN: '123',
    GH_TOKEN: 'test',
  };
  const run = {
    repository: { full_name: env.GITHUB_REPOSITORY },
    head_repository: { full_name: env.GITHUB_REPOSITORY },
    head_sha: env.GITHUB_SHA,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/deploy.yml',
  };
  await checkProvenance(env, async () => Response.json(run));
  for (const change of [
    { head_sha: 'd'.repeat(40) },
    { conclusion: 'failure' },
    { repository: { full_name: 'other/uptimer' } },
    { event: 'pull_request' },
  ])
    await assert.rejects(
      checkProvenance(env, async () => Response.json({ ...run, ...change })),
      /successful manual plan/,
    );
});

test('a copied fingerprint cannot conceal changed Worker vars, binding, CPU or Cron config', async (t) => {
  const f = await fixture(t);
  const worker = { configuration: f.configuration };
  assertRuntimeConfiguration(worker, f.cfg);
  for (const change of [
    { vars: { ...f.configuration.vars, UNREVIEWED: '1' } },
    { selfService: 'other' },
    { coordinatorBound: false },
    { assetsBound: true },
    { crons: [] },
  ])
    assert.throws(
      () => assertRuntimeConfiguration({ configuration: { ...f.configuration, ...change } }, f.cfg),
      /differs/,
    );
});

test('a fresh install plan never adopts an already existing database, even if empty', async (t) => {
  await assert.rejects(
    fixture(
      t,
      { RELEASE_OPERATION: 'install' },
      { live: { worker: null, pages: null, emptyProjectDatabase: true } },
    ),
    /unused resource names/,
  );
});

test('only initial install 503s wait for Cron propagation; existing outages fail immediately', async () => {
  const target = targetInput(
    { ...baseEnv, RELEASE_OPERATION: 'install', UPTIMER_D1_ID: '' },
    'alice',
  );
  let clock = 1700000000000;
  const start = clock;
  const request = async (url, options) => {
    if (url.endsWith('/'))
      return new Response('<div id="root"></div><script src="/entry.js"></script>');
    if (url.endsWith('.js')) return new Response('entry');
    if (url.includes('/internal/')) return new Response('', { status: 404 });
    if (url.endsWith('/admin/monitors'))
      return new Response('{}', { status: options.headers.Authorization ? 200 : 401 });
    if (clock - start < 30000) return new Response('', { status: 503 });
    return Response.json({ generated_at: Math.floor(clock / 60000) * 60 });
  };
  const options = {
    request,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  };
  const result = await verifyRelease({ target, before: { worker: null } }, 'test', options);
  assert.equal(result.initialWarmupMs, 30000);
  clock = start;
  await assert.rejects(
    verifyRelease({ target: { ...target, operation: 'upgrade' } }, 'test', options),
    /503/,
  );
  assert.equal(clock, start);
});
