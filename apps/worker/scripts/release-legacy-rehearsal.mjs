import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  initialFence,
  legacyCapabilityProbe,
  legacyMigrationBatch,
  prepareLegacySnapshots,
  resumeWriter,
  matchesLegacyGuards,
} from './release-legacy.mjs';

// Run the same SQL batches sent to D1 by Apply against the locked workerd.
const require = createRequire(import.meta.url);
const fromWrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, createFetchMock } = fromWrangler('miniflare');
const worker = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsPath = join(worker, 'migrations');
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch(){ return new Response("fixture") } }',
  d1Databases: ['DB'],
  fetchMock,
});
const planHash = 'a'.repeat(64);
try {
  const migrations = (await readdir(migrationsPath)).filter((f) => f.endsWith('.sql')).sort();
  const db = await mf.getD1Database('DB');
  const batch = (statements) =>
    db.batch(
      statements.map(({ sql, params }) => {
        const prepared = db.prepare(sql);
        return params ? prepared.bind(...params) : prepared;
      }),
    );
  await db
    .prepare(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)',
    )
    .run();
  for (const migration of migrations.slice(0, 14)) {
    const sql = await readFile(join(migrationsPath, migration), 'utf8');
    await batch([
      ...unstable_splitSqlQuery(sql).map((sql) => ({ sql })),
      {
        sql: 'INSERT INTO d1_migrations (name) VALUES (?)',
        params: [migration],
      },
    ]);
  }
  await db
    .prepare(
      "INSERT INTO monitors (id,name,type,target) VALUES (1,'Synthetic','http','https://example.invalid')",
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<302400)
    INSERT INTO check_results (monitor_id,checked_at,status,latency_ms)
    SELECT 1, n*60, 'up', n%321 FROM seq`,
    )
    .run();
  const legacyInsert = db.prepare(
    "INSERT INTO incidents (title,status,impact,started_at) VALUES ('Legacy','investigating','minor',100)",
  );
  await legacyInsert.run();
  const probe = await batch(legacyCapabilityProbe());
  assert.equal(probe[0].results[0].enabled, 0);
  assert.equal(probe.at(-1).results[0].enabled, 1);
  await batch(
    prepareLegacySnapshots(planHash, 'only-local-bookmark', {
      homepage: '{"generated_at":100,"site_title":"Fixture","site_description":""}',
      status: '{"generated_at":100}',
    }),
  );
  await batch(initialFence(planHash));
  await assert.rejects(legacyInsert.run(), /obsolete writer/);
  const aggregate = () =>
    db
      .prepare('SELECT count(*) n, sum(checked_at) t, sum(latency_ms) m FROM check_results')
      .first();
  const baseline = await aggregate();
  assert.equal(baseline.n, 302400);
  const query = () => db.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  for (const [index, migration] of migrations.entries()) {
    if (index < 14) continue;
    const statements = await legacyMigrationBatch(worker, migration, planHash, index);
    await assert.rejects(
      batch([...statements, { sql: 'SELECT * FROM deliberate_missing_table' }]),
      /deliberate_missing_table/,
    );
    assert.equal((await query()).results.length, index);
    await batch(statements);
    assert.equal((await query()).results.length, index + 1);
    await assert.rejects(legacyInsert.run(), /obsolete writer/);
    await assert.rejects(batch(statements), /NOT NULL/);
    assert.deepEqual(await aggregate(), baseline);
  }
  await batch(resumeWriter(planHash));
  await batch([
    { sql: 'PRAGMA defer_foreign_keys = ON' },
    {
      sql: "INSERT INTO incidents (title,status,impact,started_at,scope) VALUES ('Current','investigating','minor',100,'global')",
    },
  ]);
  await assert.rejects(legacyInsert.run(), /obsolete writer/);
  const guards = (
    await db
      .prepare(
        "SELECT name,tbl_name AS 'table',sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'uptimer_legacy_*' ORDER BY name",
      )
      .all()
  ).results;
  assert.equal(matchesLegacyGuards(guards, 25), true);
  console.log(
    JSON.stringify({
      migrated: 11,
      forcedRollbacks: 11,
      retained: baseline.n,
      actualGuards: guards.length,
      lateOldWriterRejected: true,
      newWriterWrote: true,
    }),
  );
} finally {
  await mf.dispose();
}
