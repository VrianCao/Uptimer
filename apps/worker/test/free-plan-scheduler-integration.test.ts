import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/monitor/http', () => ({ runHttpCheck: vi.fn() }));
vi.mock('../src/monitor/tcp', () => ({ runTcpCheck: vi.fn() }));
vi.mock('../src/notify/webhook', () => ({ dispatchWebhookToChannels: vi.fn() }));
import { runHttpCheck } from '../src/monitor/http';
import { dispatchWebhookToChannels } from '../src/notify/webhook';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { runScheduledBatchCohort } from '../src/scheduler/scheduled';

function cohortFixture() {
  const fixture = createSqliteD1();
  const now = Math.floor(Date.now() / 60000) * 60;
  const profile = Object.fromEntries(
    [
      ...readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').matchAll(
        /^(UPTIMER_\w+) = "([^"]*)"/gm,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  for (const id of [1, 2, 3]) {
    fixture.sqlite
      .prepare(
        "INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES (?,?,'http','https://example.com',?,?)",
      )
      .run(id, `API ${id}`, now - 60, now - 60);
  }
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const env = {
    DB: fixture.db,
    ADMIN_TOKEN: 'test',
    ...profile,
    UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE: '2',
  } as Env;
  env.SELF = { fetch: (request: Request) => worker.fetch(request, env, ctx) } as Fetcher;
  const body = {
    batches: [[1, 2], [3]],
    checked_at: now,
    state_failures_to_down_from_up: 2,
    state_successes_to_up_from_down: 2,
  };
  const request = (patch = {}, host = 'internal', token = 'test') =>
    new Request(`http://${host}/api/v1/internal/scheduled/check-batches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...patch }),
    });
  return { ...fixture, now, env, ctx, body, request };
}

describe('Free Plan scheduled resource envelope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('respects a custom service-batch concurrency before starting more probes', async () => {
    const f = cohortFixture();
    for (let id = 4; id <= 12; id++) {
      f.sqlite
        .prepare(
          "INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES (?,?,'http','https://example.com',?,?)",
        )
        .run(id, `API ${id}`, f.now - 60, f.now - 60);
    }
    Object.assign(f.env, { UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY: '1' });
    const pending: Promise<unknown>[] = [];
    const paths: string[] = [];
    const ctx = {
      waitUntil: (task: Promise<unknown>) => pending.push(task),
    } as unknown as ExecutionContext;
    f.env.SELF = {
      fetch: (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return worker.fetch(request, f.env, ctx);
      },
    } as Fetcher;
    let release!: () => void;
    const network = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runHttpCheck)
      .mockReset()
      .mockImplementation(async () => {
        await network;
        return { status: 'up', latencyMs: 42, httpStatus: 200, error: null, attempts: 1 };
      });
    const tick = worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now() } as ScheduledController,
      f.env,
      ctx,
    );
    try {
      await vi.waitFor(() => expect(runHttpCheck).toHaveBeenCalledTimes(2));
      expect(paths.filter((path) => path.endsWith('/check-batch'))).toHaveLength(1);
      expect(paths.some((path) => path.endsWith('/check-batches'))).toBe(false);
    } finally {
      release();
      try {
        await tick;
        for (let i = 0; i < pending.length; i++) await pending[i];
        expect(runHttpCheck).toHaveBeenCalledTimes(12);
      } finally {
        f.sqlite.close();
      }
    }
  });
  it.each([0, 59])(
    'validates the private coordinator boundary at minute second %d before dispatching any probes',
    async (second) => {
      const f = cohortFixture();
      // A real minute rollover can turn the deliberately future request into a
      // valid current-minute request. Pin time for the whole boundary assertion.
      vi.spyOn(Date, 'now').mockReturnValue((f.now + second) * 1000);
      const probe = vi.mocked(runHttpCheck).mockClear();
      try {
        for (const [request, status] of [
          [f.request({}, 'public.example'), 404],
          [f.request({}, 'internal', 'wrong'), 403],
          [f.request({ batches: [[1, 1]] }), 400],
          [f.request({ batches: [[1, 2, 3]] }), 400],
          [f.request({ batches: Array.from({ length: 6 }, (_, i) => [i + 1]) }), 400],
          [f.request({ checked_at: f.now + 60 }), 403],
          [f.request({ checked_at: f.now - 360 }), 403],
        ] as const) {
          expect((await worker.fetch(request, f.env, f.ctx)).status).toBe(status);
        }
        expect(probe).not.toHaveBeenCalled();
        expect(f.writes).toHaveLength(0);
      } finally {
        f.sqlite.close();
      }
    },
  );
  it.each(['before-persist', 'after-persist'] as const)(
    'recovers a child connection loss %s without losing or duplicating samples',
    async (failure) => {
      const f = cohortFixture();
      vi.mocked(runHttpCheck).mockReset().mockResolvedValue({
        status: 'up',
        latencyMs: 42,
        httpStatus: 200,
        error: null,
        attempts: 1,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let lost = false;
      f.env.SELF = {
        fetch: async (request: Request) => {
          if (!lost) {
            lost = true;
            if (failure === 'after-persist') await worker.fetch(request, f.env, f.ctx);
            throw new Error('connection lost');
          }
          return worker.fetch(request, f.env, f.ctx);
        },
      } as Fetcher;
      try {
        expect((await worker.fetch(f.request(), f.env, f.ctx)).status).toBe(200);
        expect(
          f.sqlite
            .prepare(
              'SELECT monitor_id, count(*) AS n FROM check_results GROUP BY monitor_id ORDER BY monitor_id',
            )
            .all(),
        ).toEqual([
          { monitor_id: 1, n: 1 },
          { monitor_id: 2, n: 1 },
          { monitor_id: 3, n: 1 },
        ]);
        expect(runHttpCheck).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalled();
      } finally {
        f.sqlite.close();
      }
    },
  );
  it('starts no work when the coordinator caller has already cancelled', async () => {
    const f = cohortFixture();
    const dispatch = vi.fn();
    f.env.SELF = { fetch: dispatch } as unknown as Fetcher;
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        runScheduledBatchCohort(
          f.env,
          f.ctx,
          {
            batches: f.body.batches,
            checkedAt: f.now,
            suppressedMonitorIds: [],
            allowNotifications: false,
            stateMachineConfig: { failuresToDownFromUp: 2, successesToUpFromDown: 2 },
          },
          controller.signal,
        ),
      ).rejects.toThrow('aborted by caller');
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.writes).toHaveLength(0);
    } finally {
      f.sqlite.close();
    }
  });
  it('retains outage notifications and maintenance suppression during coordinator recovery', async () => {
    const f = cohortFixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(dispatchWebhookToChannels).mockClear().mockResolvedValue(undefined);
    vi.mocked(runHttpCheck).mockReset().mockResolvedValue({
      status: 'down',
      latencyMs: 42,
      httpStatus: 503,
      error: 'HTTP 503',
      attempts: 1,
    });
    f.sqlite
      .prepare(
        "INSERT INTO notification_channels(name,type,config_json,created_at) VALUES ('primary','webhook',?,?)",
      )
      .run(
        JSON.stringify({
          url: 'https://hooks.example.com/uptimer',
          method: 'POST',
          payload_type: 'json',
        }),
        f.now - 60,
      );
    const pending: Promise<unknown>[] = [];
    f.ctx.waitUntil = (task) => {
      pending.push(task);
    };
    f.env.SELF = {
      fetch: async () => {
        throw new Error('connection lost');
      },
    } as unknown as Fetcher;
    try {
      expect(
        (
          await worker.fetch(
            f.request({
              allow_notifications: true,
              suppressed_monitor_ids: [2],
              state_failures_to_down_from_up: 1,
            }),
            f.env,
            f.ctx,
          )
        ).status,
      ).toBe(200);
      await Promise.all(pending);
      expect(
        f.sqlite.prepare('SELECT count(*) AS n FROM outages WHERE ended_at IS NULL').get(),
      ).toEqual({ n: 3 });
      expect(
        vi
          .mocked(dispatchWebhookToChannels)
          .mock.calls.map(([event]) => event.eventKey)
          .sort(),
      ).toEqual([`monitor:1:down:${f.now}`, `monitor:3:down:${f.now}`]);
    } finally {
      f.sqlite.close();
    }
  });
  it.each([
    {
      name: 'legacy',
      batchSize: 2,
      pageSize: 3,
      requests: 31,
      probeBatches: 15,
      cohorts: 3,
      logicalWrites: 50,
      archiveStatements: 15,
      archiveWrites: 15,
    },
    {
      name: 'coordinated',
      batchSize: 5,
      pageSize: 10,
      requests: 12,
      probeBatches: 6,
      cohorts: 0,
      logicalWrites: 43,
      archiveStatements: 6,
      archiveWrites: 12,
    },
  ])(
    'keeps a complete 30-monitor $name tick within Free Plan resource bounds',
    async (executionProfile) => {
      const { db, sqlite, writes, calls } = createSqliteD1();
      vi.stubGlobal('caches', {
        open: async () => ({ match: async () => undefined, put: async () => undefined }),
      });
      const fixtureClock = process.env.UPTIMER_D1_COST_FIXTURE_NOW;
      const now =
        fixtureClock === 'live'
          ? Math.floor(Date.now() / 60000) * 60
          : /^\d{10}$/.test(fixtureClock ?? '')
            ? Number(fixtureClock)
            : 1_800_000_120;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      vi.mocked(runHttpCheck).mockResolvedValue({
        status: 'up',
        latencyMs: 42,
        httpStatus: 200,
        error: null,
        attempts: 1,
      });
      const day = Math.floor(now / 86400) * 86400;
      for (let id = 1; id <= 30; id++) {
        sqlite
          .prepare(
            `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
        VALUES (?,?,'http','https://example.com',?,?)`,
          )
          .run(id, `API ${id}`, now - 90 * 86400, now - 90 * 86400);
        sqlite
          .prepare("INSERT INTO monitor_state(monitor_id,status,last_checked_at) VALUES (?,'up',?)")
          .run(id, now - 60);
        sqlite
          .prepare(
            "INSERT INTO check_results(monitor_id,checked_at,status,latency_ms) VALUES (?,?,'up',42)",
          )
          .run(id, now - 60);
        for (let d = 1; d <= 60; d++) {
          sqlite
            .prepare(
              `INSERT INTO monitor_daily_rollups(monitor_id,day_start_at,total_sec,downtime_sec,
          unknown_sec,uptime_sec,checks_total,checks_up,checks_down,checks_unknown,checks_maintenance)
          VALUES (?,?,86400,0,0,86400,1440,1440,0,0,0)`,
            )
            .run(id, day - d * 86400);
        }
      }
      // Full retained sample volume, not merely daily summary rows. Seed directly
      // into hour buckets so the fixture itself does not perform 300k writes.
      const insertBucket = sqlite.prepare(
        'INSERT INTO check_result_buckets(shard_id,bucket_start_at,samples_json) VALUES (?,?,?) ON CONFLICT(shard_id,bucket_start_at) DO UPDATE SET samples_json=excluded.samples_json',
      );
      const hour = Math.floor(now / 3600) * 3600;
      for (let start = hour - 7 * 86400; start <= hour; start += 3600) {
        for (let shard = 0; shard < 8; shard++) {
          const samples = [];
          for (let checked = start; checked < Math.min(start + 3600, now); checked += 60) {
            for (let id = shard * 4 + 1; id <= Math.min(30, shard * 4 + 4); id++) {
              samples.push([id, checked, 'up', 42, 200, null, null, 1]);
            }
          }
          if (samples.length) insertBucket.run(shard, start, JSON.stringify(samples));
        }
      }
      const profile = Object.fromEntries(
        [
          ...readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').matchAll(
            /^(UPTIMER_\w+) = "([^"]*)"/gm,
          ),
        ].map((m) => [m[1], m[2]]),
      );
      const pending: Promise<unknown>[] = [];
      const paths: string[] = [];
      const ctx = {
        waitUntil: (task: Promise<unknown>) => {
          pending.push(task);
        },
      } as ExecutionContext;
      const env = { DB: db, ADMIN_TOKEN: 'test', ...profile } as Env;
      env.UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = String(executionProfile.batchSize);
      env.UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE = String(executionProfile.pageSize);
      env.SELF = {
        fetch: async (input: Request) => {
          const path = new URL(input.url).pathname;
          paths.push(path);
          // Real service hops cross second boundaries. A frozen clock conceals
          // mismatched envelope/page generations and an unpublished homepage.
          if (path.endsWith('/continue/sharded-public-snapshot')) {
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
          }
          return worker.fetch(input, env, ctx);
        },
      } as Fetcher;
      const run = async () => {
        await worker.scheduled(
          { cron: '* * * * *', scheduledTime: Date.now() } as ScheduledController,
          env,
          ctx,
        );
        for (let index = 0; index < pending.length; index++) await pending[index];
        pending.length = 0;
      };
      // Slow targets must not queue the remaining probes behind eight waves of
      // service batches. All 30 probes start while the first network I/O waits.
      let releaseNetwork!: () => void;
      const networkGate = new Promise<void>((resolve) => {
        releaseNetwork = resolve;
      });
      const healthy = {
        status: 'up' as const,
        latencyMs: 42,
        httpStatus: 200,
        error: null,
        attempts: 1,
      };
      vi.mocked(runHttpCheck).mockImplementation(async () => {
        await networkGate;
        return healthy;
      });
      const initialTick = run();
      try {
        await vi.waitFor(() => expect(runHttpCheck).toHaveBeenCalledTimes(30));
      } finally {
        releaseNetwork();
        await initialTick;
      }
      vi.mocked(runHttpCheck).mockResolvedValue(healthy);
      expect(runHttpCheck).toHaveBeenCalledTimes(30);
      expect(paths.length + 1).toBeLessThanOrEqual(32);
      expect(paths.filter((p) => p.endsWith('/check-batch'))).toHaveLength(
        executionProfile.probeBatches,
      );
      expect(paths.some((p) => /runtime-fragments|runtime-update-fragments/.test(p))).toBe(false);
      expect(writes.some((w) => /monitor-runtime/.test(w.sql))).toBe(false);
      const homepage = JSON.parse(
        sqlite.prepare("SELECT body_json FROM public_snapshots WHERE key='homepage'").get()!
          .body_json as string,
      );
      expect(paths.length + 1).toBe(executionProfile.requests);
      expect(paths.filter((path) => path.endsWith('/check-batches'))).toHaveLength(
        executionProfile.cohorts,
      );
      const status = JSON.parse(
        sqlite.prepare("SELECT body_json FROM public_snapshots WHERE key='status'").get()!
          .body_json as string,
      );
      expect(status.generated_at).toBe(now);
      expect(status.monitors).toHaveLength(30);
      expect(homepage.monitors).toHaveLength(30);
      expect(
        homepage.monitors.every((m: { last_checked_at: number }) => m.last_checked_at === now),
      ).toBe(true);
      expect(homepage.monitors[0].uptime_day_strip.day_start_at.length).toBeGreaterThanOrEqual(60);
      // Steady state: samples are durable in the state updates themselves. No
      // archive write is needed until the next hour, including with sparse IDs.
      const firstWrites = writes.length;
      const firstCalls = calls.length;
      const costFixture = process.env.UPTIMER_D1_COST_CALLS_PATH
        ? Object.fromEntries(
            [
              'monitors',
              'monitor_state',
              'check_results_legacy',
              'check_result_buckets',
              'monitor_daily_rollups',
              'public_snapshot_fragments',
              'public_snapshots',
              'locks',
              'outages',
              'settings',
            ].map((table) => [
              table,
              sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            ]),
          )
        : undefined;
      vi.spyOn(Date, 'now').mockReturnValue((now + 60) * 1000);
      paths.length = 0;
      await run();
      const steady = writes.slice(firstWrites);
      const steadyCalls = calls.slice(firstCalls);
      const steadyCrossesDay = Math.floor(now / 86400) !== Math.floor((now + 60) / 86400);
      if (!steadyCrossesDay) {
        expect(
          steadyCalls.some((call) =>
            call.sql.includes('SELECT monitor_id,started_at,ended_at FROM outages'),
          ),
        ).toBe(false);
        expect(
          steadyCalls.some((call) =>
            /SELECT fragment_key,generated_at,body_json\s+FROM public_snapshot_fragments/.test(
              call.sql,
            ),
          ),
        ).toBe(false);
        expect(steadyCalls.some((call) => /\bFROM check_results\b/i.test(call.sql))).toBe(false);
        expect(steady.some((write) => write.sql.includes('monitor_daily_rollups'))).toBe(false);
      }
      const steadyCrossesHour = Math.floor(now / 3600) !== Math.floor((now + 60) / 3600);
      expect(
        steady
          .filter((w) => w.sql.includes('INSERT INTO check_result_buckets'))
          .reduce((n, w) => n + w.changes, 0),
      ).toBe(steadyCrossesHour ? executionProfile.archiveWrites : 0);
      expect(steady.reduce((n, w) => n + w.changes, 0)).toBeLessThanOrEqual(
        steadyCrossesDay
          ? 500
          : executionProfile.logicalWrites +
              (steadyCrossesHour ? executionProfile.archiveWrites : 0),
      );
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM check_results WHERE checked_at=?').get(now + 60),
      ).toEqual({ n: 30 });
      expect(paths.length + 1).toBeLessThanOrEqual(32);
      const latency = await worker.fetch(
        new Request('https://status.example/api/v1/public/monitors/1/latency?range=24h'),
        env,
        ctx,
      );
      expect(latency.status).toBe(200);
      const latencyBody = (await latency.json()) as { points: Array<{ checked_at: number }> };
      expect(latencyBody.points.length).toBeGreaterThanOrEqual(1440);
      const publicCalls: Array<{ kind: string; calls: typeof calls }> = [];
      for (const key of ['homepage', 'status', 'homepage:artifact'] as const) {
        const before = calls.length;
        const path = key === 'homepage:artifact' ? 'homepage-artifact' : key;
        const response = await worker.fetch(
          new Request('https://status.example/api/v1/public/' + path, {
            headers: { 'Cache-Control': 'no-cache' },
          }),
          env,
          ctx,
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        publicCalls.push({ kind: key, calls: calls.slice(before) });
      }
      const beforeCompact = calls.length;
      const compact = await worker.fetch(
        new Request(
          'https://status.example/api/v1/public/monitors/1/latency?range=24h&format=compact-v1',
        ),
        env,
        ctx,
      );
      expect(compact.status).toBe(200);
      const compactBody = (await compact.json()) as { points: { checked_at: number[] } };
      expect(compactBody.points.checked_at).toEqual(
        latencyBody.points.map((point) => point.checked_at),
      );
      publicCalls.push({ kind: 'compact-latency', calls: calls.slice(beforeCompact) });
      // The management list needs four state scalars; the derived heartbeat
      // summaries must not be transferred or mapped by Drizzle for every monitor.
      const beforeAdmin = calls.length;
      const admin = await worker.fetch(
        new Request('https://status.example/api/v1/admin/monitors', {
          headers: { Authorization: 'Bearer test' },
        }),
        env,
        ctx,
      );
      expect(admin.status).toBe(200);
      const adminBody = (await admin.json()) as { monitors: Array<Record<string, unknown>> };
      expect(adminBody.monitors).toHaveLength(30);
      expect(adminBody.monitors[0]).toMatchObject({
        id: 1,
        status: 'up',
        last_checked_at: now + 60,
        last_latency_ms: 42,
        last_error: null,
      });
      expect(calls.slice(beforeAdmin).some((call) => call.sql.includes('check_summary_json'))).toBe(
        false,
      );
      // A persistent failure must not rewrite the same outage error every minute.
      vi.mocked(runHttpCheck).mockResolvedValue({
        status: 'down',
        latencyMs: 100,
        httpStatus: 503,
        error: 'HTTP 503',
        attempts: 3,
      });
      for (let minute = 2; minute <= 4; minute++) {
        vi.spyOn(Date, 'now').mockReturnValue((now + minute * 60) * 1000);
        await run();
      }
      const failureBaseline = writes.length;
      vi.spyOn(Date, 'now').mockReturnValue((now + 300) * 1000);
      await run();
      expect(writes.slice(failureBaseline).some((w) => w.sql.includes('SET last_error'))).toBe(
        false,
      );
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM outages WHERE ended_at IS NULL').get(),
      ).toEqual({ n: 30 });
      // The root can recover a failed coordinator by dispatching its individual
      // batches. Already completed peers must not lose their results.
      const configuredBatchSize = env.UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE ?? '5';
      env.UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = '2';
      const selfFetch = env.SELF.fetch.bind(env.SELF);
      let coordinatorFailed = false;
      env.SELF = {
        fetch: async (request: Request) => {
          if (!coordinatorFailed && new URL(request.url).pathname.endsWith('/check-batches')) {
            coordinatorFailed = true;
            return new Response('Unavailable', { status: 503 });
          }
          return selfFetch(request);
        },
      } as Fetcher;
      const recoveryWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Date, 'now').mockReturnValue((now + 360) * 1000);
      await run();
      expect(coordinatorFailed).toBe(true);
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM check_results WHERE checked_at=?').get(now + 360),
      ).toEqual({ n: 30 });
      expect(recoveryWarn).toHaveBeenCalledWith(
        'scheduled: cohort failed; recovering individual batches',
        expect.any(Error),
      );
      recoveryWarn.mockRestore();
      env.UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = configuredBatchSize;
      const hourlyAt = Math.floor((now + 360) / 3600) * 3600 + 3600;
      const beforeHour = calls.length;
      vi.spyOn(Date, 'now').mockReturnValue(hourlyAt * 1000);
      await run();
      const hourlyArchiveCalls = calls
        .slice(beforeHour)
        .filter((call) =>
          call.sql.includes('FROM monitor_state s,json_each(s.pending_samples_json)'),
        );
      expect(hourlyArchiveCalls).toHaveLength(executionProfile.archiveStatements);
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM check_results WHERE checked_at=?').get(hourlyAt),
      ).toEqual({ n: 30 });
      const maintenanceCalls: Array<{ kind: string; calls: typeof calls }> = [];
      const maintenanceDay = Math.floor(hourlyAt / 86400) * 86400 + 86400;
      for (const at of [maintenanceDay, maintenanceDay + 1800]) {
        const beforeMaintenance = calls.length;
        paths.length = 0;
        vi.spyOn(Date, 'now').mockReturnValue(at * 1000);
        await run();
        maintenanceCalls.push({
          kind: at % 86400 === 0 ? 'rollup' : 'retention',
          calls: calls.slice(beforeMaintenance),
        });
        expect(paths.filter((path) => path.endsWith('/maintenance'))).toHaveLength(1);
        expect(paths.length + 1).toBeLessThanOrEqual(32);
      }
      expect(
        sqlite
          .prepare('SELECT count(*) AS n FROM monitor_daily_rollups WHERE day_start_at=?')
          .get(maintenanceDay - 86400),
      ).toEqual({ n: 30 });
      if (process.env.UPTIMER_D1_COST_CALLS_PATH && executionProfile.name === 'coordinated') {
        writeFileSync(
          process.env.UPTIMER_D1_COST_CALLS_PATH,
          JSON.stringify({
            fixtureNow: now + 60,
            monitorCount: 30,
            tables: costFixture,
            calls: steadyCalls,
            bootstrapCalls: calls.slice(0, firstCalls),
            maintenanceCalls,
            hourlyArchiveCalls,
            publicCalls,
          }),
        );
      }
      sqlite.close();
    },
    60_000,
  );
});
