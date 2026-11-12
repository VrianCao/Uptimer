import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

// Run production SQL against real SQLite, including views, triggers and query
// planning. Unlike fake-d1, this adapter does not match / emulate SQL strings.
export function createSqliteD1(
  opts: {
    beforeMigration?: (sqlite: InstanceType<typeof DatabaseSync>, name: string) => void;
  } = {},
) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) {
    if (name.endsWith('.sql')) {
      opts.beforeMigration?.(sqlite, name);
      sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
  }
  const queries: string[] = [];
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const writes: Array<{ sql: string; changes: number }> = [];
  class Statement {
    constructor(
      private sql: string,
      private args: unknown[] = [],
    ) {}
    bind(...args: unknown[]) {
      return new Statement(this.sql, args);
    }
    execute() {
      queries.push(this.sql);
      calls.push({ sql: this.sql, args: this.args });
      // Node 22's experimental SQLite binding does not bind numbered ?N
      // parameters positionally. Expand them to ordinary placeholders so this
      // adapter preserves D1's numbering/reuse semantics on every supported Node.
      const numberedArgs: unknown[] = [];
      const sql = this.sql.replace(/\?(\d+)/g, (_match, index) => {
        numberedArgs.push(this.args[Number(index) - 1]);
        return '?';
      });
      const stmt = sqlite.prepare(sql);
      const args = (numberedArgs.length ? numberedArgs : this.args) as Array<
        string | number | null
      >;
      const reads =
        /^\s*EXPLAIN\b/i.test(this.sql) ||
        (/^\s*(SELECT|WITH)/i.test(this.sql) &&
          !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(this.sql));
      const returning = /\bRETURNING\b/i.test(this.sql);
      const rows = reads || returning ? stmt.all(...args) : null;
      const changes = returning
        ? Number(sqlite.prepare('SELECT changes() AS n').get()!.n)
        : rows
          ? 0
          : Number(stmt.run(...args).changes);
      if (changes) writes.push({ sql: this.sql, changes });
      return { results: rows ?? [], success: true, meta: { changes } };
    }
    async all() {
      return this.execute();
    }
    async first(column?: string) {
      const row = this.execute().results[0] ?? null;
      return column && row ? row[column] : row;
    }
    async raw() {
      return this.execute().results.map(Object.values);
    }
    async run() {
      return this.execute();
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => s.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite, queries, writes, calls };
}
