import { storedPublicHomepageResponseSchema as originalHome } from '@uptimer/shared/public-homepage';
import { storedPublicStatusResponseSchema as originalStatus } from '@uptimer/shared/public-status';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { computePublicHomepagePayload } from '../src/public/homepage';
import { computePublicStatusPayload } from '../src/public/status';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '../../web/node_modules/@tanstack/react-query';
import { queryClient } from '../../web/src/app/queryClient';
import { fetchHomepage, fetchLatency } from '../../web/src/api/client';
import {
  HOMEPAGE_STORAGE_KEY,
  LEGACY_STATUS_STORAGE_KEY,
  readLegacyStatusSnapshot,
  newestHomepageSnapshot,
  parseHomepageSnapshot,
  parseStatusSnapshot,
  readHomepageSnapshot,
  snapshotUpdatedAt,
  writeHomepageSnapshot,
} from '../../web/src/api/public-snapshot';
import type { PublicHomepageResponse } from '../../web/src/api/types';

const now = 1_800_000_000_000;
const snapshot = (age = 0) =>
  ({
    generated_at: (now - age) / 1000,
    bootstrap_mode: 'full',
    monitor_count_total: 0,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto',
    site_timezone: 'UTC',
    uptime_rating_level: 3,
    overall_status: 'unknown',
    monitors: [],
    banner: { source: 'monitors', status: 'unknown', title: 'No monitors' },
    summary: { up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  }) as PublicHomepageResponse;

describe('public snapshot freshness', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves full payload validation and display-URL normalization without changing source data', async () => {
    const f = createSqliteD1();
    try {
      f.sqlite
        .prepare(
          "INSERT INTO monitors(id,name,type,target)VALUES(1,'API','http','https://example.com')",
        )
        .run();
      const home = await computePublicHomepagePayload(f.db, now / 1000);
      const status = await computePublicStatusPayload(f.db, now / 1000);
      expect(parseHomepageSnapshot(home)).toEqual(originalHome.parse(home));
      expect(parseStatusSnapshot(status)).toEqual(originalStatus.parse(status));
      const badUrl = {
        ...home,
        monitors: home.monitors.map((m) => ({ ...m, display_url: 'relative/invalid' })),
      };
      expect(parseHomepageSnapshot(badUrl)).toEqual(originalHome.parse(badUrl));
      expect(badUrl.monitors[0]!.display_url).toBe('relative/invalid');
      const invalid = {
        ...home,
        monitors: home.monitors.map((m) => ({
          ...m,
          heartbeat_strip: { ...m.heartbeat_strip, latency_ms: ['invalid'] },
        })),
      };
      expect(parseHomepageSnapshot(invalid)).toBeNull();
      expect(originalHome.safeParse(invalid).success).toBe(false);
    } finally {
      f.sqlite.close();
    }
  });
  it('rejects an ancient snapshot even when its cache write time is recent', () => {
    localStorage.setItem(
      HOMEPAGE_STORAGE_KEY,
      JSON.stringify({ at: now, value: snapshot(600_001) }),
    );
    expect(readHomepageSnapshot()).toBeNull();
  });
  it('does not rejuvenate persisted data when it is read or written again', () => {
    const data = snapshot(120_000);
    writeHomepageSnapshot(data);
    expect(readHomepageSnapshot()).toEqual(data);
    expect(JSON.parse(localStorage.getItem(HOMEPAGE_STORAGE_KEY)!).at).toBe(now - 120_000);
    expect(snapshotUpdatedAt(data)).toBe(now - 120_000);
  });
  it('chooses newer persisted data over an older injected artifact and rejects invalid future times', () => {
    expect(newestHomepageSnapshot(snapshot(60_000), snapshot(5_000))).toEqual(snapshot(5_000));
    expect(newestHomepageSnapshot(snapshot(-61_000), snapshot(5_000))).toEqual(snapshot(5_000));
    expect(snapshotUpdatedAt(snapshot(-10_000))).toBe(now);
  });
  it.each([null, { ...snapshot(), monitors: [{}] }, { ...snapshot(), maintenance_windows: null }])(
    'ignores malformed persisted or injected snapshots: %j',
    (value) => {
      localStorage.setItem(HOMEPAGE_STORAGE_KEY, JSON.stringify({ at: now, value }));
      localStorage.setItem(LEGACY_STATUS_STORAGE_KEY, JSON.stringify({ at: now, value }));
      expect(readHomepageSnapshot()).toBeNull();
      expect(readLegacyStatusSnapshot()).toBeNull();
      expect(newestHomepageSnapshot(value, snapshot(5_000))).toEqual(snapshot(5_000));
    },
  );
  it('uses the source time when migrating a legacy status cache', () => {
    localStorage.setItem(
      LEGACY_STATUS_STORAGE_KEY,
      JSON.stringify({ at: now, value: snapshot(601_000) }),
    );
    expect(readLegacyStatusSnapshot()).toBeNull();
    localStorage.setItem(
      LEGACY_STATUS_STORAGE_KEY,
      JSON.stringify({ at: now, value: snapshot(60_000) }),
    );
    expect(readLegacyStatusSnapshot()?.generated_at).toBe(snapshot(60_000).generated_at);
  });
  it('does not persist a malformed live response', async () => {
    const valid = snapshot(60_000);
    writeHomepageSnapshot(valid);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...valid, monitors: [{}] }))),
    );
    await expect(fetchHomepage()).rejects.toThrow('Invalid homepage response');
    expect(readHomepageSnapshot()).toEqual(valid);
  });
  it('always revalidates homepage instead of adding another in-memory freshness window', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot(5_000))));
    vi.stubGlobal('fetch', fetcher);
    await fetchHomepage();
    fetcher.mockResolvedValue(new Response(JSON.stringify(snapshot(1_000))));
    expect((await fetchHomepage()).generated_at).toBe(snapshot(1_000).generated_at);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1].cache).toBe('no-cache');
  });
  it('preserves data but records a failed refresh instead of treating saved data as a new success', async () => {
    const data = snapshot(60_000);
    queryClient.setQueryData(['homepage'], data, { updatedAt: now - 60_000 });
    writeHomepageSnapshot(data);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const observer = new QueryObserver(queryClient, {
      queryKey: ['homepage'],
      queryFn: () => fetchHomepage(),
      retry: false,
    });
    const result = await observer.refetch();
    expect(result.isRefetchError).toBe(true);
    expect(result.data).toEqual(data);
    expect(result.dataUpdatedAt).toBe(now - 60_000);
    observer.destroy();
  });
  it('keeps authorized public responses out of the browser HTTP cache', async () => {
    localStorage.setItem('admin_token', 'synthetic-test-token');
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/latency')
                ? { points: { checked_at: [], status_codes: '', latency_ms: [] } }
                : snapshot(),
            ),
          ),
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await fetchHomepage();
    await fetchLatency(1);
    expect(fetcher.mock.calls.every((call) => call[1].cache === 'no-store')).toBe(true);
  });
  it('passes cancellation through to latency requests and preserves every point', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          points: { checked_at: [60, 120, 180], status_codes: 'udx', latency_ms: [42, null, 200] },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const data = await fetchLatency(1, '24h', controller.signal);
    expect(data.points).toEqual([
      { checked_at: 60, status: 'up', latency_ms: 42 },
      { checked_at: 120, status: 'down', latency_ms: null },
      { checked_at: 180, status: 'unknown', latency_ms: 200 },
    ]);
    expect(fetcher.mock.calls[0]?.[1].signal).toBe(controller.signal);
    expect(fetcher.mock.calls[0]?.[1].cache).toBe('no-cache');
  });
});
