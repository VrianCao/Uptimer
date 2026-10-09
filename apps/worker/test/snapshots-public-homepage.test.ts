import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  renewLease: vi.fn(),
}));

import { acquireLease, releaseLease, renewLease } from '../src/scheduler/lock';
import {
  applyHomepageCacheHeaders,
  buildHomepageArtifactMonitorFragmentWrites,
  buildHomepageRenderArtifact,
  buildHomepageRenderArtifactFromMonitorFragments,
  HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY,
  getHomepageSnapshotKey,
  getHomepageSnapshotMaxAgeSeconds,
  getHomepageSnapshotMaxStaleSeconds,
  refreshPublicHomepageArtifactSnapshotIfNeeded,
  readHomepageSnapshot,
  readHomepageSnapshotArtifact,
  readStaleHomepageSnapshot,
  readStaleHomepageSnapshotArtifact,
  refreshPublicHomepageSnapshotIfNeeded,
  toHomepageSnapshotPayload,
  prepareHomepageSnapshotWrite,
  writeHomepageArtifactSnapshot,
  writeHomepageSnapshot,
} from '../src/snapshots/public-homepage';
import {
  readCachedHomepageRefreshBaseSnapshot,
  readHomepageRefreshBaseSnapshot,
  readHomepageSnapshotJsonAnyAge,
  readStaleHomepageSnapshotArtifactJson as readStaleHomepageSnapshotArtifactJsonHot,
} from '../src/snapshots/public-homepage-read';
import { createFakeD1Database } from './helpers/fake-d1';

function samplePayload(now = 1_728_000_000) {
  return {
    generated_at: now,
    bootstrap_mode: 'full' as const,
    monitor_count_total: 1,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 3 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: {
      up: 1,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    },
    monitors: [
      {
        id: 1,
        name: 'API',
        type: 'http' as const,
        display_url: null,
        group_name: null,
        status: 'up' as const,
        is_stale: false,
        last_checked_at: now - 30,
        heartbeat_strip: {
          checked_at: [now - 60],
          status_codes: 'u',
          latency_ms: [42],
        },
        uptime_30d: { uptime_pct: 100 },
        uptime_day_strip: {
          day_start_at: [Math.max(0, now - 86_400)],
          downtime_sec: [0],
          unknown_sec: [0],
          uptime_pct_milli: [100_000],
        },
      },
    ],
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

function hydrateStoredRenderArtifact(artifact: ReturnType<typeof buildHomepageRenderArtifact>) {
  if ('snapshot' in artifact) {
    return artifact;
  }

  const { snapshot_json: _ignoredSnapshotJson, ...rest } = artifact;
  return {
    ...rest,
    snapshot: JSON.parse(artifact.snapshot_json),
  };
}

describe('snapshots/public-homepage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes stable snapshot constants', () => {
    expect(getHomepageSnapshotKey()).toBe('homepage');
    expect(getHomepageSnapshotMaxAgeSeconds()).toBe(60);
    expect(getHomepageSnapshotMaxStaleSeconds()).toBe(600);
  });

  it('builds compact render artifacts with an embedded snapshot object', () => {
    const payload = samplePayload(190);
    const artifact = buildHomepageRenderArtifact(payload);

    expect('snapshot' in artifact).toBe(true);
    expect('snapshot_json' in artifact).toBe(false);
    if ('snapshot' in artifact) {
      expect(artifact.snapshot).toEqual(payload);
    }
  });

  it('builds pre-rendered homepage artifact monitor fragments', () => {
    const payload = samplePayload(190);
    payload.monitors[0] = {
      ...payload.monitors[0],
      name: '<API & edge>',
      group_name: 'Core',
    };

    const writes = buildHomepageArtifactMonitorFragmentWrites(payload, 200, [1]);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      snapshotKey: HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY,
      fragmentKey: 'monitor:1',
      generatedAt: 190,
      updatedAt: 200,
    });
    const body = JSON.parse(writes[0].bodyJson) as {
      id: number;
      name: string;
      group_name: string | null;
      card_html: string;
    };
    expect(body.id).toBe(1);
    expect(body.name).toBe('<API & edge>');
    expect(body.group_name).toBe('Core');
    expect(body.card_html).toContain('&lt;API &amp; edge&gt;');
    expect(body.card_html).toContain('Availability (60d)');
    expect(body.card_html).toContain('<path d="M');
    expect(body.card_html).not.toContain('<rect ');
  });

  it('builds homepage artifacts from pre-rendered monitor fragments', () => {
    const payload = samplePayload(190);
    const rows = buildHomepageArtifactMonitorFragmentWrites(payload, 200).map((write) => {
      const body = JSON.parse(write.bodyJson) as { card_html: string };
      return {
        fragment_key: write.fragmentKey,
        generated_at: write.generatedAt,
        body_json: JSON.stringify({
          ...body,
          card_html: '<article class="card">PRE-RENDERED API</article>',
        }),
        updated_at: write.updatedAt,
      };
    });

    const result = buildHomepageRenderArtifactFromMonitorFragments(payload, rows);

    expect(result.missingCount).toBe(0);
    expect(result.staleCount).toBe(0);
    expect(result.invalidCount).toBe(0);
    expect(result.artifact?.preload_html).toContain('PRE-RENDERED API');
    expect(result.artifact?.snapshot).toEqual(payload);
  });

  it('rejects incomplete homepage artifact monitor fragments', () => {
    const payload = samplePayload(190);

    const result = buildHomepageRenderArtifactFromMonitorFragments(payload, []);

    expect(result.artifact).toBeNull();
    expect(result.missingCount).toBe(1);
  });

  it('reads fresh and bounded-stale homepage snapshots without live compute', async () => {
    const payload = samplePayload(190);
    const storedRender = buildHomepageRenderArtifact(payload);
    const hydratedRender = hydrateStoredRenderArtifact(storedRender);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify(storedRender),
            };
          }
          return null;
        },
      },
    ]);

    await expect(readHomepageSnapshot(db, 200)).resolves.toEqual({
      data: payload,
      age: 10,
    });
    await expect(readHomepageSnapshotArtifact(db, 200)).resolves.toEqual({
      data: hydratedRender,
      age: 10,
    });
    await expect(readStaleHomepageSnapshot(db, 200)).resolves.toEqual({
      data: payload,
      age: 10,
    });
    await expect(readStaleHomepageSnapshotArtifact(db, 200)).resolves.toEqual({
      data: hydratedRender,
      age: 10,
    });
  });

  it('reads legacy homepage payloads but refuses to synthesize render artifacts on the read path', async () => {
    const {
      bootstrap_mode: _ignoredMode,
      monitor_count_total: _ignoredCount,
      ...legacyPayload
    } = samplePayload(190);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: legacyPayload.generated_at,
          body_json: JSON.stringify(legacyPayload),
        }),
      },
    ]);

    await expect(readHomepageSnapshot(db, 200)).resolves.toEqual({
      data: samplePayload(190),
      age: 10,
    });
    await expect(readHomepageSnapshotArtifact(db, 200)).resolves.toBeNull();
  });

  it('keeps the full monitor list in render artifacts', () => {
    const payload = {
      ...samplePayload(190),
      monitor_count_total: 30,
      monitors: Array.from({ length: 30 }, (_, index) => ({
        ...samplePayload(190).monitors[0],
        id: index + 1,
        name: `Monitor ${index + 1}`,
      })),
      summary: {
        up: 30,
        down: 0,
        maintenance: 0,
        paused: 0,
        unknown: 0,
      },
      maintenance_history_preview: {
        id: 1,
        title: 'Database patching',
        message: null,
        starts_at: 120,
        ends_at: 180,
        monitor_ids: [30],
      },
    };

    const artifact = buildHomepageRenderArtifact(payload);
    const bootstrapped = hydrateStoredRenderArtifact(artifact).snapshot;
    expect(bootstrapped.bootstrap_mode).toBe('full');
    expect(bootstrapped.monitor_count_total).toBe(30);
    expect(bootstrapped.monitors).toHaveLength(30);
    expect(artifact.preload_html).toContain('Monitor 30');
    expect(artifact.preload_html).toContain('<path d="M');
    expect(artifact.preload_html).not.toContain('<rect ');
    expect(artifact.preload_html).not.toContain('#30');
    expect(artifact.preload_html).not.toContain(
      'more services will appear after the app finishes loading',
    );
  });

  it('returns null when homepage snapshot is too old or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const staleDb = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 0,
          body_json: JSON.stringify(samplePayload(0)),
        }),
      },
    ]);
    await expect(readHomepageSnapshot(staleDb, 200)).resolves.toBeNull();
    await expect(readStaleHomepageSnapshot(staleDb, 800)).resolves.toBeNull();

    const invalidDb = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 190,
          body_json: '{not-json',
        }),
      },
    ]);
    await expect(readHomepageSnapshot(invalidDb, 200)).resolves.toBeNull();
    warn.mockRestore();
  });

  it('writes normalized homepage snapshots through the artifact row', async () => {
    const boundArgs: unknown[][] = [];
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          boundArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const payload = samplePayload(280);
    await writeHomepageSnapshot(db, 300, payload);

    const storedRender = buildHomepageRenderArtifact(payload);

    expect(boundArgs).toEqual([['homepage:artifact', 280, JSON.stringify(storedRender), 300, 360]]);
  });

  it('can bind homepage artifact writes to the current refresh lease', async () => {
    let normalizedSql = '';
    let boundArgs: unknown[] | null = null;
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args, sql) => {
          boundArgs = args;
          normalizedSql = sql;
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const payload = samplePayload(280);
    const prepared = prepareHomepageSnapshotWrite(db, 300, payload, undefined, false, {
      name: 'snapshot:homepage:refresh',
      expiresAt: 355,
    });
    await prepared.statement.run();

    expect(boundArgs).toEqual([
      'homepage:artifact',
      280,
      JSON.stringify(buildHomepageRenderArtifact(payload)),
      300,
      360,
      'snapshot:homepage:refresh',
      355,
    ]);
    expect(normalizedSql).toContain('from locks refresh_lock');
    expect(normalizedSql).toContain('refresh_lock.expires_at = ?7');
    expect(normalizedSql).toContain(
      "refresh_lock.expires_at > cast(strftime('%s', 'now') as integer)",
    );
  });

  it('does not let an older homepage snapshot overwrite a newer one', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const pairs = [args.slice(0, 4)] as [string, number, string, number][];
          for (const [key, generatedAt, bodyJson, updatedAt] of pairs) {
            const existing = rows.get(key);
            if (!existing || generatedAt >= existing.generated_at) {
              rows.set(key, {
                generated_at: generatedAt,
                body_json: bodyJson,
                updated_at: updatedAt,
              });
            }
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const olderPayload = samplePayload(280);
    const newerPayload = samplePayload(300);

    await writeHomepageSnapshot(db, 300, newerPayload);
    await writeHomepageSnapshot(db, 320, olderPayload);

    expect(rows.get('homepage')).toBeUndefined();
    expect(rows.get('homepage:artifact')?.generated_at).toBe(300);
    expect(rows.get('homepage:artifact')?.body_json).toBe(
      JSON.stringify(buildHomepageRenderArtifact(newerPayload)),
    );
  });

  it('self-heals future-dated homepage snapshot rows with a newer real-time refresh', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const futureCutoffAt = Number(args[4] ?? 0);
          const pairs = [args.slice(0, 4)] as [string, number, string, number][];
          for (const [key, generatedAt, bodyJson, updatedAt] of pairs) {
            const existing = rows.get(key);
            if (
              !existing ||
              generatedAt >= existing.generated_at ||
              existing.generated_at > futureCutoffAt
            ) {
              rows.set(key, {
                generated_at: generatedAt,
                body_json: bodyJson,
                updated_at: updatedAt,
              });
            }
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const futurePayload = samplePayload(900);
    const currentPayload = samplePayload(300);

    await writeHomepageSnapshot(db, 900, futurePayload);
    await writeHomepageSnapshot(db, 320, currentPayload);

    expect(rows.get('homepage')).toBeUndefined();
    expect(rows.get('homepage:artifact')?.generated_at).toBe(300);
    expect(rows.get('homepage:artifact')?.body_json).toBe(
      JSON.stringify(buildHomepageRenderArtifact(currentPayload)),
    );
  });

  it('does not let a late older homepage snapshot roll back a legitimate newer row', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const futureCutoffAt = Number(args[4] ?? 0);
          const pairs = [args.slice(0, 4)] as [string, number, string, number][];
          for (const [key, generatedAt, bodyJson, updatedAt] of pairs) {
            const existing = rows.get(key);
            if (
              !existing ||
              generatedAt >= existing.generated_at ||
              existing.generated_at > futureCutoffAt
            ) {
              rows.set(key, {
                generated_at: generatedAt,
                body_json: bodyJson,
                updated_at: updatedAt,
              });
            }
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const newerPayload = samplePayload(421);
    const olderPayload = samplePayload(360);

    await writeHomepageSnapshot(db, 430, newerPayload);
    await writeHomepageSnapshot(db, 435, olderPayload);

    expect(rows.get('homepage')).toBeUndefined();
    expect(rows.get('homepage:artifact')?.generated_at).toBe(421);
    expect(rows.get('homepage:artifact')?.body_json).toBe(
      JSON.stringify(buildHomepageRenderArtifact(newerPayload)),
    );
  });

  it('serves homepage payload JSON from artifact-only snapshot writes', async () => {
    const boundArgs: unknown[][] = [];
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          boundArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const payload = samplePayload(280);
    await writeHomepageSnapshot(db, 300, payload, undefined, true);

    expect(boundArgs).toEqual([
      ['homepage:artifact', 280, JSON.stringify(buildHomepageRenderArtifact(payload)), 300, 360],
    ]);

    const readDb = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: 280,
                body_json: boundArgs[0]?.[2],
              }
            : null,
      },
    ]);
    await expect(readHomepageSnapshotJsonAnyAge(readDb, 300)).resolves.toEqual({
      bodyJson: JSON.stringify(payload),
      age: 20,
    });
  });

  it('writes artifact-only homepage snapshots without touching the full payload row', async () => {
    const boundArgs: unknown[][] = [];
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          boundArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const payload = {
      ...samplePayload(280),
      bootstrap_mode: 'full' as const,
      monitor_count_total: 30,
      monitors: Array.from({ length: 30 }, (_, index) => ({
        ...samplePayload(280).monitors[0],
        id: index + 1,
        name: `Monitor ${index + 1}`,
      })),
    };

    await writeHomepageArtifactSnapshot(db, 300, payload);

    expect(boundArgs).toEqual([
      ['homepage:artifact', 280, JSON.stringify(buildHomepageRenderArtifact(payload)), 300, 360],
    ]);
  });

  it('applies bounded cache headers for homepage payloads', () => {
    const fresh = new Response('ok');
    applyHomepageCacheHeaders(fresh, 10);
    expect(fresh.headers.get('Cache-Control')).toBe(
      'public, max-age=30, stale-while-revalidate=20, stale-if-error=20',
    );

    const stale = new Response('ok');
    applyHomepageCacheHeaders(stale, 120);
    expect(stale.headers.get('Cache-Control')).toBe(
      'public, max-age=0, stale-while-revalidate=0, stale-if-error=0',
    );
  });

  it('validates homepage snapshot payload shape before persistence', () => {
    const payload = samplePayload(123);
    expect(toHomepageSnapshotPayload(payload)).toEqual(payload);
    expect(() => toHomepageSnapshotPayload({ generated_at: 1 })).toThrow();
  });

  it('skips refresh when the homepage snapshot was already generated this minute', async () => {
    const now = 1_728_000_045;
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 1_728_000_031,
          body_json: JSON.stringify(samplePayload(1_728_000_031)),
        }),
      },
    ]);

    const compute = vi.fn(async () => samplePayload(now));
    const refreshed = await refreshPublicHomepageSnapshotIfNeeded({ db, now, compute });

    expect(refreshed).toBe(false);
    expect(acquireLease).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
  });

  it('refreshes once when the minute changed and a refresh lease is acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    let readCount = 0;
    const writtenArgs: unknown[][] = [];
    const now = 1_728_000_120;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] !== 'homepage') {
            return null;
          }
          readCount += 1;
          if (readCount <= 2) {
            return {
              generated_at: 1_728_000_001,
              body_json: JSON.stringify(samplePayload(1_728_000_001)),
            };
          }
          return {
            generated_at: now,
            body_json: JSON.stringify(samplePayload(now)),
          };
        },
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          writtenArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const compute = vi.fn(async () => samplePayload(now));
    const refreshed = await refreshPublicHomepageSnapshotIfNeeded({ db, now, compute });
    const storedRender = buildHomepageRenderArtifact(samplePayload(now));

    expect(refreshed).toBe(true);
    expect(acquireLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now, 55);
    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(writtenArgs).toEqual([
      [
        'homepage:artifact',
        now,
        JSON.stringify(storedRender),
        now,
        now + 60,
        'snapshot:homepage:refresh',
        now + 55,
      ],
    ]);
  });

  it('forces a refresh within the same minute for admin-triggered invalidations', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    const writtenArgs: unknown[][] = [];
    const now = 1_728_000_045;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const payload = samplePayload(now);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 5,
          body_json: JSON.stringify(samplePayload(now - 5)),
        }),
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          writtenArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const compute = vi.fn(async () => payload);
    const refreshed = await refreshPublicHomepageSnapshotIfNeeded({
      db,
      now,
      compute,
      force: true,
      seedDataSnapshot: true,
    });

    expect(refreshed).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
    expect(writtenArgs).toEqual([
      [
        'homepage:artifact',
        now,
        JSON.stringify(buildHomepageRenderArtifact(payload)),
        now,
        now + 60,
        'snapshot:homepage:refresh',
        now + 55,
      ],
    ]);
  });

  it('returns false and keeps the previous base snapshot cached state when the upsert is a no-op', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    const now = 1_728_000_045;
    const previousPayload = samplePayload(now + 30);
    const nextPayload = samplePayload(now);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: previousPayload.generated_at,
            updated_at: previousPayload.generated_at,
            body_json: JSON.stringify(previousPayload),
          },
          {
            key: 'homepage:artifact',
            generated_at: previousPayload.generated_at,
            updated_at: previousPayload.generated_at,
            body_json: JSON.stringify(buildHomepageRenderArtifact(previousPayload)),
          },
        ],
      },
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 0 } }),
      },
    ]);

    const compute = vi.fn(async () => nextPayload);
    const refreshed = await refreshPublicHomepageSnapshotIfNeeded({
      db,
      now,
      compute,
      force: true,
    });
    const baseSnapshot = await readHomepageRefreshBaseSnapshot(db, now);

    expect(refreshed).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(baseSnapshot.generatedAt).toBe(previousPayload.generated_at);
    expect(baseSnapshot.snapshot).toEqual(previousPayload);
  });

  it('releases the homepage refresh lease when compute fails', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    const now = 1_728_000_180;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: now - 120,
          body_json: JSON.stringify(samplePayload(now - 120)),
        }),
      },
    ]);

    const compute = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      refreshPublicHomepageSnapshotIfNeeded({ db, now, compute, force: true }),
    ).rejects.toThrow('boom');
    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
  });

  it('renews the homepage refresh lease during long-running refreshes', async () => {
    vi.useFakeTimers();
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(renewLease).mockResolvedValue(true);

    const now = 1_728_000_240;
    vi.setSystemTime(now * 1000);

    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
    ]);

    let resolveCompute: ((value: ReturnType<typeof samplePayload>) => void) | null = null;
    const compute = vi.fn(
      () =>
        new Promise<ReturnType<typeof samplePayload>>((resolve) => {
          resolveCompute = resolve;
        }),
    );

    const refreshPromise = refreshPublicHomepageSnapshotIfNeeded({
      db,
      now,
      compute,
      force: true,
    });

    await vi.advanceTimersByTimeAsync(45_000);

    expect(renewLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55, now + 100);

    resolveCompute?.(samplePayload(now));
    await refreshPromise;

    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 100);
  });

  it('fails closed when the homepage refresh helper loses its lease before writes', async () => {
    vi.useFakeTimers();
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(renewLease).mockResolvedValue(false);

    const now = 1_728_000_240;
    vi.setSystemTime(now * 1000);
    let writes = 0;
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: () => {
          writes += 1;
          return { meta: { changes: 1 } };
        },
      },
    ]);

    let resolveCompute: ((value: ReturnType<typeof samplePayload>) => void) | null = null;
    const compute = vi.fn(
      () =>
        new Promise<ReturnType<typeof samplePayload>>((resolve) => {
          resolveCompute = resolve;
        }),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const refreshPromise = refreshPublicHomepageSnapshotIfNeeded({
        db,
        now,
        compute,
        force: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      resolveCompute?.(samplePayload(now));

      await expect(refreshPromise).resolves.toBe(false);
      expect(writes).toBe(0);
      expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
    } finally {
      warn.mockRestore();
    }
  });

  it('prefers the freshest valid same-day snapshot as the internal refresh base snapshot', async () => {
    const now = 1_728_000_500;
    const payload = samplePayload(now - 300);
    const artifactPayload = samplePayload(now - 60);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          },
          {
            key: 'homepage:artifact',
            generated_at: artifactPayload.generated_at,
            updated_at: artifactPayload.generated_at,
            body_json: JSON.stringify(buildHomepageRenderArtifact(artifactPayload)),
          },
        ],
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: artifactPayload.generated_at,
      snapshot: artifactPayload,
      seedDataSnapshot: false,
    });
  });

  it('uses a primed parsed cache as a cache-only refresh base snapshot', async () => {
    const now = 1_728_000_500;
    const payload = samplePayload(now - 300);
    const artifactPayload = samplePayload(now - 60);
    let readCount = 0;
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => {
          readCount += 1;
          return [
            {
              key: 'homepage',
              generated_at: payload.generated_at,
              updated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            },
            {
              key: 'homepage:artifact',
              generated_at: artifactPayload.generated_at,
              updated_at: artifactPayload.generated_at,
              body_json: JSON.stringify(buildHomepageRenderArtifact(artifactPayload)),
            },
          ];
        },
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: artifactPayload.generated_at,
      snapshot: artifactPayload,
      seedDataSnapshot: false,
    });

    expect(readCachedHomepageRefreshBaseSnapshot(db, now)).toEqual({
      generatedAt: artifactPayload.generated_at,
      snapshot: artifactPayload,
      seedDataSnapshot: false,
    });
    expect(readCount).toBe(1);
  });

  it('returns null for cache-only refresh base reads when the per-DB cache is cold', () => {
    const now = 1_728_000_500;
    const db = createFakeD1Database([]);

    expect(readCachedHomepageRefreshBaseSnapshot(db, now)).toBeNull();
  });

  it('uses the same-day homepage payload row as the refresh base from the batch snapshot read', async () => {
    const now = 1_728_000_500;
    const payload = samplePayload(now - 60);
    let readCount = 0;
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => {
          readCount += 1;
          return [
            {
              key: 'homepage',
              generated_at: payload.generated_at,
              updated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            },
          ];
        },
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: payload.generated_at,
      snapshot: payload,
      seedDataSnapshot: false,
    });
    expect(readCount).toBe(1);
  });

  it('keeps using the valid homepage row when an equal-age artifact row is corrupted', async () => {
    const now = 1_728_000_500;
    const payload = samplePayload(now - 60);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          },
          {
            key: 'homepage:artifact',
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json:
              '{"generated_at":190,"preload_html":"<div>bad</div>","snapshot":{"generated_at":190',
          },
        ],
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: payload.generated_at,
      snapshot: payload,
      seedDataSnapshot: false,
    });
  });

  it('ignores future-dated refresh snapshot candidates', async () => {
    const now = 1_728_000_500;
    const validPayload = samplePayload(now - 60);
    const futurePayload = samplePayload(now + 600);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: futurePayload.generated_at,
            updated_at: futurePayload.generated_at,
            body_json: JSON.stringify(futurePayload),
          },
          {
            key: 'homepage:artifact',
            generated_at: validPayload.generated_at,
            updated_at: validPayload.generated_at,
            body_json: JSON.stringify(buildHomepageRenderArtifact(validPayload)),
          },
        ],
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: validPayload.generated_at,
      snapshot: validPayload,
      seedDataSnapshot: false,
    });
  });

  it('rejects refresh base snapshots whose embedded generated_at does not match the row metadata', async () => {
    const now = 1_728_000_500;
    const validPayload = samplePayload(now - 60);
    const mismatchedPayload = samplePayload(now - 120);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage',
            generated_at: now - 30,
            updated_at: now - 30,
            body_json: JSON.stringify({
              ...mismatchedPayload,
              generated_at: mismatchedPayload.generated_at,
            }),
          },
          {
            key: 'homepage:artifact',
            generated_at: validPayload.generated_at,
            updated_at: validPayload.generated_at,
            body_json: JSON.stringify(buildHomepageRenderArtifact(validPayload)),
          },
        ],
      },
    ]);

    await expect(readHomepageRefreshBaseSnapshot(db, now)).resolves.toEqual({
      generatedAt: validPayload.generated_at,
      snapshot: validPayload,
      seedDataSnapshot: false,
    });
  });

  it('normalizes artifact rows to the homepage payload shape on the public read path', async () => {
    const now = 1_728_000_200;
    const payload = samplePayload(now - 10);
    const render = buildHomepageRenderArtifact(payload);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) =>
          args[0] === 'homepage:artifact'
            ? {
                generated_at: payload.generated_at,
                body_json: JSON.stringify(render),
              }
            : null,
      },
    ]);

    await expect(readHomepageSnapshotJsonAnyAge(db, now)).resolves.toEqual({
      bodyJson: JSON.stringify(payload),
      age: 10,
    });
  });

  it('lazy-reads only the selected homepage body row when refresh metadata is available', async () => {
    const now = 1_728_000_200;
    const fresherPayload = samplePayload(now - 10);
    const olderPayload = samplePayload(now - 30);
    let metadataReads = 0;
    const bodyReads: string[] = [];
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at from public_snapshots',
        all: () => {
          metadataReads += 1;
          return [
            {
              key: 'homepage',
              generated_at: fresherPayload.generated_at,
              updated_at: fresherPayload.generated_at,
            },
            {
              key: 'homepage:artifact',
              generated_at: olderPayload.generated_at,
              updated_at: olderPayload.generated_at,
            },
          ];
        },
      },
      {
        match: 'select generated_at, updated_at, body_json from public_snapshots',
        first: (args) => {
          const key = String(args[0]);
          bodyReads.push(key);
          if (key === 'homepage') {
            return {
              generated_at: fresherPayload.generated_at,
              updated_at: fresherPayload.generated_at,
              body_json: JSON.stringify(fresherPayload),
            };
          }
          if (key === 'homepage:artifact') {
            return {
              generated_at: olderPayload.generated_at,
              updated_at: olderPayload.generated_at,
              body_json: JSON.stringify(buildHomepageRenderArtifact(olderPayload)),
            };
          }
          return null;
        },
      },
    ]);

    await expect(readHomepageSnapshotJsonAnyAge(db, now)).resolves.toEqual({
      bodyJson: JSON.stringify(fresherPayload),
      age: 10,
    });
    expect(metadataReads).toBe(1);
    expect(bodyReads).toEqual(['homepage']);
  });

  it('ignores future-dated stale artifact candidates on the public hot read path', async () => {
    const now = 1_728_000_200;
    const futurePayload = samplePayload(now + 600);
    const db = createFakeD1Database([
      {
        match: 'select key, generated_at, updated_at, body_json from public_snapshots',
        all: () => [
          {
            key: 'homepage:artifact',
            generated_at: futurePayload.generated_at,
            updated_at: futurePayload.generated_at,
            body_json: JSON.stringify(buildHomepageRenderArtifact(futurePayload)),
          },
        ],
      },
    ]);

    await expect(readStaleHomepageSnapshotArtifactJsonHot(db, now)).resolves.toBeNull();
  });

  it('prefers the freshest valid homepage payload row over an older valid artifact row on the hot read path', async () => {
    const now = 1_728_000_200;
    const olderPayload = samplePayload(now - 30);
    const fresherPayload = samplePayload(now - 10);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: olderPayload.generated_at,
              body_json: JSON.stringify(buildHomepageRenderArtifact(olderPayload)),
            };
          }
          if (args[0] === 'homepage') {
            return {
              generated_at: fresherPayload.generated_at,
              body_json: JSON.stringify(fresherPayload),
            };
          }
          return null;
        },
      },
    ]);

    await expect(readHomepageSnapshotJsonAnyAge(db, now)).resolves.toEqual({
      bodyJson: JSON.stringify(fresherPayload),
      age: 10,
    });
  });

  it('falls back to the homepage payload row when the artifact row is invalid on the hot read path', async () => {
    const now = 1_728_000_200;
    const payload = samplePayload(now - 10);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: payload.generated_at,
              body_json:
                '{"generated_at":190,"preload_html":"<div>bad</div>","snapshot":{"generated_at":190',
            };
          }
          if (args[0] === 'homepage') {
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            };
          }
          return null;
        },
      },
    ]);

    await expect(readHomepageSnapshotJsonAnyAge(db, now)).resolves.toEqual({
      bodyJson: JSON.stringify(payload),
      age: 10,
    });
  });

  it('refreshes only the artifact snapshot when the scheduler path requests it', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    let artifactGeneratedAt = 1_728_000_001;
    const writtenArgs: unknown[][] = [];
    const now = 1_728_000_120;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const payload = {
      ...samplePayload(now),
      bootstrap_mode: 'full' as const,
      monitor_count_total: 30,
      monitors: Array.from({ length: 30 }, (_, index) => ({
        ...samplePayload(now).monitors[0],
        id: index + 1,
        name: `Monitor ${index + 1}`,
      })),
    };
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] !== 'homepage:artifact') {
            return null;
          }
          return {
            generated_at: artifactGeneratedAt,
            body_json: JSON.stringify(
              buildHomepageRenderArtifact(samplePayload(artifactGeneratedAt)),
            ),
          };
        },
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          writtenArgs.push(args);
          artifactGeneratedAt = Number(args[1]);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const compute = vi.fn(async () => payload);
    const refreshed = await refreshPublicHomepageArtifactSnapshotIfNeeded({ db, now, compute });

    expect(refreshed).toBe(true);
    expect(acquireLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now, 55);
    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(writtenArgs).toEqual([
      [
        'homepage:artifact',
        now,
        JSON.stringify(buildHomepageRenderArtifact(payload)),
        now,
        now + 60,
        'snapshot:homepage:refresh',
        now + 55,
      ],
    ]);
  });

  it('refreshes the artifact snapshot when the homepage row is fresh but the artifact row is missing', async () => {
    vi.mocked(acquireLease).mockResolvedValue(true);

    const writtenArgs: unknown[][] = [];
    const now = 1_728_000_120;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const payload = samplePayload(now);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage') {
            return {
              generated_at: now - 5,
              body_json: JSON.stringify(samplePayload(now - 5)),
            };
          }
          return null;
        },
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          writtenArgs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const compute = vi.fn(async () => payload);
    const refreshed = await refreshPublicHomepageArtifactSnapshotIfNeeded({ db, now, compute });

    expect(refreshed).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledWith(db, 'snapshot:homepage:refresh', now + 55);
    expect(writtenArgs).toEqual([
      [
        'homepage:artifact',
        now,
        JSON.stringify(buildHomepageRenderArtifact(payload)),
        now,
        now + 60,
        'snapshot:homepage:refresh',
        now + 55,
      ],
    ]);
  });
});
