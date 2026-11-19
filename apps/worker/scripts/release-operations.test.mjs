import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { preparePackage, verifyReviewedPackage, readJson } from './release-package.mjs';
import { deploymentConfig, migrationFiles, targetInput } from './release-config.mjs';
import { applyRelease, assertRuntimeConfiguration } from './release-apply.mjs';
import { ReleaseCloud, resolveAccountId } from './release-cloud.mjs';
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
      projectId: 'current-project',
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
    { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
    { UPTIMER_D1_ID: '87654321-4321-4321-8321-abcdef012345' },
    { UPTIMER_D1_NAME: 'another-db' },
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
test('default names match deployments created by the legacy workflow', () => {
  for (const [repo, expected] of [
    ['_Status.Page_', 'status-page'],
    ['._-', 'uptimer'],
  ]) {
    const target = targetInput({ ...baseEnv, GITHUB_REPOSITORY: `alice/${repo}` }, 'alice');
    assert.deepEqual([target.worker, target.pages, target.database], Array(3).fill(expected));
  }
});

test('a single visible Cloudflare account is inferred and explicit accounts skip discovery', async () => {
  const accountId = baseEnv.CLOUDFLARE_ACCOUNT_ID;
  const env = { CLOUDFLARE_API_TOKEN: 'fixture-token' };
  const noDiscovery = async () => assert.fail('Account discovery must not run');
  assert.equal(
    await resolveAccountId({ ...env, CLOUDFLARE_ACCOUNT_ID: accountId }, noDiscovery),
    accountId,
  );
  assert.equal(
    await resolveAccountId(env, async (url) => {
      assert.equal(new URL(url).pathname, '/client/v4/accounts');
      return Response.json({ success: true, result: [{ id: accountId }] });
    }),
    accountId,
  );
  for (const data of [
    { success: true, result: [] },
    { success: true, result: [{ id: accountId }, { id: 'b'.repeat(32) }] },
    { success: true, result: [{ id: accountId }], result_info: { total_count: 2 } },
  ])
    await assert.rejects(
      resolveAccountId(env, async () => Response.json(data)),
      /CLOUDFLARE_ACCOUNT_ID/,
    );
  await assert.rejects(
    resolveAccountId(env, async () => new Response(null, { status: 403 })),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
  await assert.rejects(
    resolveAccountId({ ...env, GITHUB_REPOSITORY: 'VrianCao/UptimerDev' }, noDiscovery),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
});

test('an upgrade resolves the active DB binding and only looks up that exact D1', async (t) => {
  const id = baseEnv.UPTIMER_D1_ID;
  const target = targetInput(
    { ...baseEnv, UPTIMER_D1_ID: '', RELEASE_HOSTING: 'single_worker' },
    'alice',
  );
  const worker = '/workers/scripts/uptimer';
  const version = '22222222-2222-4222-8222-222222222222';
  const cloud = new ReleaseCloud(target, 'test-token', { confirmDatabaseName: false });
  const routes = {
    [worker + '/settings']: {},
    [worker + '/deployments']: {
      deployments: [{ versions: [{ version_id: version, percentage: 100 }] }],
    },
    [worker + '/versions']: { items: [{ id: version }] },
    [worker + '/versions/' + version]: {
      resources: { bindings: [{ name: 'DB', type: 'd1', database_id: id }] },
    },
    [worker + '/schedules']: { schedules: [] },
    ['/d1/database/' + id]: { uuid: id, name: 'renamed-d1' },
    ['/d1/database/' + id + '/query']: [{ results: [], meta: { rows_written: 0 } }],
  };
  const request = async (path) => {
    assert.ok(Object.hasOwn(routes, path), 'Unexpected discovery request: ' + path);
    return routes[path];
  };
  t.mock.method(cloud, 'request', request);
  const inspected = await cloud.inspect();
  assert.equal(inspected.worker.databaseId, id);
  assert.equal(cloud.target.databaseId, id);
  assert.equal(cloud.target.database, 'renamed-d1');

  // A configured UUID remains an assertion and is checked before querying D1.
  const pinned = new ReleaseCloud(
    { ...target, databaseId: '87654321-4321-4321-8321-abcdef012345' },
    'test-token',
  );
  t.mock.method(pinned, 'request', request);
  await assert.rejects(pinned.inspect(), /Worker is attached to a different database/);
  const missing = new ReleaseCloud(target, 'test-token');
  t.mock.method(missing, 'request', async (path) => {
    assert.equal(path, worker + '/settings');
    return null;
  });
  await assert.rejects(missing.inspect(), /Worker not found.*UPTIMER_D1_ID/);
});

test('an interrupted install needs the verified D1 ID when there is no Worker', async (t) => {
  const id = baseEnv.UPTIMER_D1_ID;
  const target = targetInput({ ...baseEnv, RELEASE_HOSTING: 'single_worker' }, 'alice');
  const cloud = new ReleaseCloud(target, 'test-token', { confirmDatabaseName: false });
  t.mock.method(cloud, 'request', async (path) => {
    if (path === '/workers/scripts/uptimer/settings') return null;
    assert.equal(path, '/d1/database/' + id);
    return { uuid: id, name: 'custom-database' };
  });
  t.mock.method(cloud, 'sql', async () => ({ results: [] }));
  const inspected = await cloud.inspect();
  assert.equal(inspected.worker, null);
  assert.equal(inspected.databaseId, id);
  assert.equal(cloud.target.database, 'custom-database');
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
test('legacy Apply resumes after a committed migration loses its response; old writes stay fenced', async (t) => {
  const names = (await migrationFiles(root)).map((m) => m.name);
  const f = await fixture(
    t,
    {},
    { live: { appliedMigrations: names.slice(0, 14), legacyCatalog: true } },
  );
  assert.equal(f.plan.legacyUpgrade, true);
  assert.deepEqual(f.plan.blockers, []);
  const databasePath = join(
    f.directory,
    '..',
    'legacy-' + f.directory.split('/').at(-1) + '.sqlite3',
  );
  const db = new DatabaseSync(databasePath);
  const oldWorker = new DatabaseSync(databasePath);
  t.after(async () => {
    oldWorker.close();
    db.close();
    await rm(databasePath, { force: true });
  });
  db.exec(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  );
  for (const name of names.slice(0, 14)) {
    db.exec(await readFile(join(root, 'apps/worker/migrations', name), 'utf8'));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  }
  db.exec(
    "INSERT INTO monitors (id, name, type, target) VALUES (1,'Example','http','https://example.invalid')",
  );
  db.exec("INSERT INTO check_results (monitor_id, checked_at, status) VALUES (1, 100, 'up')");
  const oldIncident = oldWorker.prepare(
    "INSERT INTO incidents (title, status, impact, started_at) VALUES (?, 'investigating', 'minor', 100)",
  );
  oldIncident.run('Existing site-wide incident');
  const inspect = f.cloud.inspect;
  f.cloud.inspect = async () => {
    const state = await inspect();
    state.appliedMigrations = db
      .prepare('SELECT name FROM d1_migrations ORDER BY id')
      .all()
      .map((r) => r.name);
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='uptimer_legacy_upgrade'").get())
      state.legacy = db.prepare('SELECT plan_hash, phase FROM uptimer_legacy_upgrade').get();
    if (state.worker?.maintenance)
      state.worker.configuration = {
        ...state.worker.configuration,
        vars: { ...state.worker.configuration.vars, UPTIMER_MAINTENANCE: '1' },
      };
    return state;
  };
  const mutations = [];
  let loseResponse = true;
  f.cloud.legacyRecoveryBookmark = async () => 'synthetic-recovery-bookmark';
  f.cloud.writeLegacyBatch = async (batch) => {
    let results;
    db.exec('BEGIN');
    try {
      results = batch.map(({ sql, params = [] }) => ({
        success: true,
        results: db.prepare(sql).all(...params),
      }));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const migration = batch.find(({ sql }) => sql.startsWith('INSERT INTO d1_migrations'))
      ?.params[0];
    mutations.push(migration || 'control');
    if (migration === names[15] && loseResponse) {
      loseResponse = false;
      throw Error('Synthetic lost migration response');
    }
    return results;
  };
  const deployments = [];
  const run = async (args) => {
    assert.ok(!args.includes('migrations'), 'legacy files must use the guarded batch');
    const state = f.getLive();
    if (args.includes('--no-bundle')) {
      const config = await readJson(args.at(-1));
      const maintenance = config.vars.UPTIMER_MAINTENANCE === '1';
      deployments.push(maintenance ? 'maintenance' : 'running');
      state.worker = {
        ...state.worker,
        maintenance,
        versionId: 'version-' + deployments.length,
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
    } else if (args.includes('pages') && args.includes('deploy')) {
      state.pages = {
        ...state.pages,
        deploymentId: 'new-pages',
        sourceSha: f.plan.sourceSha,
        fingerprint: f.plan.fingerprint,
      };
    }
  };
  const request = async (url) => {
    if (url.searchParams.get('uptimer') === 'before-upgrade')
      return Response.json({ generated_at: 100, site_title: 'Fixture', site_description: '' });
    return new Response(null, { status: 200, headers: { 'X-Uptimer-Maintenance': 'upgrade' } });
  };
  await assert.rejects(
    applyRelease({ ...f, root, run, request }),
    /Synthetic lost migration response/,
  );
  assert.deepEqual(deployments, ['maintenance']);
  assert.throws(() => oldIncident.run('Delayed writer'), /obsolete writer/);
  assert.throws(() => oldWorker.exec('DELETE FROM check_results'), /obsolete writer/);
  const receipt = await applyRelease({ ...f, root, run, request });
  assert.equal(receipt.after.databaseId, f.plan.target.databaseId);
  assert.deepEqual(deployments, ['maintenance', 'running']);
  assert.deepEqual(
    mutations.filter((m) => m !== 'control'),
    names.slice(14),
  );
  assert.equal(
    db.prepare("SELECT scope FROM incidents WHERE title='Existing site-wide incident'").get().scope,
    'global',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM check_results').get().n, 1);
  assert.throws(() => oldIncident.run('Old writer after recovery'), /obsolete writer/);
  db.exec(
    "BEGIN; PRAGMA defer_foreign_keys=ON; INSERT INTO incidents (title,status,impact,started_at,scope) VALUES ('New writer','investigating','minor',100,'global'); COMMIT;",
  );
  assert.throws(() => oldIncident.run('Old writer after new batch'), /obsolete writer/);
  assert.equal(receipt.after.legacy.phase, 'open');
  const count = mutations.length;
  const repeated = await applyRelease({ ...f, root, run, request });
  assert.equal(repeated.idempotentNoop, true);
  assert.equal(mutations.length, count);
  assert.deepEqual(deployments, ['maintenance', 'running']);
});
test('Pages failure resumes without redeploying Worker; successful repeat has zero commands', async (t) => {
  const f = await fixture(t, { UPTIMER_D1_NAME: 'renamed-d1' });
  delete f.env.CLOUDFLARE_ACCOUNT_ID;
  delete f.env.UPTIMER_D1_ID;
  delete f.env.UPTIMER_D1_NAME;
  const calls = [];
  let failPages = true;
  const run = async (args, { env }) => {
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, f.plan.target.accountId);
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
test('legacy smoke waits out maintenance and stale snapshots before accepting new publications', async () => {
  const t = targetInput(baseEnv, 'alice');
  const start = 1_700_000_040_000;
  let time = start;
  const result = await verifyRelease(
    { target: t, legacyUpgrade: true, before: { worker: {} } },
    'test',
    {
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      request: async (url, req) => {
        const path = new URL(url).pathname;
        if (path === '/')
          return new Response('<div id="root"></div><script src="/entry.js"></script>');
        if (path === '/entry.js') return new Response('app');
        if (path.includes('/internal/')) return new Response('', { status: 404 });
        if (path.endsWith('/admin/monitors')) {
          if (time === start) return new Response('', { status: 503 });
          return new Response(null, { status: req.headers.Authorization ? 200 : 401 });
        }
        const now = time / 1000;
        return Response.json({
          generated_at: time - start < 30000 ? now - 600 : Math.floor(now / 60) * 60,
        });
      },
    },
  );
  assert.equal(result.advancingPublications, 2);
  assert.ok(result.initialWarmupMs >= 30000);
});
test('symlink artifact entries are refused', async (t) => {
  const f = await fixture(t);
  const { symlink } = await import('node:fs/promises');
  await mkdir(join(f.directory, 'extra'));
  await symlink(join(f.directory, 'web/entry.js'), join(f.directory, 'extra/link'));
  await assert.rejects(verifyReviewedPackage(f.directory, f.plan, f.manifest, f.env), /symlinks/);
  assert.ok(await readFile(join(f.directory, 'manifest.json')));
});

test('fresh install refuses a newly discovered D1 until a new plan pins its UUID', async (t) => {
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
  let created = 0;
  f.cloud.request = async (path) => {
    const live = f.getLive();
    if (path === '/d1/database') {
      created++;
      live.databaseId = allocated;
      return { uuid: allocated };
    }
    throw Error('Unexpected request');
  };
  await assert.rejects(
    applyRelease({
      ...f,
      root,
      run: async () => {
        f.getLive().appliedMigrations = f.plan.migrations.slice(0, 14).map((m) => m.name);
        throw Error('Interrupted install');
      },
    }),
    /Interrupted install/,
  );
  assert.equal((await readJson(join(f.directory, 'checkpoint.json'))).createdDatabaseId, allocated);
  f.cloud.target.databaseId = null; // a new runner only has the original approved package
  await assert.rejects(applyRelease({ ...f, root }), /verify its UUID/);

  const recovery = await fixture(
    t,
    { RELEASE_OPERATION: 'upgrade', UPTIMER_D1_ID: allocated },
    { live: f.getLive() },
  );
  recovery.cloud.request = async (path) => {
    assert.equal(path, '/pages/projects');
    const id = 'created-project';
    recovery.getLive().pages = {
      projectId: id,
      productionBranch: 'master',
      deploymentId: null,
      project: {},
    };
    return { id };
  };
  const run = async (args) => {
    const live = recovery.getLive();
    if (args.includes('migrations')) {
      assert.equal(live.appliedMigrations.length, 14);
      live.appliedMigrations = recovery.plan.migrations.map((m) => m.name);
    }
    if (args.includes('--no-bundle'))
      live.worker = {
        versionId: 'install-bundle',
        sourceSha: recovery.plan.sourceSha,
        fingerprint: recovery.plan.fingerprint,
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
        sourceSha: recovery.plan.sourceSha,
        fingerprint: recovery.plan.fingerprint,
      };
  };
  await applyRelease({ ...recovery, root, run });
  assert.equal(created, 1);
  recovery.getLive().emptyProjectDatabase = false;
  const final = await applyRelease({
    ...recovery,
    root,
    run: async () => {
      throw Error('Repeat must be a no-op');
    },
  });
  assert.equal(final.idempotentNoop, true);
  assert.equal(final.after.worker.versionId, 'install-secret');
});

test('a project appearing after the plan cannot receive a deployment or Pages settings', async (t) => {
  const f = await fixture(t, {}, { live: { pages: null } });
  f.getLive().pages = {
    projectId: 'unreviewed-project',
    productionBranch: 'master',
    deploymentId: null,
  };
  await assert.rejects(applyRelease({ ...f, root }), /unreviewed Pages project/);
});

test('a Worker that changes during deploy cannot receive the planned admin secret', async (t) => {
  const f = await fixture(t);
  const calls = [];
  await assert.rejects(
    applyRelease({
      ...f,
      root,
      run: async (args) => {
        calls.push(args);
        assert.ok(args.includes('--no-bundle'));
        f.getLive().worker = { ...f.getLive().worker, versionId: 'external', secretNames: [] };
      },
    }),
    /Worker changed outside this reviewed deployment/,
  );
  assert.equal(calls.length, 1);
});

test('populated legacy D1 requires maintenance even if the selected Worker is absent', async (t) => {
  const f = await fixture(t, {}, { live: { worker: null, appliedMigrations: [] } });
  assert.match(f.plan.blockers[0], /maintenance/);
  await assert.rejects(applyRelease({ ...f, root }), /Blocked before any remote mutation/);
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

test('only a new Worker waits for Cron propagation; existing outages fail immediately', async () => {
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
  const recovered = await verifyRelease(
    { target: { ...target, operation: 'upgrade' }, before: { worker: null } },
    'test',
    options,
  );
  assert.equal(recovered.initialWarmupMs, 30000);
  clock = start;
  await assert.rejects(
    verifyRelease({ target: { ...target, operation: 'upgrade' } }, 'test', options),
    /503/,
  );
  assert.equal(clock, start);
});
