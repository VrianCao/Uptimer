import { z } from 'zod';
import type { Env } from './env';

const guarded = new WeakMap<D1Database, D1Database>();
const OPEN_WRITE_BATCH = 'PRAGMA defer_foreign_keys = ON';

// The D1 guard only recognizes an explicit flag in the current transaction.
// A batch does not leave the flag set for a subsequent invocation or query.
export function withLegacyWriter(env: Env): Env {
  if (env.UPTIMER_D1_LEGACY_FENCE !== '1') return env;
  const existing = guarded.get(env.DB);
  if (existing) return { ...env, DB: existing };
  const native = env.DB;
  const db: D1Database = {
    ...guardedStatements(native),
    exec: () => Promise.reject(Error('Guarded D1 writes require prepared statements')),
    dump: () => native.dump(),
    withSession: (anchor) => {
      const session = native.withSession(anchor);
      return { ...guardedStatements(session), getBookmark: session.getBookmark.bind(session) };
    },
  };
  guarded.set(native, db);
  return { ...env, DB: db };
}

function guardedStatements(client: Pick<D1Database, 'prepare' | 'batch'>) {
  const nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const writes = new WeakSet<D1PreparedStatement>();
  function wrap(native: D1PreparedStatement, write: boolean): D1PreparedStatement {
    const execute = async <T>() => {
      const [, result] = await client.batch<T>([client.prepare(OPEN_WRITE_BATCH), native]);
      return result!;
    };
    const statement: D1PreparedStatement = {
      bind: (...values) => wrap(native.bind(...values), write),
      run: () => (write ? execute() : native.run()),
      all: () => (write ? execute() : native.all()),
      first: async <T>(column?: string): Promise<T | null> => {
        if (!write) return column === undefined ? native.first<T>() : native.first<T>(column);
        const row = (await execute<Record<string, unknown>>()).results[0];
        if (!row) return null;
        if (column !== undefined && !Object.hasOwn(row, column)) throw Error('D1 column not found');
        return (column === undefined ? row : row[column]) as T;
      },
      // Application raw queries are reads. Native execution lets D1 reject an
      // accidental raw write without a transaction flag.
      raw: native.raw.bind(native),
    };
    nativeStatements.set(statement, native);
    if (write) writes.add(statement);
    return statement;
  }
  return {
    prepare: (sql: string) => wrap(client.prepare(sql), !/^\s*SELECT\b/i.test(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const plain = statements.map((statement) => {
        const native = nativeStatements.get(statement);
        if (!native) throw Error('Prepared statement belongs to a different D1 connection');
        return native;
      });
      if (!statements.some((statement) => writes.has(statement))) return client.batch<T>(plain);
      return (await client.batch<T>([client.prepare(OPEN_WRITE_BATCH), ...plain])).slice(1);
    },
  };
}

const snapshotSchema = z
  .object({
    generated_at: z.number().int().nonnegative(),
    site_description: z.string().optional(),
  })
  .passthrough();
const maintenanceMessage =
  'Uptimer is upgrading. Monitoring is paused. Last recorded data is shown.';
const maintenanceHeaders = {
  'Cache-Control': 'no-store',
  'X-Uptimer-Maintenance': 'upgrade',
  'Access-Control-Allow-Origin': '*',
};

export async function legacyMaintenanceResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const homepage = url.pathname === '/api/v1/public/homepage';
  if ((homepage || url.pathname === '/api/v1/public/status') && request.method === 'GET') {
    const row = await env.DB.prepare(
      `
      SELECT CASE WHEN ?1=1 THEN public_homepage ELSE public_status END AS body
      FROM uptimer_legacy_upgrade WHERE id=1
    `,
    )
      .bind(homepage ? 1 : 0)
      .first<{ body: string | null }>();
    if (row?.body) {
      let data: unknown;
      try {
        data = JSON.parse(row.body);
      } catch {
        data = null;
      }
      const snapshot = snapshotSchema.safeParse(data);
      if (snapshot.success) {
        return Response.json(
          homepage
            ? {
                ...snapshot.data,
                site_description: maintenanceMessage + ' ' + (snapshot.data.site_description ?? ''),
              }
            : snapshot.data,
          { headers: maintenanceHeaders },
        );
      }
    }
  }
  if (env.ASSETS && request.method === 'GET' && !url.pathname.startsWith('/api/'))
    return env.ASSETS.fetch(request);
  return Response.json(
    { error: { code: 'SERVICE_UNAVAILABLE', message: maintenanceMessage } },
    { status: 503, headers: { ...maintenanceHeaders, 'Retry-After': '60' } },
  );
}
