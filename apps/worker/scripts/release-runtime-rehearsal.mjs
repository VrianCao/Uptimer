import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deploymentConfig, targetInput, writeJson } from './release-config.mjs';
import { command } from './release-package.mjs';
import { expectedGuards } from './release-legacy.mjs';

// Uses the already-locked Wrangler/Miniflare dependency. It cannot use remote
// bindings: all state directories and database IDs are disposable local fixtures.
const require = createRequire(
  realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)),
);
const { Miniflare, createFetchMock } = require('miniflare');
export async function rehearseRuntime(root, evidenceDirectory) {
  const summary = JSON.parse(await readFile(join(evidenceDirectory, 'summary.json'), 'utf8'));
  assert.equal(summary.cloudOperations, 0);
  const directory = join(evidenceDirectory, 'runtime');
  await mkdir(directory, { recursive: true });
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'fixture/uptimer',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    UPTIMER_D1_ID: '00000000-0000-4000-8000-000000000000',
    UPTIMER_WORKER_URL: 'https://uptimer.fixture.workers.dev',
    UPTIMER_PREFIX: 'uptimer',
    UPTIMER_WORKER_NAME: 'uptimer',
    UPTIMER_D1_NAME: 'uptimer',
    UPTIMER_PAGES_PROJECT: 'uptimer',
    RELEASE_HOSTING: 'pages',
    RELEASE_PROFILE: 'free',
    RELEASE_OPERATION: 'upgrade',
    WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
  };
  for (const key of Object.keys(env))
    if (/^(CLOUDFLARE_API_|CF_API_|GITHUB_TOKEN|GH_TOKEN|UPTIMER_ADMIN_TOKEN)/.test(key))
      delete env[key];
  const target = targetInput(env, 'fixture');
  const cfg = await deploymentConfig(root, target, '0'.repeat(40), target.databaseId);
  await writeJson(join(directory, 'build.json'), cfg);
  await command(
    [
      '--filter',
      '@uptimer/worker',
      'exec',
      'wrangler',
      'deploy',
      '--dry-run',
      '--config',
      join(directory, 'build.json'),
      '--outdir',
      directory,
    ],
    { cwd: root, env },
  );
  const clock = 1793814000;
  await writeFile(
    join(directory, 'entry.mjs'),
    `import handler from './worker-entry.js';\nexport * from './worker-entry.js';\nDate.now=()=>${clock}000;\nexport default handler;\n`,
  );
  const options = () => {
    const mock = createFetchMock();
    mock.disableNetConnect();
    mock
      .get('https://example.com')
      .intercept({ path: '/', method: 'GET' })
      .reply(200, 'synthetic OK')
      .persist();
    return {
      name: 'app',
      modules: true,
      modulesRoot: directory,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }],
      scriptPath: join(directory, 'entry.mjs'),
      compatibilityDate: cfg.compatibility_date,
      compatibilityFlags: cfg.compatibility_flags,
      cf: false,
      bindings: { ...cfg.vars, ADMIN_TOKEN: 'fixture-only-admin', UPTIMER_D1_LEGACY_FENCE: '1' },
      serviceBindings: { SELF: 'app' },
      durableObjects: { COORDINATOR: { className: 'SiteCoordinator', useSQLite: true } },
      durableObjectsPersist: join(directory, 'do'),
      d1Databases: { DB: target.databaseId },
      d1Persist: join(evidenceDirectory, 'state/v3/d1'),
      fetchMock: mock,
    };
  };
  let mf = new Miniflare(options());
  const api = async (path, status = 200, token = false) => {
    const response = await (
      await mf.getWorker()
    ).fetch('https://fixture.test/api/v1/' + path, {
      headers: token ? { Authorization: 'Bearer fixture-only-admin' } : {},
    });
    assert.equal(response.status, status, path);
    return status === 200 ? response.json() : null;
  };
  const count = async () =>
    (await (await mf.getD1Database('DB')).prepare('SELECT count(*) n FROM check_results').first())
      .n;
  try {
    const db = await mf.getD1Database('DB');
    await db.batch(expectedGuards(25).map(({ sql }) => db.prepare(sql)));
    await assert.rejects(
      db
        .prepare(
          "INSERT INTO incidents (title,status,impact,started_at) VALUES ('old','investigating','minor',100)",
        )
        .run(),
      /obsolete writer/,
    );
    assert.equal(
      (await (await mf.getD1Database('DB')).prepare('SELECT count(*) n FROM monitors').first()).n,
      30,
    );
    assert.equal(await count(), summary.samples);
    await api('admin/monitors', 401);
    await api('admin/monitors', 200, true);
    await api('internal/scheduled/check-batch', 404);
    const result = await (
      await mf.getWorker()
    ).scheduled({ scheduledTime: new Date(clock * 1000), cron: '* * * * *' });
    assert.equal(result.outcome, 'ok');
    for (let i = 0; i < 100 && (await count()) !== summary.samples + 30; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await count(),
      summary.samples + 30,
      'Actual coordinator must persist exactly one new result per monitor',
    );
    assert.deepEqual(
      (
        await (await mf.getD1Database('DB'))
          .prepare(
            'SELECT status,http_status,error,count(*) n FROM check_results WHERE checked_at=? GROUP BY status,http_status,error',
          )
          .bind(clock)
          .all()
      ).results,
      [{ status: 'up', http_status: 200, error: null, n: 30 }],
      'Mocked healthy probes must remain healthy through the actual execution path',
    );
    for (const path of ['homepage', 'status', 'homepage-artifact']) {
      const body = await api('public/' + path);
      assert.equal(body.generated_at, clock, path);
      if (path !== 'homepage-artifact') {
        assert.equal(
          JSON.stringify(body).includes('"title":"scoped"'),
          false,
          'Orphan monitor-scoped incident must stay private',
        );
        assert.equal(
          JSON.stringify(body).includes('"title":"site-wide"'),
          true,
          'Legacy global incident must remain visible',
        );
      }
    }
    await mf.dispose();
    mf = new Miniflare(options());
    assert.equal(
      await count(),
      summary.samples + 30,
      'Cold replacement must preserve canonical state',
    );
    for (const path of ['homepage', 'status', 'homepage-artifact'])
      assert.equal((await api('public/' + path)).generated_at, clock);
    assert.equal(
      (
        await (
          await mf.getWorker()
        ).scheduled({ scheduledTime: new Date(clock * 1000), cron: '* * * * *' })
      ).outcome,
      'ok',
    );
    assert.equal(
      await count(),
      summary.samples + 30,
      'Same-minute recovery must not repeat probes',
    );
    const resultSummary = {
      observedAt: new Date().toISOString(),
      environment:
        'local workerd + D1 + SQLite DO; frozen fixture clock and mocked outbound HTTP, all external network denied',
      migratedSamples: summary.samples,
      newChecks: 30,
      coldReplacementPreservedData: true,
      legacyWriterRejectedAfterCutover: true,
      repeatedMinuteDidNotDuplicate: true,
      publicRepresentations: 3,
      cloudOperations: 0,
      limits:
        'Not Cloudflare control-plane deployment, CPU billing, real network latency, notification delivery or Time Travel verification',
    };
    await writeJson(join(evidenceDirectory, 'runtime-summary.json'), resultSummary);
    return resultSummary;
  } finally {
    await mf.dispose();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(
    JSON.stringify(await rehearseRuntime(resolve(process.cwd()), resolve(process.argv[2]))),
  );
