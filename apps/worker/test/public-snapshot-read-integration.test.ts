import { describe, expect, it } from 'vitest';
import { computePublicHomepagePayload } from '../src/public/homepage';
import { computePublicStatusPayload } from '../src/public/status';
import { buildHomepageRenderArtifact } from '../src/snapshots/public-homepage';
import {
  readHomepageSnapshotJson,
  readHomepageSnapshotArtifactJson,
  readStaleHomepageSnapshotArtifactJson,
} from '../src/snapshots/public-homepage-read';
import { readStatusSnapshotJson } from '../src/snapshots/public-status-read';
import { createSqliteD1 } from './helpers/sqlite-d1';

const readers = [
  { key: 'homepage', read: readHomepageSnapshotJson },
  { key: 'status', read: readStatusSnapshotJson },
  { key: 'homepage:artifact', read: readHomepageSnapshotArtifactJson },
];

describe('atomic public snapshot reads on SQLite', () => {
  it.each(readers)('observes same-second body corrections for $key', async ({ key, read }) => {
    const { db, sqlite } = createSqliteD1();
    const now = 1_800_000_120;
    try {
      const homepage = await computePublicHomepagePayload(db, now);
      const payload =
        key === 'status'
          ? await computePublicStatusPayload(db, now)
          : key === 'homepage:artifact'
            ? buildHomepageRenderArtifact(homepage)
            : homepage;
      sqlite
        .prepare(
          'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json) VALUES (?,?,?,?)',
        )
        .run(key, now, now, JSON.stringify(payload));
      expect(await read(db, now)).not.toBeNull();
      const corrected =
        key === 'homepage:artifact'
          ? buildHomepageRenderArtifact({ ...homepage, site_title: 'Corrected' })
          : { ...payload, site_title: 'Corrected' };
      sqlite
        .prepare('UPDATE public_snapshots SET body_json=? WHERE key=?')
        .run(JSON.stringify(corrected), key);
      expect(await read(db, now)).toEqual({ bodyJson: JSON.stringify(corrected), age: 0 });
      sqlite.prepare('DELETE FROM public_snapshots WHERE key=?').run(key);
      sqlite
        .prepare(
          'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json) VALUES (?,?,?,?)',
        )
        .run(key, now, now, JSON.stringify(payload));
      expect(await read(db, now)).toEqual({ bodyJson: JSON.stringify(payload), age: 0 });
      sqlite.prepare('UPDATE public_snapshots SET body_json=? WHERE key=?').run('{}', key);
      expect(await read(db, now)).toBeNull();
    } finally {
      sqlite.close();
    }
  });
  it.each(readers)('rejects mismatched source timestamps for $key', async ({ key, read }) => {
    const { db, sqlite } = createSqliteD1();
    const now = 1_800_000_120;
    try {
      const homepage = await computePublicHomepagePayload(db, now - 120);
      const payload =
        key === 'status'
          ? await computePublicStatusPayload(db, now - 120)
          : key === 'homepage:artifact'
            ? buildHomepageRenderArtifact(homepage)
            : homepage;
      sqlite
        .prepare(
          'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json) VALUES (?,?,?,?)',
        )
        .run(key, now, now, JSON.stringify(payload));
      expect(await read(db, now)).toBeNull();
    } finally {
      sqlite.close();
    }
  });
  it('does not make an old artifact fresh by touching its publication time', async () => {
    const { db, sqlite } = createSqliteD1();
    const now = 1_800_000_120;
    try {
      const artifact = buildHomepageRenderArtifact(
        await computePublicHomepagePayload(db, now - 120),
      );
      sqlite
        .prepare(
          'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json) VALUES (?,?,?,?)',
        )
        .run('homepage:artifact', now - 120, now, JSON.stringify(artifact));
      expect(await readHomepageSnapshotArtifactJson(db, now)).toBeNull();
      expect(await readStaleHomepageSnapshotArtifactJson(db, now)).toEqual({
        bodyJson: JSON.stringify(artifact),
        age: 120,
      });
    } finally {
      sqlite.close();
    }
  });
  it.each(readers)(
    'reads cold, unchanged and newer $key in one round trip each',
    async ({ key, read }) => {
      const { db, sqlite, queries, calls } = createSqliteD1();
      const now = 1_800_000_120;
      const homepage = await computePublicHomepagePayload(db, now);
      const payload =
        key === 'status'
          ? await computePublicStatusPayload(db, now)
          : key === 'homepage:artifact'
            ? buildHomepageRenderArtifact(homepage)
            : homepage;
      const insert =
        sqlite.prepare(`INSERT INTO public_snapshots(key,generated_at,updated_at,body_json)
      VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      generated_at=excluded.generated_at,updated_at=excluded.updated_at,body_json=excluded.body_json`);
      insert.run(key, now, now, JSON.stringify(payload));
      queries.length = 0;
      calls.length = 0;
      expect(await read(db, now)).toEqual({ bodyJson: JSON.stringify(payload), age: 0 });
      expect(queries).toHaveLength(1);
      const query = calls[0]!;
      // The same SQL actually omits the body for a known version; this is not an
      // emulated SQL handler returning the full object on every warm request.
      const revision = sqlite
        .prepare('SELECT body_revision FROM public_snapshots WHERE key=?')
        .get(key)!.body_revision;
      expect(
        await db.prepare(query.sql).bind(key, now, now, revision).first('body_json'),
      ).toBeNull();
      queries.length = 0;
      expect(await read(db, now + 1)).toEqual({ bodyJson: JSON.stringify(payload), age: 1 });
      expect(queries).toHaveLength(1);
      const updated =
        key === 'homepage:artifact'
          ? buildHomepageRenderArtifact({
              ...homepage,
              generated_at: now + 2,
              site_title: 'Updated',
            })
          : { ...payload, generated_at: now + 2, site_title: 'Updated' };
      insert.run(key, now + 2, now + 2, JSON.stringify(updated));
      queries.length = 0;
      expect(await read(db, now + 3)).toEqual({ bodyJson: JSON.stringify(updated), age: 1 });
      expect(queries).toHaveLength(1);
      sqlite.close();
    },
  );

  it.each(readers)(
    'omits a validated $key body when the binding object changes',
    async ({ key, read }) => {
      const { db, sqlite, calls } = createSqliteD1();
      const now = 1_800_000_123;
      try {
        const homepage = await computePublicHomepagePayload(db, now);
        const payload =
          key === 'status'
            ? await computePublicStatusPayload(db, now)
            : key === 'homepage:artifact'
              ? buildHomepageRenderArtifact(homepage)
              : homepage;
        sqlite
          .prepare(
            'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json)VALUES(?,?,?,?)',
          )
          .run(key, now, now, JSON.stringify(payload));
        expect(await read(db, now)).toEqual({ bodyJson: JSON.stringify(payload), age: 0 });
        const rebound = new Proxy(db, {});
        calls.length = 0;
        expect(await read(rebound, now + 1)).toEqual({ bodyJson: JSON.stringify(payload), age: 1 });
        expect(calls).toHaveLength(1);
        const query = calls[0]!;
        expect(
          await db
            .prepare(query.sql)
            .bind(...query.args)
            .first('body_json'),
        ).toBeNull();
        sqlite.prepare('UPDATE public_snapshots SET body_json=? WHERE key=?').run('{}', key);
        expect(await read(new Proxy(db, {}), now + 1)).toBeNull();
      } finally {
        sqlite.close();
      }
    },
  );

  it.each(readers)(
    'does not reuse another database $key body with identical timestamps',
    async ({ key, read }) => {
      const first = createSqliteD1();
      const second = createSqliteD1();
      const now = 1_800_000_121;
      try {
        const home = await computePublicHomepagePayload(first.db, now);
        const payload = key === 'status' ? await computePublicStatusPayload(first.db, now) : home;
        let priorRevision: unknown;
        for (const [fixture, title] of [
          [first, 'First'],
          [second, 'Second'],
        ] as const) {
          const titled = { ...payload, site_title: title };
          const body =
            key === 'homepage:artifact'
              ? buildHomepageRenderArtifact({ ...home, site_title: title })
              : titled;
          fixture.sqlite
            .prepare(
              'INSERT INTO public_snapshots(key,generated_at,updated_at,body_json)VALUES(?,?,?,?)',
            )
            .run(key, now, now, JSON.stringify(body));
          const revision = fixture.sqlite
            .prepare('SELECT body_revision FROM public_snapshots WHERE key=?')
            .get(key)!.body_revision;
          expect(revision).not.toBe(priorRevision);
          priorRevision = revision;
          expect(await read(fixture.db, now)).toEqual({ bodyJson: JSON.stringify(body), age: 0 });
        }
      } finally {
        first.sqlite.close();
        second.sqlite.close();
      }
    },
  );
});
