import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  readSettings: vi.fn(),
}));

import type { Env } from '../src/env';
import { readSettings } from '../src/settings';
import { acquireLease } from '../src/scheduler/lock';
import { runRetention } from '../src/scheduler/retention';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createEnv(handlers: FakeD1QueryHandler[]): Env {
  return {
    DB: createFakeD1Database([
      ...handlers,
      { match: 'check_result_buckets', run: () => 0 },
      { match: 'update monitor_state', run: () => 0 },
    ]),
  } as unknown as Env;
}

describe('scheduler/retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:00:00.000Z'));
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: 7,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips deletion when lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);
    const runCalls: unknown[][] = [];
    const env = createEnv([
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: Date.now() } as ScheduledController);

    expect(readSettings).not.toHaveBeenCalled();
    expect(runCalls).toHaveLength(0);
  });

  it('deletes in bounded batches until remaining rows are below the batch size', async () => {
    const deletes = [5000, 1200];
    const runCalls: unknown[][] = [];
    const env = createEnv([
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: deletes.shift() ?? 0 } };
        },
      },
    ]);

    const scheduledTime = Date.UTC(2026, 1, 18, 0, 0, 0);
    await runRetention(env, { scheduledTime } as ScheduledController);

    expect(acquireLease).toHaveBeenCalledWith(
      env.DB,
      'retention:check_results',
      Math.floor(scheduledTime / 1000),
      600,
    );
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.[1]).toBe(5000);
    expect(runCalls[1]?.[1]).toBe(5000);
  });

  it('guards against invalid cutoffs', async () => {
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: Number.POSITIVE_INFINITY,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });

    const runCalls: unknown[][] = [];
    const env = createEnv([
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: 1 } as ScheduledController);
    expect(runCalls).toHaveLength(0);
  });
});
