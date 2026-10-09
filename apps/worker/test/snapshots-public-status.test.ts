import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/middleware/errors';
import {
  applyStatusCacheHeaders,
  getSnapshotKey,
  getSnapshotMaxAgeSeconds,
  readStatusSnapshot,
  readStatusSnapshotJson,
  toSnapshotPayload,
  writeStatusSnapshot,
  prepareStatusSnapshotWrite,
  didApplyStatusSnapshotWrite,
} from '../src/snapshots/public-status';
import {
  readStatusSnapshotJson as readStatusSnapshotJsonFastPath,
  readCachedStatusSnapshotPayloadAnyAge,
  readStatusSnapshotPayloadAnyAge,
  readStaleStatusSnapshotJson,
} from '../src/snapshots/public-status-read';
import { createFakeD1Database } from './helpers/fake-d1';

function samplePayload(now = 1_728_000_000) {
  return {
    generated_at: now,
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
      up: 0,
      down: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
    },
    monitors: [],
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
  };
}

describe('snapshots/public-status', () => {
  it('exposes stable snapshot key and max-age constants', () => {
    expect(getSnapshotKey()).toBe('status');
    expect(getSnapshotMaxAgeSeconds()).toBe(60);
  });

  it('reads a fresh and valid snapshot payload', async () => {
    const now = 200;
    const payload = samplePayload(190);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          body_json: JSON.stringify(payload),
        }),
      },
    ]);

    const result = await readStatusSnapshot(db, now);
    expect(result).toEqual({
      data: payload,
      age: 10,
    });
  });

  it('falls back to live compute when snapshot is stale or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const staleDb = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({ generated_at: 0, body_json: JSON.stringify(samplePayload(0)) }),
      },
    ]);
    await expect(readStatusSnapshot(staleDb, 200)).resolves.toBeNull();

    const invalidJsonDb = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({ generated_at: 190, body_json: '{not-json' }),
      },
    ]);
    await expect(readStatusSnapshot(invalidJsonDb, 200)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to live compute when snapshot payload shape is invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const now = 200;
    const payload = { generated_at: 190, monitors: [] };
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 190,
          body_json: JSON.stringify(payload),
        }),
      },
    ]);

    await expect(readStatusSnapshot(db, now)).resolves.toBeNull();
    await expect(readStatusSnapshotJson(db, now)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects nested invalid snapshot payloads that only match the top-level shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = 200;
    const payload = {
      ...samplePayload(190),
      banner: {
        source: 'monitors',
        status: 'operational',
      },
    };
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 190,
          body_json: JSON.stringify(payload),
        }),
      },
    ]);

    await expect(readStatusSnapshot(db, now)).resolves.toBeNull();
    await expect(readStatusSnapshotJson(db, now)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to live compute when snapshot reads fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const db = createFakeD1Database([]);
    await expect(readStatusSnapshot(db, 200)).resolves.toBeNull();
    await expect(readStatusSnapshotJson(db, 200)).resolves.toBeNull();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serves the raw snapshot JSON when it looks complete', async () => {
    const now = 200;
    const payload = samplePayload(190);
    const bodyJson = JSON.stringify(payload);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          body_json: bodyJson,
        }),
      },
    ]);

    await expect(readStatusSnapshotJson(db, now)).resolves.toEqual({
      bodyJson,
      age: 10,
    });
  });

  it('rejects truncated snapshot JSON even if it matches the fast-path heuristic', async () => {
    const now = 200;
    const payload = samplePayload(190);
    const bodyJson = JSON.stringify(payload);
    const truncated = bodyJson.slice(0, -1);
    expect(truncated.startsWith('{"generated_at":')).toBe(true);
    expect(truncated.includes('"site_title"')).toBe(true);

    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          body_json: truncated,
        }),
      },
    ]);

    await expect(readStatusSnapshotJson(db, now)).resolves.toBeNull();
  });

  it('rejects corrupted snapshot JSON even if it matches substring heuristics', async () => {
    const now = 200;
    const payload = samplePayload(190);
    const bodyJson = JSON.stringify(payload);
    const corrupted = bodyJson.replace(
      `"generated_at":${payload.generated_at}`,
      `"generated_at":NaN`,
    );
    expect(corrupted.startsWith('{"generated_at":')).toBe(true);
    expect(corrupted.includes('"site_title"')).toBe(true);
    expect(corrupted.includes('"overall_status"')).toBe(true);
    expect(corrupted.endsWith('}')).toBe(true);

    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          body_json: corrupted,
        }),
      },
    ]);

    await expect(readStatusSnapshotJson(db, now)).resolves.toBeNull();
  });

  it('writes the normalized snapshot payload with upsert semantics', async () => {
    let boundArgs: unknown[] | null = null;
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          boundArgs = args;
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const now = 300;
    const payload = samplePayload(280);
    await writeStatusSnapshot(db, now, payload);

    expect(boundArgs).toEqual(['status', 280, JSON.stringify(payload), now, now + 60]);
  });

  it('exposes only fresh validated status snapshots from the in-memory cache', async () => {
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
    ]);

    const payload = samplePayload(280);
    await writeStatusSnapshot(db, 300, payload);

    expect(readCachedStatusSnapshotPayloadAnyAge(db, 320)).toEqual({
      data: payload,
      bodyJson: JSON.stringify(payload),
      age: 40,
    });
    expect(readCachedStatusSnapshotPayloadAnyAge(db, 941)).toBeNull();
    expect(readCachedStatusSnapshotPayloadAnyAge(db, 200)).toBeNull();
  });

  it('prepares conditional status writes tied to the homepage artifact write', async () => {
    let boundArgs: unknown[] | null = null;
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          boundArgs = args;
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const now = 300;
    const payload = samplePayload(280);
    const prepared = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 280,
        updatedAt: now,
      },
    });
    await prepared.statement.run();

    expect(boundArgs).toEqual([
      'status',
      280,
      JSON.stringify(payload),
      now,
      now + 60,
      'homepage:artifact',
      280,
      now,
    ]);
  });

  it('prepares conditional status writes tied to the homepage artifact and lease', async () => {
    let boundArgs: unknown[] | null = null;
    let normalizedSql = '';
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

    const now = 300;
    const payload = samplePayload(280);
    const prepared = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 280,
        updatedAt: now,
        lease: {
          name: 'snapshot:homepage:refresh',
          expiresAt: now + 55,
        },
      },
    });
    await prepared.statement.run();

    expect(boundArgs).toEqual([
      'status',
      280,
      JSON.stringify(payload),
      now,
      now + 60,
      'homepage:artifact',
      280,
      now,
      'snapshot:homepage:refresh',
      now + 55,
    ]);
    expect(normalizedSql).toContain('from locks refresh_lock');
    expect(normalizedSql).toContain('refresh_lock.expires_at = ?10');
    expect(normalizedSql).toContain(
      "refresh_lock.expires_at > cast(strftime('%s', 'now') as integer)",
    );
  });

  it('reports conditional status writes as skipped when homepage or lease guards do not match', async () => {
    const rows = new Map<string, { generated_at: number; updated_at: number; body_json: string }>([
      [
        'homepage:artifact',
        {
          generated_at: 280,
          updated_at: 300,
          body_json: '{}',
        },
      ],
    ]);
    const locks = new Map<string, number>([['snapshot:homepage:refresh', 355]]);
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const [
            key,
            generatedAt,
            bodyJson,
            updatedAt,
            futureCutoff,
            homepageKey,
            homepageGeneratedAt,
            homepageUpdatedAt,
            leaseName,
            leaseExpiresAt,
          ] = args as [
            string,
            number,
            string,
            number,
            number,
            string,
            number,
            number,
            string | undefined,
            number | undefined,
          ];
          const homepage = rows.get(homepageKey);
          if (
            !homepage ||
            homepage.generated_at !== homepageGeneratedAt ||
            homepage.updated_at !== homepageUpdatedAt ||
            (leaseName !== undefined && locks.get(leaseName) !== leaseExpiresAt)
          ) {
            return { meta: { changes: 0 } };
          }

          const existing = rows.get(key);
          if (
            !existing ||
            generatedAt >= existing.generated_at ||
            existing.generated_at > futureCutoff
          ) {
            rows.set(key, {
              generated_at: generatedAt,
              updated_at: updatedAt,
              body_json: bodyJson,
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      },
    ]);

    const now = 300;
    const payload = samplePayload(280);
    const matching = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 280,
        updatedAt: now,
        lease: { name: 'snapshot:homepage:refresh', expiresAt: 355 },
      },
    });
    const matchingResult = await matching.statement.run();

    expect(didApplyStatusSnapshotWrite(matchingResult)).toBe(true);
    expect(rows.get('status')).toEqual({
      generated_at: 280,
      updated_at: now,
      body_json: JSON.stringify(payload),
    });

    rows.delete('status');
    const mismatchedHomepage = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 281,
        updatedAt: now,
        lease: { name: 'snapshot:homepage:refresh', expiresAt: 355 },
      },
    });
    const mismatchedHomepageResult = await mismatchedHomepage.statement.run();

    expect(didApplyStatusSnapshotWrite(mismatchedHomepageResult)).toBe(false);
    expect(rows.has('status')).toBe(false);

    const mismatchedUpdatedAt = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 280,
        updatedAt: now + 1,
        lease: { name: 'snapshot:homepage:refresh', expiresAt: 355 },
      },
    });
    const mismatchedUpdatedAtResult = await mismatchedUpdatedAt.statement.run();

    expect(didApplyStatusSnapshotWrite(mismatchedUpdatedAtResult)).toBe(false);
    expect(rows.has('status')).toBe(false);

    const mismatchedLease = prepareStatusSnapshotWrite({
      db,
      now,
      payload,
      afterHomepage: {
        key: 'homepage:artifact',
        generatedAt: 280,
        updatedAt: now,
        lease: { name: 'snapshot:homepage:refresh', expiresAt: 356 },
      },
    });
    const mismatchedLeaseResult = await mismatchedLease.statement.run();

    expect(didApplyStatusSnapshotWrite(mismatchedLeaseResult)).toBe(false);
    expect(rows.has('status')).toBe(false);
  });

  it('does not let an older status snapshot overwrite a newer one', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const [key, generatedAt, bodyJson, updatedAt] = args as [string, number, string, number];
          const existing = rows.get(key);
          if (!existing || generatedAt >= existing.generated_at) {
            rows.set(key, {
              generated_at: generatedAt,
              body_json: bodyJson,
              updated_at: updatedAt,
            });
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const newerPayload = samplePayload(300);
    const olderPayload = samplePayload(280);

    await writeStatusSnapshot(db, 320, newerPayload);
    await writeStatusSnapshot(db, 340, olderPayload);

    expect(rows.get('status')).toEqual({
      generated_at: 300,
      body_json: JSON.stringify(newerPayload),
      updated_at: 320,
    });
  });

  it('treats future-dated status snapshots as unreadable on every read path', async () => {
    const payload = samplePayload(1_000);
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: payload.generated_at,
          updated_at: payload.generated_at,
          body_json: JSON.stringify(payload),
        }),
      },
    ]);

    await expect(readStatusSnapshot(db, 200)).resolves.toBeNull();
    await expect(readStatusSnapshotJson(db, 200)).resolves.toBeNull();
    await expect(readStatusSnapshotJsonFastPath(db, 200)).resolves.toBeNull();
    await expect(readStatusSnapshotPayloadAnyAge(db, 200)).resolves.toBeNull();
    await expect(readStaleStatusSnapshotJson(db, 200)).resolves.toBeNull();
  });

  it('lets a fresh real status snapshot overwrite a future-dated poisoned row', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => rows.get(args[0] as string) ?? null,
      },
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const [key, generatedAt, bodyJson, updatedAt, futureCutoff] = args as [
            string,
            number,
            string,
            number,
            number,
          ];
          const existing = rows.get(key);
          if (
            !existing ||
            generatedAt >= existing.generated_at ||
            existing.generated_at > futureCutoff
          ) {
            rows.set(key, {
              generated_at: generatedAt,
              body_json: bodyJson,
              updated_at: updatedAt,
            });
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const futurePayload = samplePayload(1_000);
    const realPayload = samplePayload(300);

    await writeStatusSnapshot(db, 100, futurePayload);
    await expect(readStatusSnapshot(db, 100)).resolves.toBeNull();

    await writeStatusSnapshot(db, 320, realPayload);

    expect(rows.get('status')).toEqual({
      generated_at: 300,
      body_json: JSON.stringify(realPayload),
      updated_at: 320,
    });
    await expect(readStatusSnapshot(db, 320)).resolves.toEqual({
      data: realPayload,
      age: 20,
    });
    await expect(readStatusSnapshotJsonFastPath(db, 320)).resolves.toEqual({
      bodyJson: JSON.stringify(realPayload),
      age: 20,
    });
  });

  it('sets bounded cache-control headers based on current snapshot age', () => {
    const young = new Response('ok');
    applyStatusCacheHeaders(young, 10);
    expect(young.headers.get('Cache-Control')).toBe(
      'public, max-age=30, stale-while-revalidate=20, stale-if-error=20',
    );

    const tooOld = new Response('ok');
    applyStatusCacheHeaders(tooOld, 120);
    expect(tooOld.headers.get('Cache-Control')).toBe(
      'public, max-age=0, stale-while-revalidate=0, stale-if-error=0',
    );
  });

  it('validates snapshot payload shape before persistence', () => {
    const payload = samplePayload(123);
    expect(toSnapshotPayload(payload)).toEqual(payload);
    expect(() => toSnapshotPayload({ generated_at: 1 })).toThrow(AppError);
  });
});
