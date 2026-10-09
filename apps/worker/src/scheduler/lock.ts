export async function acquireLease(
  db: D1Database,
  name: string,
  now: number,
  leaseSeconds: number,
): Promise<boolean> {
  const expiresAt = now + leaseSeconds;

  const cached = acquireLeaseStatementByDb.get(db);
  const statement = cached ?? db.prepare(ACQUIRE_LEASE_SQL);
  if (!cached) {
    acquireLeaseStatementByDb.set(db, statement);
  }

  const r = await statement.bind(name, expiresAt, now).run();

  return (r.meta.changes ?? 0) > 0;
}

export async function releaseLease(db: D1Database, name: string, expiresAt: number): Promise<void> {
  const cached = releaseLeaseStatementByDb.get(db);
  const statement = cached ?? db.prepare(RELEASE_LEASE_SQL);
  if (!cached) {
    releaseLeaseStatementByDb.set(db, statement);
  }

  await statement.bind(name, expiresAt).run();
}

export async function renewLease(
  db: D1Database,
  name: string,
  currentExpiresAt: number,
  nextExpiresAt: number,
): Promise<boolean> {
  const cached = renewLeaseStatementByDb.get(db);
  const statement = cached ?? db.prepare(RENEW_LEASE_SQL);
  if (!cached) {
    renewLeaseStatementByDb.set(db, statement);
  }

  const result = await statement.bind(name, nextExpiresAt, currentExpiresAt).run();
  return (result.meta.changes ?? 0) > 0;
}

const ACQUIRE_LEASE_SQL = `
  INSERT INTO locks (name, expires_at)
  VALUES (?1, ?2)
  ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at
  WHERE locks.expires_at <= ?3
`;
const RELEASE_LEASE_SQL = `
  DELETE FROM locks
  WHERE name = ?1 AND expires_at = ?2
`;
const RENEW_LEASE_SQL = `
  UPDATE locks
  SET expires_at = ?2
  WHERE name = ?1 AND expires_at = ?3
`;

const acquireLeaseStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const releaseLeaseStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const renewLeaseStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
