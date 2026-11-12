import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/monitor/http', () => ({ runHttpCheck: vi.fn() }));
import { runHttpCheck } from '../src/monitor/http';
import worker from '../src/index';
import paidCrons from '../src/scheduler/paid-crons.json';
import { runExclusivePersistedMonitorBatch } from '../src/scheduler/scheduled';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';
import { computePublicHomepagePayload } from '../src/public/homepage';

const profile = Object.fromEntries(
  [
    ...readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').matchAll(
      /^(UPTIMER_\w+) = "([^"]*)"/gm,
    ),
  ].map((m) => [m[1], m[2]]),
);
const stateMachineConfig = { failuresToDownFromUp: 2, successesToUpFromDown: 2 };

describe('independent Paid Cron lanes', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { jitter: 0, self: true },
    { jitter: 2000, self: true },
    { jitter: 0, self: false },
  ])('keeps healthy monitors fresh behind 25 slow targets (%o)', async ({ jitter, self }) => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 10, 4, 12);
    vi.setSystemTime(start);
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => undefined, put: async () => undefined }),
    });
    const f = createSqliteD1();
    const laneContext = new AsyncLocalStorage<number>();
    const inFlight = new Map<number, number>();
    const maximum = new Map<number, number>();
    const starts = new Map<number, number>();
    vi.mocked(runHttpCheck)
      .mockReset()
      .mockImplementation(async (config) => {
        const id = Number(new URL(config.url).pathname.slice(1));
        const lane = laneContext.getStore()!;
        expect(starts.has(id), `duplicate check ${id}`).toBe(false);
        starts.set(id, Date.now() - start);
        inFlight.set(lane, (inFlight.get(lane) ?? 0) + 1);
        maximum.set(lane, Math.max(maximum.get(lane) ?? 0, inFlight.get(lane)!));
        await new Promise((resolve) => setTimeout(resolve, id <= 25 ? 31_000 : 5));
        inFlight.set(lane, inFlight.get(lane)! - 1);
        return {
          status: id <= 25 ? 'down' : 'up',
          latencyMs: id <= 25 ? null : 5,
          httpStatus: id <= 25 ? null : 200,
          error: id <= 25 ? 'Timeout after 10000ms' : null,
          attempts: id <= 25 ? 3 : 1,
        };
      });
    for (let id = 1; id <= 30; id++) {
      f.sqlite
        .prepare(
          "INSERT INTO monitors(id,name,type,target,created_at,updated_at)VALUES(?,?,'http',?,?,?)",
        )
        .run(id, `Probe ${id}`, `https://example.com/${id}`, start / 1000 - 86400, start / 1000);
      f.sqlite
        .prepare(
          "INSERT INTO monitor_state(monitor_id,status,last_checked_at,last_changed_at)VALUES(?,'up',?,?)",
        )
        .run(id, start / 1000 - 60, start / 1000 - 3600);
    }
    const invoke = async <T>(task: (env: Env, ctx: ExecutionContext) => Promise<T>): Promise<T> => {
      const env = {
        DB: f.db,
        ADMIN_TOKEN: 'test',
        ...profile,
        UPTIMER_RUNTIME_PROFILE: 'paid',
        COORDINATOR: {
          getByName: () => {
            throw Error('Unexpected Paid DO call');
          },
        },
      } as unknown as Env;
      if (self)
        env.SELF = {
          fetch: (input: RequestInfo, init?: RequestInit) =>
            invoke((e, ctx) =>
              worker.fetch(
                input instanceof Request && !init ? input : new Request(input, init),
                e,
                ctx,
              ),
            ),
        } as Fetcher;
      const pending: Promise<unknown>[] = [];
      const result = await task(env, { waitUntil: (p) => pending.push(p) } as ExecutionContext);
      for (let offset = 0; offset < pending.length; ) {
        const work = pending.slice(offset);
        offset = pending.length;
        await Promise.all(work);
      }
      return result;
    };
    try {
      let finishedAt = 0;
      const work = Promise.all(
        ['* * * * *', ...paidCrons].map((cron, index) =>
          laneContext.run(index, async () => {
            if (index && jitter) await new Promise((resolve) => setTimeout(resolve, jitter));
            return invoke((env, ctx) =>
              worker.scheduled({ cron, scheduledTime: start } as ScheduledController, env, ctx),
            );
          }),
        ),
      ).then(() => {
        finishedAt = Date.now() - start;
      });
      await vi.advanceTimersByTimeAsync(40_000);
      await work;
      expect(starts.size).toBe(30);
      expect(Math.max(...maximum.values())).toBeLessThanOrEqual(5);
      expect(Math.max(...[26, 27, 28, 29, 30].map((id) => starts.get(id)!))).toBeLessThanOrEqual(
        jitter,
      );
      expect(finishedAt).toBeLessThanOrEqual(33_100);
      expect(
        f.sqlite
          .prepare('SELECT count(*) AS n FROM check_results WHERE checked_at=?')
          .get(start / 1000)?.n,
      ).toBe(30);
      const stored = f.sqlite
        .prepare("SELECT body_json FROM public_snapshots WHERE key='homepage'")
        .get();
      const home = self
        ? JSON.parse(stored!.body_json as string)
        : await computePublicHomepagePayload(f.db, Math.floor(Date.now() / 1000));
      const healthy = home.monitors.filter((m: { id: number }) => m.id >= 26);
      expect(
        home.monitors.every((m: { last_checked_at: number }) => m.last_checked_at === start / 1000),
      ).toBe(true);
      expect(healthy).toHaveLength(5);
      expect(
        healthy.every(
          (m: { status: string; is_stale: boolean; last_checked_at: number }) =>
            m.status === 'up' && !m.is_stale && m.last_checked_at === start / 1000,
        ),
      ).toBe(true);
      console.log(
        JSON.stringify({
          jitter,
          finishedAt,
          healthyStartMs: starts.get(30),
          maximumPerInvocation: Math.max(...maximum.values()),
        }),
      );
    } finally {
      f.sqlite.close();
    }
  });

  it('renews a monitor lease across minutes and prevents another lane from probing it twice', async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 10, 4, 12);
    vi.setSystemTime(start);
    const f = createSqliteD1();
    f.sqlite
      .prepare(
        "INSERT INTO monitors(id,name,type,target,interval_sec,created_at,updated_at)VALUES(1,'Slow','http','https://example.com',120,?,?)",
      )
      .run(start / 1000, start / 1000);
    vi.mocked(runHttpCheck)
      .mockReset()
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 90_000));
        return { status: 'up', latencyMs: 90_000, httpStatus: 200, error: null, attempts: 1 };
      });
    const run = (checkedAt: number) =>
      runExclusivePersistedMonitorBatch({
        db: f.db,
        ids: [1],
        checkedAt,
        sharedMonitorLeases: true,
        bufferSamples: true,
        stateMachineConfig,
      });
    try {
      const first = run(start / 1000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await run(start / 1000 + 60)).stats.processedCount).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await first).stats.processedCount).toBe(1);
      // A lane may have captured due IDs before the first commit. Re-read the
      // interval after acquiring the lease, even though its tick is newer.
      expect((await run(start / 1000 + 60)).stats.processedCount).toBe(0);
      expect(runHttpCheck).toHaveBeenCalledTimes(1);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()?.n).toBe(1);
      expect(
        f.sqlite
          .prepare("SELECT count(*) AS n FROM locks WHERE name LIKE 'scheduler:monitor:%'")
          .get()?.n,
      ).toBe(0);
    } finally {
      f.sqlite.close();
    }
  });

  it('ignores lingering Paid triggers after switching back to Free', async () => {
    const getByName = vi.fn(() => {
      throw Error('Unexpected coordinator call');
    });
    for (const cron of paidCrons)
      await worker.scheduled(
        { cron } as ScheduledController,
        { UPTIMER_RUNTIME_PROFILE: 'free', COORDINATOR: { getByName } } as unknown as Env,
        {} as ExecutionContext,
      );
    expect(getByName).not.toHaveBeenCalled();
  });
});
