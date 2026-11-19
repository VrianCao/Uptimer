import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { seedShardedPublicSnapshotFragments } from '../src/internal/sharded-public-snapshot-core';
import { publishCombinedPublicSnapshots } from '../src/internal/combined-publication';
import { buildHomepageRenderArtifact } from '../src/snapshots/public-homepage';
import { computePublicHomepagePayload } from '../src/public/homepage';
import type { Env } from '../src/env';

const now = 1_800_000_120;
const profile = Object.fromEntries(
  [
    ...readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').matchAll(
      /^(UPTIMER_\w+) = "([^"]*)"/gm,
    ),
  ].map((m) => [m[1], m[2]]),
);
function fixture() {
  const f = createSqliteD1();
  const env = { DB: f.db, ...profile } as Env;
  f.sqlite
    .prepare(
      `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
    VALUES(1,'API','http','https://example.com',?,?)`,
    )
    .run(now - 86400, now);
  f.sqlite
    .prepare("INSERT INTO monitor_state(monitor_id,status,last_checked_at) VALUES(1,'up',?)")
    .run(now);
  const seed = (part: 'envelope' | 'monitors') =>
    seedShardedPublicSnapshotFragments({ env, now, kind: 'homepage', part, offset: 0, limit: 10 });
  const read = () =>
    f.sqlite.prepare('SELECT key,body_json FROM public_snapshots ORDER BY key').all();
  return { ...f, env, seed, read };
}
function beforePublication(db: D1Database, change: () => Promise<void>, changes: number[]) {
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run')
          return async () => {
            await change();
            const result = await target.run();
            changes.push(result.meta.changes ?? 0);
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sql.includes('INSERT INTO public_snapshots(key,generated_at,body_json,updated_at)')
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
describe('publication consistency across asynchronous stages', () => {
  afterEach(() => vi.restoreAllMocks());
  it('publishes an empty site completely', async () => {
    const f = fixture();
    try {
      f.sqlite.exec('DELETE FROM monitors; DELETE FROM monitor_state');
      await f.seed('envelope');
      expect((await publishCombinedPublicSnapshots(f.env, now)).writeCount).toBe(3);
      const home = JSON.parse(f.read().find((row) => row.key === 'homepage')!.body_json as string);
      expect(home.monitors).toEqual([]);
      expect(home.overall_status).toBe('unknown');
      expect(home.summary).toEqual({ up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 });
    } finally {
      f.sqlite.close();
    }
  });
  it('preserves incident banner priority when monitor counts change', async () => {
    const f = fixture();
    try {
      f.sqlite
        .prepare(
          "INSERT INTO incidents(id,title,status,impact,started_at,scope) VALUES(1,'Incident','investigating','minor',?,'global')",
        )
        .run(now - 60);
      await f.seed('envelope');
      f.sqlite.exec("UPDATE monitor_state SET status='down'");
      await f.seed('monitors');
      expect((await publishCombinedPublicSnapshots(f.env, now)).writeCount).toBe(3);
      const home = JSON.parse(f.read().find((row) => row.key === 'homepage')!.body_json as string);
      expect(home.summary.down).toBe(1);
      expect(home.banner).toMatchObject({
        source: 'incident',
        status: 'partial_outage',
        incident: { id: 1 },
      });
    } finally {
      f.sqlite.close();
    }
  });
  it.each(['paused', 'down', 'unknown', 'maintenance'])(
    'derives summary, overall status and banner from the final %s card',
    async (state) => {
      const f = fixture();
      try {
        await f.seed('envelope');
        f.sqlite.prepare('UPDATE monitor_state SET status=? WHERE monitor_id=1').run(state);
        await f.seed('monitors');
        expect((await publishCombinedPublicSnapshots(f.env, now)).writeCount).toBe(3);
        const rows = f.read();
        const home = JSON.parse(rows.find((row) => row.key === 'homepage')!.body_json as string);
        const status = JSON.parse(rows.find((row) => row.key === 'status')!.body_json as string);
        const artifact = JSON.parse(
          rows.find((row) => row.key === 'homepage:artifact')!.body_json as string,
        );
        expect(home).toEqual(await computePublicHomepagePayload(f.db, now));
        expect(status.summary).toEqual(home.summary);
        expect(status.overall_status).toBe(home.overall_status);
        expect(status.banner).toEqual(home.banner);
        expect(artifact.snapshot).toEqual(home);
        expect(artifact.preload_html).toBe(buildHomepageRenderArtifact(home).preload_html);
      } finally {
        f.sqlite.close();
      }
    },
  );
  it.each(['state', 'card', 'envelope'])(
    'rejects a same-second %s change after reading presentation, then retries',
    async (kind) => {
      const f = fixture();
      const changes: number[] = [];
      let changed = false;
      try {
        await f.seed('envelope');
        await f.seed('monitors');
        const db = beforePublication(
          f.db,
          async () => {
            if (changed) return;
            changed = true;
            if (kind === 'state') f.sqlite.exec("UPDATE monitor_state SET status='down'");
            if (kind === 'card') f.sqlite.exec("UPDATE monitors SET name='New name'");
            if (kind === 'envelope') {
              f.sqlite.exec("UPDATE settings SET value='New site' WHERE key='site_title'");
              await f.seed('envelope');
            } else await f.seed('monitors');
          },
          changes,
        );
        expect((await publishCombinedPublicSnapshots({ ...f.env, DB: db }, now)).writeCount).toBe(
          3,
        );
        expect(changes).toEqual([0, 3]);
        const rows = f.read();
        const home = JSON.parse(rows.find((row) => row.key === 'homepage')!.body_json as string);
        const artifact = JSON.parse(
          rows.find((row) => row.key === 'homepage:artifact')!.body_json as string,
        );
        expect(home).toEqual(await computePublicHomepagePayload(f.db, now));
        expect(artifact.snapshot).toEqual(home);
        expect(artifact.preload_html).toBe(buildHomepageRenderArtifact(home).preload_html);
      } finally {
        f.sqlite.close();
      }
    },
  );
  it('bounds retries and preserves the complete prior publication during repeated races', async () => {
    const f = fixture();
    const changes: number[] = [];
    try {
      await f.seed('envelope');
      await f.seed('monitors');
      await publishCombinedPublicSnapshots(f.env, now);
      const prior = f.read();
      let version = 0;
      const db = beforePublication(
        f.db,
        async () => {
          f.sqlite.prepare('UPDATE monitors SET name=?').run(`Name ${++version}`);
          await f.seed('monitors');
        },
        changes,
      );
      expect((await publishCombinedPublicSnapshots({ ...f.env, DB: db }, now)).writeCount).toBe(0);
      expect(changes).toEqual([0, 0]);
      expect(f.read()).toEqual(prior);
    } finally {
      f.sqlite.close();
    }
  });
});
