import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  appendFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { z } from 'zod';

// Disposable local D1 only. No account IDs, credentials, remote operations, or
// edits to the application's migration files are needed for this drill.
const require = createRequire(import.meta.url);
const scenario = z.enum(['compact', 'full']).parse(process.argv[2] || 'compact');
const work = await mkdtemp(join(tmpdir(), 'uptimer-migration-recovery-'));
const migrations = join(work, 'migrations');
await mkdir(migrations);
const source = fileURLToPath(new URL('../migrations/', import.meta.url));
const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
const names = (await readdir(source)).filter((n) => n.endsWith('.sql')).sort();
z.array(z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/))
  .min(15)
  .parse(names);
const resultSchema = z.array(
  z.object({ success: z.literal(true), results: z.array(z.record(z.unknown())) }),
);
await writeFile(
  join(work, 'wrangler.toml'),
  `name = "uptimer-local-migration-audit"
compatibility_date = "2026-01-01"
[[d1_databases]]
binding = "DB"
database_name = "uptimer-local-migration-audit"
database_id = "00000000-0000-4000-8000-000000000000"
migrations_dir = "migrations"
`,
);
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_LOG_PATH: join(work, 'wrangler.log'),
  CI: 'true',
};
for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_)/.test(key)) delete env[key];
function command(args) {
  return execFileSync(
    process.execPath,
    [
      wrangler,
      'd1',
      ...args,
      'uptimer-local-migration-audit',
      '--local',
      '--config',
      join(work, 'wrangler.toml'),
      '--persist-to',
      join(work, 'state'),
    ],
    {
      cwd: work,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180000,
    },
  );
}
function execute(sql) {
  const output = command(['execute', '--json', '--command', sql]);
  return resultSchema.parse(JSON.parse(output)).map((r) => r.results);
}
const fields = 'monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt';
function snapshot() {
  return execute(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;" +
      ' SELECT count(*) n FROM check_results;' +
      ` SELECT count(*) n FROM (SELECT ${fields},count(*) copies FROM check_results GROUP BY ${fields} EXCEPT SELECT ${fields},count(*) copies FROM _rehearsal_expected_checks GROUP BY ${fields});` +
      ` SELECT count(*) n FROM (SELECT ${fields},count(*) copies FROM _rehearsal_expected_checks GROUP BY ${fields} EXCEPT SELECT ${fields},count(*) copies FROM check_results GROUP BY ${fields});` +
      ' SELECT name FROM d1_migrations ORDER BY id; SELECT monitor_id,status,last_checked_at,last_changed_at FROM monitor_state ORDER BY monitor_id;',
  );
}
function assertSamples(state) {
  assert.equal(state[1][0].n, scenario === 'full' ? 302400 : 1800);
  assert.equal(state[2][0].n, 0, 'No changed, added, or duplicated canonical samples');
  assert.equal(state[3][0].n, 0, 'No missing canonical samples');
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const name of names.filter((n) => Number(n.slice(0, 4)) <= 14))
  await copyFile(join(source, name), join(migrations, name));
command(['migrations', 'apply']);
const monitorExpression = scenario === 'full' ? '(id-1)*(id-1)*17+1' : 'id';
const minutes = scenario === 'full' ? 10079 : 59;
const start = scenario === 'full' ? 1793209200 : 1793810400;
// Only enum-selected synthetic constants enter this disposable local seed.
execute(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<30)
 INSERT INTO monitors(id,name,type,target,created_at,updated_at) SELECT ${monitorExpression},'fixture','http','https://example.com',1793700000,1793810000 FROM ids;
 INSERT INTO monitor_state(monitor_id,status,last_checked_at,last_changed_at) SELECT id,'up',1793813940,1793700000 FROM monitors;
 WITH RECURSIVE minutes(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM minutes WHERE n<${minutes})
 INSERT INTO check_results(monitor_id,checked_at,status,latency_ms,http_status,error,location,attempt)
 SELECT m.id,${start}+n*60,CASE WHEN n%10=0 THEN 'down' ELSE 'up' END,
 CASE WHEN n%10=0 THEN NULL ELSE 42+n END,CASE WHEN n%10=0 THEN 503 ELSE 200 END,
 CASE WHEN n%10=0 THEN '故障 "quoted"' || char(10) || 'line' ELSE NULL END,'HKG',CASE WHEN n%10=0 THEN 3 ELSE 1 END FROM monitors m CROSS JOIN minutes;
 CREATE TABLE _rehearsal_expected_checks AS SELECT ${fields} FROM check_results;
 CREATE INDEX _rehearsal_expected_monitor_time ON _rehearsal_expected_checks(monitor_id,checked_at);
 INSERT INTO incidents(id,title,status,impact,started_at) VALUES (1,'scoped','investigating','minor',1793810000),(2,'site-wide','investigating','minor',1793810000);
 INSERT INTO incident_monitors(incident_id,monitor_id) VALUES(1,1);
 INSERT INTO maintenance_windows(id,title,starts_at,ends_at) VALUES(1,'scoped maintenance',1793810400,1793811000),(2,'site-wide maintenance',1793810400,1793811000);
 INSERT INTO maintenance_window_monitors(maintenance_window_id,monitor_id) VALUES(1,1);`);
const initial = snapshot();
assertSamples(initial);
const canonicalComparisonHash = hash(initial.slice(1, 4));
const stages = [];
for (const name of names.filter((n) => Number(n.slice(0, 4)) > 14)) {
  const before = snapshot();
  const sql = await readFile(join(source, name), 'utf8');
  await writeFile(join(migrations, name), sql + '\nSELECT * FROM __uptimer_local_fault__;\n');
  let failed = false;
  try {
    command(['migrations', 'apply']);
  } catch (error) {
    const output = String(error.stdout ?? '') + String(error.stderr ?? '');
    if (!output.includes('__uptimer_local_fault__'))
      throw Error('Unexpected local migration failure');
    failed = true;
  }
  assert.equal(failed, true, `${name} must fail`);
  assert.equal(
    hash(snapshot()),
    hash(before),
    `${name} must roll back schema, samples and tracker`,
  );
  await writeFile(join(migrations, name), sql);
  command(['migrations', 'apply']);
  const after = snapshot();
  assertSamples(after);
  assert.equal(
    hash(after.slice(1, 4)),
    canonicalComparisonHash,
    `${name} must retain every canonical sample field including duplicate multiplicity`,
  );
  assert.equal(after[4].at(-1).name, name);
  stages.push({
    migration: name,
    sourceSha256: createHash('sha256').update(sql).digest('hex'),
    interruptionRolledBack: true,
    resumedSuccessfully: true,
    canonicalFieldsPreserved: true,
  });
  console.log(JSON.stringify(stages.at(-1)));
}
const scopes = execute('SELECT id,scope FROM incidents ORDER BY id')[0];
assert.deepEqual(scopes, [
  { id: 1, scope: 'monitors' },
  { id: 2, scope: 'global' },
]);
execute('DELETE FROM incident_monitors WHERE incident_id=1');
assert.deepEqual(execute('SELECT id,scope FROM incidents ORDER BY id')[0], scopes);
const maintenanceScopes = execute('SELECT id,scope FROM maintenance_windows ORDER BY id')[0];
assert.deepEqual(maintenanceScopes, scopes);
execute('DELETE FROM maintenance_window_monitors WHERE maintenance_window_id=1');
assert.deepEqual(
  execute('SELECT id,scope FROM maintenance_windows ORDER BY id')[0],
  maintenanceScopes,
);
const result = {
  observedAt: new Date().toISOString(),
  scope:
    'Project-locked Wrangler / Miniflare only, synthetic data, no Cloudflare account or remote resource; injected errors are appended only to disposable copies',
  baseline: '0014',
  target: names.at(-1),
  scenario,
  monitors: 30,
  sparseMonitorIds: scenario === 'full',
  samples: scenario === 'full' ? 302400 : 1800,
  sampleDays: scenario === 'full' ? 7 : 1 / 24,
  orphanHistoryDoesNotBecomeGlobal: true,
  stages,
  canonicalComparisonHash,
  comparison:
    'Exact multiset equality in both directions across all 8 sample fields, including duplicate multiplicity',
  cloudOperations: 0,
  limits:
    'Tests per-file transaction failure and forward resume. Does not prove remote migrations, production restoration, Time Travel, code rollback or already-emitted notifications.',
};
await writeFile(join(work, 'summary.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...result, evidenceDirectory: work }));

if (scenario === 'full') {
  const { rehearseRuntime } = await import('./release-runtime-rehearsal.mjs');
  console.log(
    JSON.stringify(
      await rehearseRuntime(fileURLToPath(new URL('../../../', import.meta.url)), work),
    ),
  );
}
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `evidence_directory=${work}\n`);
