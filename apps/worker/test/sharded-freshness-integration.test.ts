import { publishCombinedPublicSnapshots } from '../src/internal/combined-publication';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  assembleShardedPublicSnapshot,
  seedShardedPublicSnapshotFragments,
  publishHomepageArtifactSnapshotFromPublishedHomepage,
} from '../src/internal/sharded-public-snapshot-core';
import { computePublicHomepagePayload } from '../src/public/homepage';
import { computePublicStatusPayload } from '../src/public/status';
import { buildPublicMonitorCards } from '../src/public/data';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { buildHomepageRenderArtifact } from '../src/snapshots/public-homepage';

describe('fresh sharded snapshots on real SQLite', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([false, true])(
    'matches full monitor metadata for hidden=%s without building cards',
    async (includeHiddenMonitors) => {
      const { db, sqlite } = createSqliteD1();
      const now = 1_800_000_120;
      const states = ['up', 'down', 'paused', 'maintenance', 'unknown', 'up', 'up', null] as const;
      try {
        for (let i = 0; i < states.length; i++) {
          const id = i + 1;
          sqlite
            .prepare(
              `INSERT INTO monitors(id,name,type,target,created_at,updated_at,show_on_status_page,group_name,sort_order)
          VALUES (?,?,'http','https://example.com',?,?,?,?,?)`,
            )
            .run(
              id,
              `API ${id}`,
              now - id * 86400,
              now,
              id === 2 ? 0 : 1,
              id % 2 ? ' B ' : null,
              -id,
            );
          if (states[i])
            sqlite
              .prepare(
                `INSERT INTO monitor_state(monitor_id,status,last_checked_at)
          VALUES (?,?,?)`,
              )
              .run(id, states[i], id >= 6 ? now - 121 : now - 120);
        }
        sqlite.exec(
          "INSERT INTO maintenance_windows(id,title,starts_at,ends_at) VALUES (1,'Scoped',0,2000000000); INSERT INTO maintenance_window_monitors(maintenance_window_id,monitor_id) VALUES (1,2),(1,6); UPDATE settings SET value='5' WHERE key='uptime_rating_level'",
        );
        let fullIds: number[] = [],
          envelopeIds: number[] = [],
          fullMaintenance: number[] = [],
          envelopeMaintenance: number[] = [];
        let fullStart = 0,
          envelopeStart = 0;
        const full = await buildPublicMonitorCards(db, now, {
          includeHiddenMonitors,
          onMonitorIds: (ids) => {
            fullIds = ids;
          },
          onMaintenanceMonitorIds: (ids) => {
            fullMaintenance = ids;
          },
          onRangeStart: (start) => {
            fullStart = start;
          },
        });
        const envelope = await buildPublicMonitorCards(db, now, {
          includeHiddenMonitors,
          monitorSlice: { offset: 0, limit: 0 },
          onMonitorIds: (ids) => {
            envelopeIds = ids;
          },
          onMaintenanceMonitorIds: (ids) => {
            envelopeMaintenance = ids;
          },
          onRangeStart: (start) => {
            envelopeStart = start;
          },
        });
        expect(envelope).toEqual({ ...full, monitors: [] });
        expect(envelopeIds).toEqual(fullIds);
        expect(envelopeMaintenance.sort()).toEqual(fullMaintenance.sort());
        expect(envelopeStart).toBe(fullStart);
      } finally {
        sqlite.close();
      }
    },
  );
  it('preserves all sixty heartbeat bars across long gaps and changed intervals', async () => {
    const { db, sqlite } = createSqliteD1();
    const now = 1_800_000_120;
    sqlite
      .prepare(
        `INSERT INTO monitors(id,name,type,target,interval_sec,created_at,updated_at)
      VALUES (1,'API','http','https://example.com',60,?,?)`,
      )
      .run(now - 30 * 86400, now);
    sqlite
      .prepare(
        `INSERT INTO monitor_state(monitor_id,status,last_checked_at,last_latency_ms)
      VALUES (1,'up',?,42)`,
      )
      .run(now);
    const insert =
      sqlite.prepare(`INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
      VALUES (1,?,'up',42)`);
    const expected = [now];
    insert.run(now);
    for (let i = 0; i < 60; i++) {
      const at = now - 6 * 86400 - i * 3600;
      insert.run(at);
      expected.push(at);
    }
    const homepage = await computePublicHomepagePayload(db, now);
    const status = await computePublicStatusPayload(db, now);
    expect(homepage.monitors[0]!.heartbeat_strip.checked_at).toEqual(expected.slice(0, 60));
    expect(status.monitors[0]!.heartbeats.map((point) => point.checked_at)).toEqual(
      expected.slice(0, 60),
    );
    sqlite.close();
  });
  it('publishes an empty installation atomically without waiting for monitor pages', async () => {
    const { db, sqlite } = createSqliteD1();
    const now = 1_800_000_180;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const env = {
      DB: db,
      UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: '1',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
      UPTIMER_PUBLIC_COMBINED_SEED: '1',
      UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: '1',
    } as Env;
    await seedShardedPublicSnapshotFragments({
      env,
      kind: 'homepage',
      part: 'envelope',
      now,
      limit: 3,
    });
    expect(await publishCombinedPublicSnapshots(env, now)).toMatchObject({
      ok: true,
      published: true,
      monitorCount: 0,
      writeCount: 3,
    });
    const home = await computePublicHomepagePayload(db, now);
    const artifact = JSON.parse(
      sqlite.prepare("SELECT body_json FROM public_snapshots WHERE key='homepage:artifact'").get()!
        .body_json as string,
    );
    expect(artifact).toEqual(buildHomepageRenderArtifact(home));
    sqlite.close();
  });
  it.each([false, true])(
    'publishes equivalent current state/history with combined=%s',
    async (combined) => {
      const { db, sqlite, calls } = createSqliteD1();
      const now = 1_800_000_120;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      for (let id = 1; id <= 30; id++) {
        sqlite
          .prepare(
            `INSERT INTO monitors(id,name,type,target,created_at,updated_at,show_on_status_page)
        VALUES (?,?,'http','https://example.com',?,?,?)`,
          )
          .run(id, `API ${id}`, now - (id === 1 ? 30 : 1) * 86400, now - 86400, id === 30 ? 0 : 1);
        sqlite
          .prepare(
            `INSERT INTO monitor_state(monitor_id,status,last_checked_at,last_latency_ms)
        VALUES (?,?,?,?)`,
          )
          .run(id, id === 2 ? 'down' : 'up', now - 5, 40 + id);
        sqlite
          .prepare(
            "INSERT INTO check_results(monitor_id,checked_at,status,latency_ms) VALUES (?,?,'up',?)",
          )
          .run(id, now - 60, 40 + id);
      }
      // A scoped maintenance window and incident exercise the same visibility and
      // banner rules as the full endpoints, including the hidden monitor.
      sqlite
        .prepare(
          "INSERT INTO maintenance_windows(id,title,starts_at,ends_at) VALUES (1,'Maintenance',?,?)",
        )
        .run(now - 10, now + 600);
      sqlite.exec(
        'INSERT INTO maintenance_window_monitors(maintenance_window_id,monitor_id) VALUES (1,3)',
      );
      sqlite
        .prepare(
          "INSERT INTO incidents(id,title,status,impact,started_at) VALUES (1,'Investigating','investigating','major',?)",
        )
        .run(now - 10);
      sqlite.exec('INSERT INTO incident_monitors(incident_id,monitor_id) VALUES (1,2)');
      // The scoped window is outside the public preview limit. Seed context
      // must preserve its monitor suppression, rather than infer it from the
      // first 20 API preview windows.
      for (let id = 2; id <= 21; id++)
        sqlite
          .prepare(
            "INSERT INTO maintenance_windows(id,title,starts_at,ends_at,scope) VALUES (?,'Global window',?,?,'global')",
          )
          .run(id, now - 100 - id, now + 600);

      const env = {
        DB: db,
        ADMIN_TOKEN: 'test',
        UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: '1',
        UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: '1',
        UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
        UPTIMER_PUBLIC_COMBINED_SEED: combined ? '1' : '0',
      } as Env;
      const fullHomepage = await computePublicHomepagePayload(db, now);
      const fullStatus = await computePublicStatusPayload(db, now);
      expect(
        fullStatus.maintenance_windows.active.every((window) => !window.monitor_ids.includes(3)),
      ).toBe(true);
      for (const kind of ['homepage', 'status'] as const) {
        const envelope = await seedShardedPublicSnapshotFragments({
          env,
          kind,
          part: 'envelope',
          now,
          limit: 4,
        });
        expect(envelope).toMatchObject({
          ok: true,
          monitorCount: 29,
          writeCount: combined ? (kind === 'homepage' ? 2 : 0) : 1,
        });
        for (let offset = 0; offset < 29; offset += 4) {
          const before = calls.length;
          const page = await seedShardedPublicSnapshotFragments({
            env,
            kind,
            part: 'monitors',
            now,
            offset,
            limit: 4,
          });
          expect(page.ok).toBe(true);
          expect(page.monitorCount).toBe(29);
          expect(page.writeCount).toBe(1);
          if (combined && kind === 'homepage') {
            const reads = calls.slice(before);
            expect(
              reads.some(
                (call) =>
                  call.sql.includes('s.check_summary_json') &&
                  call.sql.includes('AND m.id IN (SELECT value FROM json_each(?1))'),
              ),
            ).toBe(true);
            expect(
              reads.some((call) =>
                call.sql.includes('SELECT monitor_id,check_summary_json FROM monitor_state'),
              ),
            ).toBe(false);
          }
        }
        const assembled = await assembleShardedPublicSnapshot({
          env,
          kind,
          mode: 'json',
          publish: true,
          publishArtifact: false,
          now,
        });
        expect(assembled).toMatchObject({
          ok: true,
          published: true,
          monitorCount: 29,
          generatedAt: now,
        });
        const stored = JSON.parse(
          sqlite.prepare('SELECT body_json FROM public_snapshots WHERE key=?').get(kind)!
            .body_json as string,
        );
        expect(stored).toEqual(kind === 'homepage' ? fullHomepage : fullStatus);
        expect(stored.monitors.find((m: { id: number }) => m.id === 2).status).toBe('down');
        expect(stored.monitors.find((m: { id: number }) => m.id === 3).status).toBe('maintenance');
      }
      // Upgrades retain old per-monitor and old-sized pages. They cannot block
      // a complete publication with a newer generation.
      sqlite
        .prepare(
          `INSERT INTO public_snapshot_fragments(snapshot_key,fragment_key,generated_at,body_json,updated_at)
        VALUES ('homepage:artifact:monitors','monitor:1',?,'invalid old JSON',?)`,
        )
        .run(now - 100, now - 100);
      const artifact = await publishHomepageArtifactSnapshotFromPublishedHomepage({ env, now });
      expect(artifact).toMatchObject({ ok: true, artifactPublished: true });
      const rows = sqlite
        .prepare(
          'SELECT snapshot_key,count(*) AS n FROM public_snapshot_fragments GROUP BY snapshot_key',
        )
        .all();
      expect(
        rows.find((r) => r.snapshot_key === (combined ? 'public:monitors' : 'homepage:monitors'))
          ?.n,
      ).toBe(8);
      if (combined) {
        const before = sqlite
          .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
          .all();
        const native = await publishCombinedPublicSnapshots(env, now);
        expect(native).toMatchObject({ ok: true, monitorCount: 29 });
        const after = sqlite
          .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
          .all();
        for (const row of before)
          expect(JSON.parse(after.find((r) => r.key === row.key)!.body_json as string)).toEqual(
            JSON.parse(row.body_json as string),
          );
        expect((await publishCombinedPublicSnapshots(env, now)).writeCount).toBe(0);
        const stable = sqlite
          .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
          .all();
        const page = sqlite
          .prepare(
            "SELECT body_json FROM public_snapshot_fragments WHERE snapshot_key='public:monitors' AND fragment_key='page:00000000'",
          )
          .get()!.body_json as string;
        const broken = JSON.parse(page);
        broken[0][3] = '{invalid}';
        sqlite
          .prepare(
            "UPDATE public_snapshot_fragments SET body_json=? WHERE snapshot_key='public:monitors' AND fragment_key='page:00000000'",
          )
          .run(JSON.stringify(broken));
        expect((await publishCombinedPublicSnapshots(env, now)).writeCount).toBe(0);
        expect(
          sqlite
            .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
            .all(),
        ).toEqual(stable);
        sqlite
          .prepare(
            "UPDATE public_snapshot_fragments SET body_json=? WHERE snapshot_key='public:monitors' AND fragment_key='page:00000000'",
          )
          .run(page);
        sqlite
          .prepare(
            "UPDATE public_snapshots SET generated_at=?,body_json=json_set(body_json,'$.generated_at',?) WHERE key='status'",
          )
          .run(now + 1, now + 1);
        const newer = sqlite
          .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
          .all();
        expect((await publishCombinedPublicSnapshots(env, now)).writeCount).toBe(0);
        expect(
          sqlite
            .prepare('SELECT key,generated_at,body_json FROM public_snapshots ORDER BY key')
            .all(),
        ).toEqual(newer);
      }
      // A second pass must read the new state, rather than copying the first publication.
      sqlite
        .prepare("UPDATE monitor_state SET status='up',last_checked_at=? WHERE monitor_id=2")
        .run(now + 60);
      vi.spyOn(Date, 'now').mockReturnValue((now + 60) * 1000);
      const freshPage = await seedShardedPublicSnapshotFragments({
        env,
        kind: 'homepage',
        part: 'monitors',
        now: now + 60,
        offset: 0,
        limit: 4,
      });
      expect(freshPage.ok).toBe(true);
      const pageJson = sqlite
        .prepare(
          "SELECT body_json FROM public_snapshot_fragments WHERE snapshot_key=? AND fragment_key='page:00000000'",
        )
        .get(combined ? 'public:monitors' : 'homepage:monitors')!.body_json as string;
      const current = JSON.parse(pageJson).map((entry: [string, string]) => JSON.parse(entry[1]));
      expect(current.find((m: { id: number }) => m.id === 2).status).toBe('up');
      sqlite.close();
    },
  );
});
