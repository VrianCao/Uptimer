import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { z } from 'zod';
import { digest } from './release-contract.mjs';

const legacyTables = [
  'check_results',
  'incident_monitors',
  'incident_updates',
  'incidents',
  'locks',
  'maintenance_window_monitors',
  'maintenance_windows',
  'monitor_daily_rollups',
  'monitor_state',
  'monitors',
  'notification_channels',
  'notification_deliveries',
  'outages',
  'public_snapshot_fragments',
  'public_snapshot_guard_versions',
  'public_snapshots',
  'settings',
];
const guardedTablesAfter0016 = [
  ...legacyTables.filter((table) => table !== 'check_results'),
  'check_results_legacy',
  'check_result_buckets',
];
export const ledger = 'uptimer_legacy_upgrade';
export const writePermission = 'PRAGMA defer_foreign_keys = ON';
export const legacyStateSchema = z.object({
  plan_hash: digest,
  phase: z.enum(['prepared', 'maintenance', 'open']),
});
const createLedger = `CREATE TABLE ${ledger} (
  id INTEGER PRIMARY KEY CHECK (id=1),
  plan_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'maintenance', 'open')),
  recovery_bookmark TEXT NOT NULL,
  public_homepage TEXT,
  public_status TEXT
)`;
function writeGuard(table, operation, originalName = table) {
  const name = `uptimer_legacy_${originalName}_${operation.toLowerCase()}`;
  return {
    name,
    table,
    sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
      WHEN (SELECT defer_foreign_keys FROM pragma_defer_foreign_keys) IS NOT 1
      BEGIN SELECT RAISE(ABORT, 'Uptimer: obsolete writer'); END`,
  };
}
const writeOperations = ['INSERT', 'UPDATE', 'DELETE'];
function guardsOn(table) {
  return writeOperations.map((operation) => ({ sql: writeGuard(table, operation).sql }));
}
export function expectedGuards(migrationsApplied) {
  // SQLite rewrites the ALTER TABLE trigger target but keeps the trigger name.
  const tables = migrationsApplied >= 16 ? guardedTablesAfter0016 : legacyTables;
  return tables.flatMap((table) =>
    writeOperations.map((operation) =>
      writeGuard(table, operation, table === 'check_results_legacy' ? 'check_results' : table),
    ),
  );
}
export function containsLegacyTables(catalog) {
  const names = new Set(catalog.map((row) => row.name));
  return legacyTables.every((table) => names.has(table));
}
export function matchesLegacyGuards(guards, migrationsApplied) {
  const expected = expectedGuards(migrationsApplied);
  const normalize = (sql) =>
    sql
      ?.replace('ON "check_results_legacy"', 'ON check_results_legacy')
      .trim()
      .replace(/\s+/g, ' ');
  return (
    guards.length === expected.length &&
    expected.every(({ name, table, sql }) =>
      guards.some(
        (actual) =>
          actual.name === name &&
          actual.table === table &&
          normalize(actual.sql) === normalize(sql),
      ),
    )
  );
}
export function legacyCapabilityProbe() {
  const probe = 'SELECT defer_foreign_keys AS enabled FROM pragma_defer_foreign_keys';
  // Exercise the actual trigger predicate before putting the public site into
  // maintenance. The table and trigger are created and dropped in one batch.
  return [
    { sql: probe },
    { sql: 'CREATE TABLE uptimer_legacy_probe (id INTEGER PRIMARY KEY)' },
    guardsOn('uptimer_legacy_probe')[0],
    { sql: writePermission },
    { sql: 'INSERT INTO uptimer_legacy_probe (id) VALUES (1)' },
    { sql: 'DROP TABLE uptimer_legacy_probe' },
    { sql: probe },
  ];
}
export function prepareLegacySnapshots(planHash, bookmark, snapshots) {
  return [
    { sql: createLedger },
    {
      sql: `INSERT INTO ${ledger}
        (id, plan_hash, phase, recovery_bookmark, public_homepage, public_status)
        VALUES (1, ?, 'prepared', ?, ?, ?)`,
      params: [planHash, bookmark, snapshots.homepage, snapshots.status],
    },
  ];
}
export function initialFence(planHash) {
  return [
    // A conflicting owner or phase must abort this entire fence transaction.
    {
      sql: `INSERT INTO ${ledger} (id, plan_hash, phase, recovery_bookmark)
        VALUES (1, ?, (SELECT phase FROM ${ledger}
          WHERE id=1 AND plan_hash=? AND phase='prepared'), '')
        ON CONFLICT(id) DO NOTHING`,
      params: [planHash, planHash],
    },
    ...legacyTables.flatMap(guardsOn),
    { sql: `UPDATE ${ledger} SET phase='maintenance' WHERE id=1` },
  ];
}
const publicSnapshot = z
  .object({
    generated_at: z.number().int().nonnegative(),
  })
  .passthrough();
const homepageMetadata = z.object({ site_description: z.string(), site_title: z.string() });
export async function captureLegacySnapshots(workerUrl, request) {
  const capture = async (key) => {
    const url = new URL('/api/v1/public/' + key, workerUrl);
    url.searchParams.set('uptimer', 'before-upgrade');
    const response = await request(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        'The live Worker could not provide its public ' + key + ' snapshot before maintenance',
      );
    }
    const payload = publicSnapshot.parse(await response.json());
    if (key === 'homepage') homepageMetadata.parse(payload);
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > 1_900_000)
      throw Error('The public ' + key + ' snapshot exceeds the safe D1 storage limit');
    return body;
  };
  const [homepage, status] = await Promise.all([capture('homepage'), capture('status')]);
  return { homepage, status };
}
export async function legacyMigrationBatch(directory, migration, planHash, appliedCount) {
  if (!/^00(?:1[5-9]|2[0-5])_[a-z0-9_]+\.sql$/.test(migration))
    throw Error('Unsupported legacy migration');
  const source = await readFile(join(directory, 'migrations', migration), 'utf8');
  const statements = unstable_splitSqlQuery(source).map((sql) => ({ sql }));
  return [
    { sql: writePermission },
    // Force a constraint failure before DDL if our ledger or prefix changed
    // between the last read and this transaction.
    {
      sql: `INSERT INTO ${ledger} (id,plan_hash,phase,recovery_bookmark)
        VALUES (1, ?, (SELECT phase FROM ${ledger}
          WHERE id=1 AND plan_hash=? AND phase='maintenance'
          AND (SELECT COUNT(*) FROM d1_migrations)=CAST(? AS INTEGER)), '')
        ON CONFLICT(id) DO NOTHING`,
      params: [planHash, planHash, String(appliedCount)],
    },
    ...statements,
    ...(migration.startsWith('0016_') ? guardsOn('check_result_buckets') : []),
    // Match Wrangler's tracker, in the same transaction as the migration.
    { sql: 'INSERT INTO d1_migrations (name) VALUES (?)', params: [migration] },
  ];
}
export function resumeWriter(planHash) {
  return [
    {
      sql: `UPDATE ${ledger} SET phase='open', public_homepage=NULL, public_status=NULL
        WHERE id=1 AND plan_hash=? AND phase='maintenance'`,
      params: [planHash],
    },
  ];
}
export function eligibleLegacyUpgrade(plan, state) {
  return (
    plan.target.operation === 'upgrade' &&
    !!plan.before.worker &&
    !plan.before.worker.fingerprint &&
    !plan.before.legacy &&
    plan.before.legacyCatalog === true &&
    state.applied.length === 14 &&
    state.pending.length === 11
  );
}
export function releaseConfigForLegacy(cfg, { maintenance = false } = {}) {
  const vars = { ...cfg.vars, UPTIMER_D1_LEGACY_FENCE: '1' };
  if (maintenance) vars.UPTIMER_MAINTENANCE = '1';
  return { ...cfg, vars };
}
