type QueryMatcher = string | RegExp | ((normalizedSql: string) => boolean);

export type FakeD1QueryHandler = {
  match: QueryMatcher;
  all?: (args: unknown[], normalizedSql: string) => unknown[] | Promise<unknown[]>;
  first?: (args: unknown[], normalizedSql: string) => unknown | null | Promise<unknown | null>;
  raw?: (args: unknown[], normalizedSql: string) => unknown[] | Promise<unknown[]>;
  run?: (
    args: unknown[],
    normalizedSql: string,
  ) =>
    | number
    | {
        success?: boolean;
        results?: unknown[];
        meta?: Partial<D1Result['meta']>;
      }
    | Promise<
        | number
        | {
            success?: boolean;
            results?: unknown[];
            meta?: Partial<D1Result['meta']>;
          }
      >;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesQuery(normalizedSql: string, matcher: QueryMatcher): boolean {
  if (typeof matcher === 'string') {
    return normalizedSql.includes(matcher.toLowerCase());
  }
  if (matcher instanceof RegExp) {
    return matcher.test(normalizedSql);
  }
  return matcher(normalizedSql);
}

class FakePreparedStatement {
  private args: unknown[] = [];
  private readonly normalizedSql: string;

  constructor(
    private readonly sql: string,
    private readonly handlers: FakeD1QueryHandler[],
  ) {
    this.normalizedSql = normalizeSql(sql);
  }

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const handler = this.handlers.find((item) => item.all && matchesQuery(this.normalizedSql, item.match));
    if (!handler || !handler.all) {
      throw new Error(`No fake D1 all() handler matched SQL: ${this.sql}`);
    }
    const rows = await handler.all(this.args, this.normalizedSql);
    return { results: (rows ?? []) as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const handler = this.handlers.find(
      (item) => item.first && matchesQuery(this.normalizedSql, item.match),
    );
    if (!handler || !handler.first) {
      throw new Error(`No fake D1 first() handler matched SQL: ${this.sql}`);
    }
    const row = await handler.first(this.args, this.normalizedSql);
    return (row ?? null) as T | null;
  }

  async raw<T = unknown>(): Promise<T[]> {
    const rawHandler = this.handlers.find((item) => item.raw && matchesQuery(this.normalizedSql, item.match));
    if (rawHandler?.raw) {
      const rows = await rawHandler.raw(this.args, this.normalizedSql);
      return (rows ?? []) as T[];
    }

    const allHandler = this.handlers.find((item) => item.all && matchesQuery(this.normalizedSql, item.match));
    if (allHandler?.all) {
      const rows = await allHandler.all(this.args, this.normalizedSql);
      return (rows ?? []).map(toRawRow) as T[];
    }

    const firstHandler = this.handlers.find(
      (item) => item.first && matchesQuery(this.normalizedSql, item.match),
    );
    if (firstHandler?.first) {
      const row = await firstHandler.first(this.args, this.normalizedSql);
      return row === null ? [] : ([toRawRow(row)] as T[]);
    }

    throw new Error(`No fake D1 raw() handler matched SQL: ${this.sql}`);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const handler = this.handlers.find((item) => item.run && matchesQuery(this.normalizedSql, item.match));
    if (!handler || !handler.run) {
      throw new Error(`No fake D1 run() handler matched SQL: ${this.sql}`);
    }

    const outcome = await handler.run(this.args, this.normalizedSql);
    if (typeof outcome === 'number') {
      return {
        success: true,
        results: [],
        meta: { changes: outcome },
      } as unknown as D1Result<T>;
    }

    const meta =
      outcome?.meta !== undefined
        ? { ...outcome.meta }
        : {};

    return {
      success: outcome?.success ?? true,
      results: (outcome?.results ?? []) as T[],
      meta,
    } as unknown as D1Result<T>;
  }
}

function toRawRow(row: unknown): unknown {
  if (Array.isArray(row)) {
    return row;
  }
  if (row && typeof row === 'object') {
    return Object.values(row);
  }
  return [row];
}

export function createFakeD1Database(handlers: FakeD1QueryHandler[]): D1Database {
  return {
    prepare(sql: string) {
      return new FakePreparedStatement(sql, handlers) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        const run = (statement as { run?: () => Promise<D1Result<T>> }).run;
        if (!run) {
          throw new Error('Fake D1 batch() received a statement without run()');
        }
        results.push(await run.call(statement));
      }
      return results;
    },
  } as unknown as D1Database;
}
