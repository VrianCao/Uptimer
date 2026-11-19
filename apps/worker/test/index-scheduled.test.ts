import { afterEach, describe, expect, it, vi } from 'vitest';

const { runDailyRollup, runRetention, runScheduledTick } = vi.hoisted(() => ({
  runDailyRollup: vi.fn(),
  runRetention: vi.fn(),
  runScheduledTick: vi.fn(),
}));

vi.mock('../src/scheduler/daily-rollup', () => ({
  runDailyRollup,
}));

vi.mock('../src/scheduler/retention', () => ({
  runRetention,
}));

vi.mock('../src/scheduler/scheduled', () => ({
  runScheduledTick,
}));

import worker from '../src/index';
import type { Env } from '../src/env';
import paidCrons from '../src/scheduler/paid-crons.json';

function createExecutionContext(): {
  ctx: ExecutionContext;
  waitUntil: ReturnType<typeof vi.fn>;
  waitUntilPromises: Promise<unknown>[];
} {
  const waitUntilPromises: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  });
  return {
    ctx: { waitUntil } as unknown as ExecutionContext,
    waitUntil,
    waitUntilPromises,
  };
}

describe('worker scheduled dispatch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches the original cron controller to the bound site coordinator', async () => {
    const scheduled = vi.fn().mockResolvedValue(undefined);
    const getByName = vi.fn().mockReturnValue({ scheduled });
    const env = { SELF: {}, COORDINATOR: { getByName } } as Env;
    const { ctx } = createExecutionContext();
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: 123000 } as ScheduledController,
      env,
      ctx,
    );
    expect(getByName).toHaveBeenCalledWith('site');
    expect(scheduled).toHaveBeenCalledWith({ cron: '* * * * *', scheduledTime: 123000 });
    expect(runScheduledTick).not.toHaveBeenCalled();
  });
  it('supports a bound coordinator without a Worker SELF service binding', async () => {
    const scheduled = vi.fn().mockResolvedValue(undefined);
    const getByName = vi.fn().mockReturnValue({ scheduled });
    const env = { COORDINATOR: { getByName } } as Env;
    const { ctx } = createExecutionContext();
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: 123000 } as ScheduledController,
      env,
      ctx,
    );
    expect(scheduled).toHaveBeenCalledWith({ cron: '* * * * *', scheduledTime: 123000 });
    expect(runScheduledTick).not.toHaveBeenCalled();
  });
  it('runs only the minute scheduler for ordinary consolidated cron ticks', async () => {
    const controller = {
      cron: '* * * * *',
      scheduledTime: Date.UTC(2026, 1, 18, 0, 1, 0),
    } as ScheduledController;
    const env = {} as Env;
    const { ctx, waitUntil } = createExecutionContext();

    await worker.scheduled(controller, env, ctx);

    expect(runScheduledTick).toHaveBeenCalledWith(env, ctx);
    expect(runDailyRollup).not.toHaveBeenCalled();
    expect(runRetention).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each(paidCrons)(
    'runs an independent Paid lane without repeating midnight maintenance: %s',
    async (cron) => {
      const env = { UPTIMER_RUNTIME_PROFILE: 'paid' } as Env;
      const { ctx, waitUntil } = createExecutionContext();
      await worker.scheduled(
        { cron, scheduledTime: Date.UTC(2026, 10, 4, 0) } as ScheduledController,
        env,
        ctx,
      );
      expect(runScheduledTick).toHaveBeenCalledWith(
        env,
        ctx,
        `scheduler:paid-lane:${paidCrons.indexOf(cron) + 1}`,
      );
      expect(runDailyRollup).not.toHaveBeenCalled();
      expect(runRetention).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    },
  );

  it('queues daily rollup at UTC midnight on the consolidated minute cron', async () => {
    const controller = {
      cron: '* * * * *',
      scheduledTime: Date.UTC(2026, 1, 18, 0, 0, 0),
    } as ScheduledController;
    const env = {} as Env;
    const { ctx, waitUntil, waitUntilPromises } = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(runScheduledTick).toHaveBeenCalledWith(env, ctx);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(runDailyRollup).toHaveBeenCalledWith(env, controller, ctx);
    expect(runRetention).not.toHaveBeenCalled();
  });

  it('queues retention at UTC 00:30 on the consolidated minute cron', async () => {
    const controller = {
      cron: '* * * * *',
      scheduledTime: Date.UTC(2026, 1, 18, 0, 30, 0),
    } as ScheduledController;
    const env = {} as Env;
    const { ctx, waitUntil, waitUntilPromises } = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(runScheduledTick).toHaveBeenCalledWith(env, ctx);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(runRetention).toHaveBeenCalledWith(env, controller);
    expect(runDailyRollup).not.toHaveBeenCalled();
  });

  it('keeps the legacy daily rollup cron compatible during trigger propagation', async () => {
    const controller = {
      cron: '0 0 * * *',
      scheduledTime: Date.UTC(2026, 1, 18, 0, 0, 0),
    } as ScheduledController;
    const env = {} as Env;
    const { ctx, waitUntil, waitUntilPromises } = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(runDailyRollup).toHaveBeenCalledWith(env, controller, ctx);
    expect(runRetention).not.toHaveBeenCalled();
    expect(runScheduledTick).not.toHaveBeenCalled();
  });

  it('keeps the legacy retention cron compatible during trigger propagation', async () => {
    const controller = {
      cron: '30 0 * * *',
      scheduledTime: Date.UTC(2026, 1, 18, 0, 30, 0),
    } as ScheduledController;
    const env = {} as Env;
    const { ctx, waitUntil, waitUntilPromises } = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(runRetention).toHaveBeenCalledWith(env, controller);
    expect(runDailyRollup).not.toHaveBeenCalled();
    expect(runScheduledTick).not.toHaveBeenCalled();
  });
});
