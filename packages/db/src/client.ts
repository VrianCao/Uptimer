import { drizzle } from 'drizzle-orm/d1';
export { eq, and, or, desc, asc, sql, getTableColumns } from 'drizzle-orm';

export type Db = ReturnType<typeof getDb>;

export function getDb(env: { DB: D1Database }) {
  // All repository queries use explicit table objects. Relational `db.query`
  // metadata is unused, and rebuilding the complete schema on every request
  // consumes the Free Plan CPU budget before the actual query starts.
  return drizzle(env.DB);
}
