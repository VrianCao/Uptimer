// One instance per snapshot computation. Only independent all()/first() reads
// in the same microtask are coalesced; writes and existing batches pass through.
// Never share a queue across requests or retain promises in isolate globals.
const snapshotReadScopes = new WeakSet<D1Database>();

export function batchSnapshotReads(db: D1Database): D1Database {
  if (snapshotReadScopes.has(db)) return db;
  type Pending = {
    statement: D1PreparedStatement;
    resolve: (result: D1Result) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const read = (statement: D1PreparedStatement): Promise<D1Result> =>
    new Promise((resolve, reject) => {
      pending.push({ statement, resolve, reject });
      if (pending.length !== 1) return;
      queueMicrotask(() => {
        const current = pending;
        pending = [];
        const task =
          current.length === 1
            ? current[0]!.statement.all().then((result) => [result])
            : db.batch(current.map((item) => item.statement));
        void task.then(
          (results) => {
            for (let i = 0; i < current.length; i++) {
              if (!results[i]) current[i]!.reject(new Error('Incomplete D1 read batch'));
              else current[i]!.resolve(results[i]!);
            }
          },
          (error) => {
            for (const item of current) item.reject(error);
          },
        );
      });
    });
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'all') return () => read(target);
        if (key === 'first')
          return async (column?: string) => {
            const result = await read(target);
            const row = result.results?.[0] as Record<string, unknown> | undefined;
            if (!row) return null;
            if (column !== undefined && !(column in row))
              throw new Error(`D1 column not found: ${column}`);
            return column === undefined ? row : row[column];
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const scope = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch')
        return (statements: D1PreparedStatement[]) =>
          target.batch(statements.map((statement) => originals.get(statement) ?? statement));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  snapshotReadScopes.add(scope);
  return scope;
}
