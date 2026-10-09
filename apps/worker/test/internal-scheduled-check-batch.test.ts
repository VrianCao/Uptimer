import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/scheduled', () => ({
  runExclusivePersistedMonitorBatch: vi.fn(),
}));

import type { Env } from '../src/env';
import worker from '../src/index';
import { LeaseLostError } from '../src/scheduler/lease-guard';
import { runExclusivePersistedMonitorBatch } from '../src/scheduler/scheduled';
import { createFakeD1Database } from './helpers/fake-d1';

describe('internal runtime update fragment write route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('is hidden unless monitor update fragment writes are enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/write/runtime-update-fragments', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ runtime_updates: [] }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('writes compact monitor runtime update fragments behind the internal flag', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const writes: unknown[][] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/write/runtime-update-fragments', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          runtime_updates: [[1, 60, 1_776_230_000, 1_776_230_280, 'up', 'up', 21]],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      written: true,
      update_count: 1,
      write_count: 1,
    });
    expect(writes).toEqual([
      [
        'monitor-runtime:updates',
        'monitor:1',
        1_776_230_280,
        '[1,60,1776230000,1776230280,"up","up",21]',
        1_776_230_300,
      ],
    ]);
  });
});

describe('internal scheduled check-batch route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('rejects stale and future checked_at values even with a valid token', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-15T05:18:20.000Z').valueOf());

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const makeRequest = (checkedAt: number) =>
      worker.fetch(
        new Request('http://internal/api/v1/internal/scheduled/check-batch', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-admin-token',
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            token: 'test-admin-token',
            ids: [1],
            checked_at: checkedAt,
            state_failures_to_down_from_up: 2,
            state_successes_to_up_from_down: 2,
          }),
        }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );

    await expect(makeRequest(1_776_230_340)).resolves.toMatchObject({ status: 403 });
    await expect(makeRequest(1_776_229_920)).resolves.toMatchObject({ status: 403 });
  });

  it('accepts checked_at values that are a few minutes old for long-running ticks', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-15T05:18:20.000Z').valueOf());
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [],
      stats: {
        processedCount: 0,
        rejectedCount: 0,
        attemptTotal: 0,
        httpCount: 0,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 0,
      persistDurMs: 0,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_100,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(runExclusivePersistedMonitorBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        checkedAt: 1_776_230_100,
      }),
    );
  });

  it('returns compact runtime updates when requested by the scheduler service', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 1_776_230_000,
          checked_at: 1_776_230_280,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
      ],
      stats: {
        processedCount: 1,
        rejectedCount: 0,
        attemptTotal: 1,
        httpCount: 1,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Internal-Format': 'compact-v1',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      runtime_updates: [[1, 60, 1_776_230_000, 1_776_230_280, 'up', 'up', 21]],
      processed_count: 1,
      checks_duration_ms: 4,
      persist_duration_ms: 2,
    });
  });

  it('queues compact runtime update fragment writes when enabled', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 1_776_230_000,
          checked_at: 1_776_230_280,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
      ],
      stats: {
        processedCount: 1,
        rejectedCount: 0,
        attemptTotal: 1,
        httpCount: 1,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });
    const writes: unknown[][] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      DB: createFakeD1Database([
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);
    expect(writes).toEqual([
      [
        'monitor-runtime:updates',
        'monitor:1',
        1_776_230_280,
        '[1,60,1776230000,1776230280,"up","up",21]',
        1_776_230_300,
      ],
    ]);
  });

  it('awaits fragment writes and omits runtime updates when fragment-only mode is requested', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 1_776_230_000,
          checked_at: 1_776_230_280,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
      ],
      stats: {
        processedCount: 1,
        rejectedCount: 0,
        attemptTotal: 1,
        httpCount: 1,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });
    const writes: unknown[][] = [];
    const waitUntil = vi.fn();
    const env = {
      DB: createFakeD1Database([
        {
          match: 'insert into public_snapshot_fragments',
          run: async (args) => {
            writes.push(args);
            return { meta: { changes: 1 } };
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Internal-Format': 'compact-v1',
          'X-Uptimer-Runtime-Fragments-Only': '1',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      runtime_updates: [],
      runtime_updates_fragmented: true,
      processed_count: 1,
    });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(writes).toEqual([
      [
        'monitor-runtime:updates',
        'monitor:1',
        1_776_230_280,
        '[1,60,1776230000,1776230280,"up","up",21]',
        1_776_230_300,
      ],
    ]);
  });

  it('passes trusted scheduler lease mode behind the internal flag', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [],
      stats: {
        processedCount: 1,
        rejectedCount: 0,
        attemptTotal: 1,
        httpCount: 1,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(runExclusivePersistedMonitorBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        trustSchedulerLease: true,
      }),
    );
  });

  it('emits bounded check-batch diagnostics when explicitly enabled', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [],
      stats: {
        processedCount: 2,
        rejectedCount: 0,
        attemptTotal: 2,
        httpCount: 1,
        tcpCount: 1,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_INTERNAL_CHECK_BATCH_DIAGNOSTICS: '1',
    } as unknown as Env;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const res = await worker.fetch(
        new Request('http://internal/api/v1/internal/scheduled/check-batch', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-admin-token',
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            token: 'test-admin-token',
            ids: [1, 2],
            checked_at: 1_776_230_280,
            state_failures_to_down_from_up: 2,
            state_successes_to_up_from_down: 2,
          }),
        }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );

      expect(res.status).toBe(200);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('internal_check_batch ids=2'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('processed=2'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('run_ms='));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('stringify_ms='));
    } finally {
      log.mockRestore();
    }
  });

  it('emits trace headers and logs for scheduled check batches with a valid trace token', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(runExclusivePersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [],
      stats: {
        processedCount: 0,
        rejectedCount: 0,
        attemptTotal: 0,
        httpCount: 0,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 0,
      persistDurMs: 0,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_TRACE_TOKEN: 'trace-token',
    } as unknown as Env;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Id': 'batch-trace-id',
          'X-Uptimer-Trace-Mode': 'scheduled',
          'X-Uptimer-Trace-Token': 'trace-token',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1, 2],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Uptimer-Trace-Id')).toBe('batch-trace-id');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('route=internal/scheduled-check-batch');
    expect(res.headers.get('X-Uptimer-Trace')).toContain('ids=2');
    expect(res.headers.get('Server-Timing')).toContain('w_check_batch_run');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('internal-check-batch:'));
  });

  it('rejects non-internal hosts before method checks', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/internal/scheduled/check-batch', {
        method: 'GET',
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found',
      },
    });
  });

  it('rejects invalid Authorization before invoking batch persistence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-15T05:18:20.000Z').valueOf());

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          token: 'wrong-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(403);
    expect(runExclusivePersistedMonitorBatch).not.toHaveBeenCalled();
  });

  it('returns 503 no-store when the batch lease is lost mid-request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-15T05:18:20.000Z').valueOf());
    vi.mocked(runExclusivePersistedMonitorBatch).mockRejectedValue(
      new LeaseLostError('scheduled batch lease lost'),
    );

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await expect(res.text()).resolves.toContain('Service Unavailable');
  });
});
