import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { computePublicStatusPayload } = vi.hoisted(() => ({
  computePublicStatusPayload: vi.fn(),
}));

vi.mock('../src/public/status', () => ({
  computePublicStatusPayload,
}));

import type { Env } from '../src/env';
import { handleError, handleNotFound } from '../src/middleware/errors';
import { publicRoutes } from '../src/routes/public';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function installCacheMock() {
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: vi.fn(async () => ({
        async match() {
          return undefined;
        },
        async put() {
          return undefined;
        },
      })),
    },
  });
}

function sampleArtifactSnapshot(now = 190) {
  return {
    generated_at: now,
    bootstrap_mode: 'full' as const,
    monitor_count_total: 40,
    site_title: 'Status Hub',
    site_description: 'Production services',
    site_locale: 'en' as const,
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
      up: 40,
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
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

function sampleRender(now = 190) {
  const snapshot = sampleArtifactSnapshot(now);
  return {
    generated_at: snapshot.generated_at,
    preload_html: '<div id="uptimer-preload"></div>',
    snapshot_json: JSON.stringify(snapshot),
    meta_title: snapshot.site_title,
    meta_description: snapshot.banner.title,
  };
}

async function requestHomepage(handlers: FakeD1QueryHandler[], waitUntil = vi.fn()) {
  installCacheMock();

  const env = {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.route('/api/v1/public', publicRoutes);

  const res = await app.fetch(
    new Request('https://status.example.com/api/v1/public/homepage'),
    env,
    { waitUntil } as unknown as ExecutionContext,
  );

  return { res, waitUntil };
}

describe('public homepage fallback semantics', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    }

    vi.restoreAllMocks();
    computePublicStatusPayload.mockReset();
  });

  it('does not mask a newly unknown homepage behind a recent artifact snapshot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(260_000);
    let statusSnapshotWrites = 0;
    computePublicStatusPayload.mockResolvedValue({
      generated_at: 260,
      site_title: 'Status Hub',
      site_description: 'Production services',
      site_locale: 'en',
      site_timezone: 'UTC',
      uptime_rating_level: 3,
      overall_status: 'unknown',
      banner: {
        source: 'monitors',
        status: 'unknown',
        title: 'Status Unknown',
      },
      summary: {
        up: 0,
        down: 0,
        maintenance: 0,
        paused: 0,
        unknown: 40,
      },
      monitors: [],
      active_incidents: [],
      maintenance_windows: {
        active: [],
        upcoming: [],
      },
    });

    const { res } = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: 190,
              body_json: JSON.stringify(sampleRender(190)),
            };
          }
          return null;
        },
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
      {
        match: 'insert into public_snapshots',
        run: () => {
          statusSnapshotWrites += 1;
          return 1;
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generated_at: 260,
      overall_status: 'unknown',
      banner: {
        status: 'unknown',
      },
      summary: {
        unknown: 40,
      },
    });
    expect(computePublicStatusPayload).toHaveBeenCalledOnce();
    expect(statusSnapshotWrites).toBe(1);
  });

  it('still upgrades to computed homepage data when the live status payload is healthy', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(260_000);
    let statusSnapshotWrites = 0;
    computePublicStatusPayload.mockResolvedValue({
      generated_at: 260,
      site_title: 'Status Hub',
      site_description: 'Production services',
      site_locale: 'en',
      site_timezone: 'UTC',
      uptime_rating_level: 3,
      overall_status: 'up',
      banner: {
        source: 'monitors',
        status: 'operational',
        title: 'All Systems Operational',
        down_ratio: null,
      },
      summary: {
        up: 40,
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
    });

    const { res } = await requestHomepage([
      {
        match: 'from public_snapshots',
        first: (args) => {
          if (args[0] === 'homepage:artifact') {
            return {
              generated_at: 190,
              body_json: JSON.stringify(sampleRender(190)),
            };
          }
          return null;
        },
      },
      {
        match: 'insert into public_snapshots',
        run: () => {
          statusSnapshotWrites += 1;
          return 1;
        },
      },
      {
        match: 'from incidents',
        all: () => [],
      },
      {
        match: 'from maintenance_windows',
        all: () => [],
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generated_at: 260,
      bootstrap_mode: 'full',
      overall_status: 'up',
      banner: {
        status: 'operational',
      },
      summary: {
        unknown: 0,
      },
    });
    expect(computePublicStatusPayload).toHaveBeenCalledOnce();
    expect(statusSnapshotWrites).toBe(1);
  });
});
