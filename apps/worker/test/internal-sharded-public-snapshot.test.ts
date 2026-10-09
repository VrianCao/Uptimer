import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import worker from '../src/index';
import { HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY } from '../src/snapshots/public-homepage';
import {
  buildHomepageEnvelopeFragmentWrite,
  buildHomepageMonitorFragmentWrites,
  buildStatusEnvelopeFragmentWrite,
  buildStatusMonitorFragmentWrites,
  HOMEPAGE_ENVELOPE_FRAGMENT_KEY,
  HOMEPAGE_MONITOR_FRAGMENTS_KEY,
  STATUS_ENVELOPE_FRAGMENT_KEY,
  STATUS_MONITOR_FRAGMENTS_KEY,
} from '../src/snapshots/public-monitor-fragments';
import { createFakeD1Database } from './helpers/fake-d1';

function toRow(write: {
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
}) {
  return {
    fragment_key: write.fragmentKey,
    generated_at: write.generatedAt,
    body_json: write.bodyJson,
    updated_at: write.updatedAt,
  };
}

function statusPayload() {
  return {
    generated_at: 1_700_000_000,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: { up: 1, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    monitors: [
      {
        id: 1,
        name: 'API',
        type: 'http' as const,
        group_name: null,
        group_sort_order: 0,
        sort_order: 1,
        uptime_rating_level: 4 as const,
        status: 'up' as const,
        is_stale: false,
        last_checked_at: 1_700_000_000,
        last_latency_ms: 42,
        heartbeats: [{ checked_at: 1_700_000_000, status: 'up' as const, latency_ms: 42 }],
        uptime_30d: {
          range_start_at: 1_697_408_000,
          range_end_at: 1_700_000_000,
          total_sec: 2_592_000,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 2_592_000,
          uptime_pct: 100,
        },
        uptime_days: [
          {
            day_start_at: 1_699_920_000,
            total_sec: 86_400,
            downtime_sec: 0,
            unknown_sec: 0,
            uptime_sec: 86_400,
            uptime_pct: 100,
          },
        ],
      },
    ],
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
  };
}

function homepagePayload() {
  return {
    generated_at: 1_700_000_000,
    bootstrap_mode: 'full' as const,
    monitor_count_total: 1,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: { up: 1, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    monitors: [
      {
        id: 1,
        name: 'API',
        type: 'http' as const,
        group_name: null,
        status: 'up' as const,
        is_stale: false,
        last_checked_at: 1_700_000_000,
        heartbeat_strip: {
          checked_at: [1_700_000_000],
          status_codes: 'u',
          latency_ms: [42],
        },
        uptime_30d: { uptime_pct: 100 },
        uptime_day_strip: {
          day_start_at: [1_699_920_000],
          downtime_sec: [0],
          unknown_sec: [0],
          uptime_pct_milli: [100_000],
        },
      },
    ],
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

function createFragmentEnv(extraHandlers: Parameters<typeof createFakeD1Database>[0] = []): Env {
  const statusEnvelope = buildStatusEnvelopeFragmentWrite(statusPayload(), 1_700_000_005);
  const statusMonitors = buildStatusMonitorFragmentWrites(statusPayload(), 1_700_000_005);
  const homepageEnvelope = buildHomepageEnvelopeFragmentWrite(homepagePayload(), 1_700_000_005);
  const homepageMonitors = buildHomepageMonitorFragmentWrites(homepagePayload(), 1_700_000_005);

  return {
    DB: createFakeD1Database([
      {
        match: 'from public_snapshot_fragments',
        all: (args) => {
          switch (args[0]) {
            case STATUS_ENVELOPE_FRAGMENT_KEY:
              return [toRow(statusEnvelope)];
            case STATUS_MONITOR_FRAGMENTS_KEY:
              return statusMonitors.map(toRow);
            case HOMEPAGE_ENVELOPE_FRAGMENT_KEY:
              return [toRow(homepageEnvelope)];
            case HOMEPAGE_MONITOR_FRAGMENTS_KEY:
              return homepageMonitors.map(toRow);
            default:
              return [];
          }
        },
      },
      ...extraHandlers,
    ]),
    ADMIN_TOKEN: 'test-admin-token',
    UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '1',
  } as unknown as Env;
}

describe('internal sharded public snapshot assembler route', () => {
  it('is hidden unless the feature flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('assembles homepage fragments and reports bounded metadata', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', measure_body_bytes: true }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'homepage',
      assembly: 'validated',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
      body_bytes: expect.any(Number),
    });
  });

  it('assembles status fragments and reports bounded metadata', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status' }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      assembled: true,
      kind: 'status',
      assembly: 'validated',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
    });
  });

  it('reports internal assembly errors with bounded diagnostics', async () => {
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: () => {
            throw new Error('fragment read failed');
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status', assembly: 'json' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      assembled: false,
      kind: 'status',
      assembly: 'json',
      error: true,
      error_name: 'Error',
      error_message: 'fragment read failed',
    });
  });

  it('publishes raw assembled JSON to the static snapshot row when explicitly requested and enabled', async () => {
    const writes: unknown[][] = [];
    const env = {
      ...createFragmentEnv([
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status', assembly: 'json', publish: true }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'status',
      assembly: 'json',
      published: true,
      write_count: 1,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('status');
    expect(writes[0]![1]).toBe(1_700_000_000);
    expect(typeof writes[0]![2]).toBe('string');
  });

  it('publishes the homepage artifact row with preload HTML when publishing homepage JSON', async () => {
    const writes: unknown[][] = [];
    const env = {
      ...createFragmentEnv([
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', assembly: 'json', publish: true }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'homepage',
      assembly: 'json',
      published: true,
      artifact_published: true,
      write_count: 2,
    });
    expect(writes.map((args) => args[0])).toEqual(['homepage', 'homepage:artifact']);
    const artifact = JSON.parse(writes[1]![2] as string) as {
      preload_html?: string;
      snapshot?: unknown;
    };
    expect(artifact.preload_html).toContain('uptimer-preload');
    expect(artifact.snapshot).toMatchObject({ generated_at: 1_700_000_000 });
  });

  it('publishes homepage artifact from pre-rendered monitor fragments when enabled', async () => {
    const writes: unknown[][] = [];
    const homepage = homepagePayload();
    const homepageEnvelope = buildHomepageEnvelopeFragmentWrite(homepage, 1_700_000_005);
    const homepageMonitors = buildHomepageMonitorFragmentWrites(homepage, 1_700_000_005);
    const artifactRow = {
      fragment_key: 'monitor:1',
      generated_at: homepage.generated_at,
      body_json: JSON.stringify({
        id: 1,
        name: 'API',
        group_name: null,
        card_html: '<article class="card">PRE-RENDERED API</article>',
      }),
      updated_at: 1_700_000_005,
    };
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: (args) => {
            switch (args[0]) {
              case HOMEPAGE_ENVELOPE_FRAGMENT_KEY:
                return [toRow(homepageEnvelope)];
              case HOMEPAGE_MONITOR_FRAGMENTS_KEY:
                return homepageMonitors.map(toRow);
              case HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY:
                return [artifactRow];
              default:
                return [];
            }
          },
        },
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '1',
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
      UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', assembly: 'json', publish: true }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      artifact_published: true,
      write_count: 2,
    });
    expect(writes.map((args) => args[0])).toEqual(['homepage', 'homepage:artifact']);
    const artifact = JSON.parse(writes[1]![2] as string) as {
      preload_html?: string;
      snapshot?: unknown;
    };
    expect(artifact.preload_html).toContain('PRE-RENDERED API');
    expect(artifact.snapshot).toMatchObject({ generated_at: homepage.generated_at });
  });

  it('skips homepage artifact publish when pre-rendered monitor fragments are incomplete', async () => {
    const writes: unknown[][] = [];
    const homepage = homepagePayload();
    const homepageEnvelope = buildHomepageEnvelopeFragmentWrite(homepage, 1_700_000_005);
    const homepageMonitors = buildHomepageMonitorFragmentWrites(homepage, 1_700_000_005);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: (args) => {
            switch (args[0]) {
              case HOMEPAGE_ENVELOPE_FRAGMENT_KEY:
                return [toRow(homepageEnvelope)];
              case HOMEPAGE_MONITOR_FRAGMENTS_KEY:
                return homepageMonitors.map(toRow);
              case HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY:
                return [];
              default:
                return [];
            }
          },
        },
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '1',
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
      UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', assembly: 'json', publish: true }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      published: true,
      artifact_published: false,
      write_count: 1,
    });
    expect(writes.map((args) => args[0])).toEqual(['homepage']);
  });

  it('assembles fragment JSON without parsing every monitor when requested', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', assembly: 'json', measure_body_bytes: true }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'homepage',
      assembly: 'json',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
      body_bytes: expect.any(Number),
    });
  });
});

describe('internal sharded public snapshot continuation route', () => {
  it('is hidden unless the continuation flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ step: 'assemble', kind: 'homepage' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('runs the runtime step and queues homepage/status branches in parallel', async () => {
    const selfRequests: Request[] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: () => [],
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH: '1',
      UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE: '2',
      SELF: {
        fetch: vi.fn(async (request: Request) => {
          selfRequests.push(request);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      },
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ step: 'runtime' }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'runtime',
      refreshed: false,
      continued: true,
      next_steps: [
        { step: 'seed', kind: 'homepage', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
        { step: 'seed', kind: 'status', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
      ],
    });
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    await expect(Promise.all(selfRequests.map((request) => request.json()))).resolves.toEqual([
      { step: 'seed', kind: 'homepage', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
      { step: 'seed', kind: 'status', part: 'envelope', monitor_offset: 0, monitor_limit: 2 },
    ]);
  });

  it('runs one paged runtime update step before queuing the next runtime page', async () => {
    const selfRequests: Request[] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: (args) => {
            expect(args).toEqual(['monitor-runtime:updates', 2, 0]);
            return [
              {
                fragment_key: 'monitor:1',
                generated_at: 1,
                body_json: '[1,60,1,1,"up","up",21]',
                updated_at: 1,
              },
              {
                fragment_key: 'monitor:2',
                generated_at: 1,
                body_json: '[2,60,1,1,"up","up",22]',
                updated_at: 1,
              },
            ];
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH: '1',
      UPTIMER_SHARDED_RUNTIME_UPDATE_BATCH_SIZE: '1',
      SELF: {
        fetch: vi.fn(async (request: Request) => {
          selfRequests.push(request);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      },
    } as unknown as Env;
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ step: 'runtime' }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      step: 'runtime',
      refreshed: false,
      continued: true,
      monitor_count: 0,
      update_offset: 0,
      update_limit: 1,
      row_count: 1,
      has_more: true,
      skipped: 'no_updates',
      next_steps: [{ step: 'runtime', update_offset: 1, update_limit: 1 }],
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    await expect(selfRequests[0]!.json()).resolves.toEqual({
      step: 'runtime',
      update_offset: 1,
      update_limit: 1,
    });
  });

  it('emits bounded continuation diagnostics when explicitly enabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = {
      DB: createFakeD1Database([
        {
          match: 'from public_snapshot_fragments',
          all: () => [],
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH: '1',
      UPTIMER_SHARDED_CONTINUATION_DIAGNOSTICS: '1',
    } as unknown as Env;

    try {
      const res = await worker.fetch(
        new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-admin-token',
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ step: 'runtime' }),
        }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        step: 'runtime',
        refreshed: false,
        continued: false,
        diagnostic_step: 'runtime',
        operation_ms: expect.any(Number),
        queue_ms: expect.any(Number),
        total_ms: expect.any(Number),
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('sharded_continuation_step step=runtime'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skipped=no_updates'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('runs one bounded seed step and queues the next continuation', async () => {
    const writes: unknown[][] = [];
    const generatedAt = Math.floor(Date.now() / 1000);
    const payload = { ...statusPayload(), generated_at: generatedAt };
    const selfRequests: Request[] = [];
    const waitUntil = vi.fn();
    const continuationResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const continuationBodyRead = vi.spyOn(continuationResponse, 'text');
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) => sql.includes('from public_snapshots') && !sql.includes('body_json'),
          first: () => ({ generated_at: payload.generated_at, updated_at: payload.generated_at }),
        },
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: () => ({
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          }),
        },
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return 1;
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
      UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED: '1',
      SELF: {
        fetch: vi.fn(async (request: Request) => {
          selfRequests.push(request);
          return continuationResponse;
        }),
      },
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          step: 'seed',
          kind: 'status',
          part: 'monitors',
          monitor_offset: 0,
          monitor_limit: 1,
        }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'seed',
      seeded: true,
      kind: 'status',
      part: 'monitors',
      monitor_count: 1,
      monitor_offset: 0,
      monitor_limit: 1,
      write_count: 1,
      continued: true,
      next_step: { step: 'assemble', kind: 'status' },
    });
    expect(writes).toHaveLength(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(selfRequests).toHaveLength(1);
    expect(continuationBodyRead).toHaveBeenCalledTimes(1);
    expect(new URL(selfRequests[0]!.url).pathname).toBe(
      '/api/v1/internal/continue/sharded-public-snapshot',
    );
    await expect(selfRequests[0]!.json()).resolves.toEqual({
      step: 'assemble',
      kind: 'status',
    });
  });

  it('publishes homepage JSON in assemble and queues artifact publishing separately', async () => {
    const writes: unknown[][] = [];
    const selfRequests: Request[] = [];
    const waitUntil = vi.fn();
    const continuationResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const continuationBodyRead = vi.spyOn(continuationResponse, 'text');
    const env = {
      ...createFragmentEnv([
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_SCHEDULED_SHARDED_ASSEMBLER: '1',
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
      UPTIMER_SCHEDULED_SHARDED_PUBLISH: '1',
      UPTIMER_SHARDED_ASSEMBLER_MODE: 'json',
      SELF: {
        fetch: vi.fn(async (request: Request) => {
          selfRequests.push(request);
          return continuationResponse;
        }),
      },
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ step: 'assemble', kind: 'homepage' }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'assemble',
      assembled: true,
      kind: 'homepage',
      generated_at: 1_700_000_000,
      published: true,
      write_count: 1,
      continued: true,
      next_step: { step: 'artifact', kind: 'homepage', generated_at: 1_700_000_000 },
    });
    expect(writes.map((args) => args[0])).toEqual(['homepage']);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(continuationBodyRead).toHaveBeenCalledTimes(1);
    await expect(selfRequests[0]!.json()).resolves.toEqual({
      step: 'artifact',
      kind: 'homepage',
      generated_at: 1_700_000_000,
    });
  });

  it('publishes the homepage artifact in a separate continuation step', async () => {
    const payload = homepagePayload();
    const writes: unknown[][] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) =>
            sql.includes('select generated_at from public_snapshots') && !sql.includes('body_json'),
          first: (args) => (args[0] === 'homepage' ? { generated_at: payload.generated_at } : null),
        },
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: (args) => {
            expect(args).toEqual(['homepage']);
            return {
              generated_at: payload.generated_at,
              body_json: JSON.stringify(payload),
            };
          },
        },
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
      UPTIMER_SCHEDULED_SHARDED_PUBLISH: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          step: 'artifact',
          kind: 'homepage',
          generated_at: payload.generated_at,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'artifact',
      kind: 'homepage',
      generated_at: payload.generated_at,
      published: true,
      artifact_published: true,
      write_count: 1,
      continued: false,
    });
    expect(writes.map((args) => args[0])).toEqual(['homepage:artifact']);
    const artifact = JSON.parse(writes[0]![2] as string) as {
      preload_html?: string;
      snapshot?: unknown;
    };
    expect(artifact.preload_html).toContain('uptimer-preload');
    expect(artifact.snapshot).toMatchObject({ generated_at: payload.generated_at });
  });

  it('touches the artifact row when the artifact is already current', async () => {
    const payload = homepagePayload();
    const inserts: unknown[][] = [];
    const touches: unknown[][] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) =>
            sql.includes('select generated_at from public_snapshots') && !sql.includes('body_json'),
          first: (args) => {
            if (args[0] === 'homepage') return { generated_at: payload.generated_at };
            if (args[0] === 'homepage:artifact') return { generated_at: payload.generated_at };
            return null;
          },
        },
        {
          match: 'update public_snapshots set updated_at',
          run: (args) => {
            touches.push(args);
            return { meta: { changes: 1 } };
          },
        },
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            inserts.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: '1',
      UPTIMER_SCHEDULED_SHARDED_PUBLISH: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          step: 'artifact',
          kind: 'homepage',
          generated_at: payload.generated_at,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'artifact',
      kind: 'homepage',
      generated_at: payload.generated_at,
      published: false,
      artifact_published: false,
      write_count: 1,
      skipped: 'current_artifact',
      continued: false,
    });
    expect(touches).toHaveLength(1);
    expect(touches[0]?.slice(0, 2)).toEqual(['homepage:artifact', payload.generated_at]);
    expect(inserts).toHaveLength(0);
  });
});

describe('internal sharded public snapshot fragment seed route', () => {
  it('is hidden unless the seed flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status', part: 'envelope' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('seeds homepage artifact monitor fragments behind the artifact flag', async () => {
    const writes: unknown[][] = [];
    const generatedAt = Math.floor(Date.now() / 1000);
    const payload = { ...homepagePayload(), generated_at: generatedAt };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: () => ({
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          }),
        },
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return 1;
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
      UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          kind: 'homepage',
          part: 'monitors',
          monitor_offset: 0,
          monitor_limit: 1,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      seeded: true,
      kind: 'homepage',
      part: 'monitors',
      generated_at: payload.generated_at,
      monitor_count: 1,
      monitor_offset: 0,
      monitor_limit: 1,
      write_count: 2,
    });
    expect(writes.map((args) => [args[0], args[1]])).toEqual([
      [HOMEPAGE_MONITOR_FRAGMENTS_KEY, 'monitor:1'],
      [HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY, 'monitor:1'],
    ]);
    const artifactBody = JSON.parse(writes[1]![3] as string) as { card_html?: string };
    expect(artifactBody.card_html).toContain('Availability (60d)');
  });

  it('seeds bounded status fragments from the current static snapshot', async () => {
    const writes: unknown[][] = [];
    const generatedAt = Math.floor(Date.now() / 1000);
    const payload = { ...statusPayload(), generated_at: generatedAt };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) => sql.includes('from public_snapshots') && !sql.includes('body_json'),
          first: () => ({ generated_at: payload.generated_at, updated_at: payload.generated_at }),
        },
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: () => ({
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          }),
        },
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return 1;
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          kind: 'status',
          part: 'all',
          monitor_offset: 0,
          monitor_limit: 1,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      seeded: true,
      kind: 'status',
      part: 'all',
      generated_at: payload.generated_at,
      monitor_count: 1,
      monitor_offset: 0,
      monitor_limit: 1,
      write_count: 2,
    });
    expect(writes).toHaveLength(2);
    expect(writes.map((args) => [args[0], args[1]])).toEqual([
      [STATUS_ENVELOPE_FRAGMENT_KEY, 'envelope'],
      [STATUS_MONITOR_FRAGMENTS_KEY, 'monitor:1'],
    ]);
  });
});
