import { describe, expect, it } from 'vitest';
import { runRetention } from '../src/scheduler/retention';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('bounded bucket retention capacity', () => {
  it.each(['free', 'paid'])('preserves gradual legacy cleanup on %s', async (profile) => {
    const f = createSqliteD1();
    const now = 1_800_000_000;
    try {
      const insert = f.sqlite.prepare(
        "INSERT INTO check_results_legacy(monitor_id,checked_at,status) VALUES(1,?,'up')",
      );
      for (let i = 0; i < 1002; i++) insert.run(now - 8 * 86400);
      await runRetention(
        {
          DB: f.db,
          UPTIMER_RUNTIME_PROFILE: profile,
          UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: '1',
          UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
        } as Env,
        { scheduledTime: now * 1000 } as ScheduledController,
      );
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_results_legacy').get()!.n).toBe(2);
    } finally {
      f.sqlite.close();
    }
  });
  it.each(['free', 'paid'])(
    'keeps up with 30 sparse monitor IDs and catches an interruption on %s',
    async (profile) => {
      const f = createSqliteD1();
      const now = 1_800_000_000;
      const env = {
        DB: f.db,
        UPTIMER_RUNTIME_PROFILE: profile,
        UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: '1',
        UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
      } as Env;
      try {
        const insert = f.sqlite.prepare(
          'INSERT INTO check_result_buckets(shard_id,bucket_start_at,samples_json) VALUES(?,?,?)',
        );
        const addDay = (day: number) => {
          for (let shard = 0; shard < 30; shard++)
            for (let hour = 0; hour < 24; hour++) {
              const at = day + hour * 3600;
              insert.run(
                shard,
                at,
                JSON.stringify([[shard * 4 + 1, at, 'up', 42, 200, null, null, 1]]),
              );
            }
        };
        addDay(now - 9 * 86400);
        addDay(now - 8 * 86400);
        // The retained bucket must not be collateral damage from catch-up.
        insert.run(100, now - 3600, '[[401,1799996400,"up",42,200,null,null,1]]');
        for (let day = 0; day < 3; day++) {
          if (day) addDay(now + (day - 8) * 86400);
          await runRetention(env, {
            scheduledTime: (now + day * 86400) * 1000,
          } as ScheduledController);
          expect(
            f.sqlite
              .prepare('SELECT count(*) AS n FROM check_result_buckets WHERE bucket_start_at<?')
              .get(now + (day - 7) * 86400)!.n,
          ).toBe(0);
          expect(
            f.sqlite
              .prepare('SELECT count(*) AS n FROM check_result_buckets WHERE shard_id=100')
              .get()!.n,
          ).toBe(1);
        }
      } finally {
        f.sqlite.close();
      }
    },
  );
  it.each([
    { profile: 'free', remaining: 904 },
    { profile: 'paid', remaining: 0 },
  ])('bounds a large backlog under the $profile budget', async ({ profile, remaining }) => {
    const f = createSqliteD1();
    const now = 1_800_000_000;
    try {
      const insert = f.sqlite.prepare(
        "INSERT INTO check_result_buckets(shard_id,bucket_start_at,samples_json) VALUES(?,?,'[]')",
      );
      for (let shard = 0; shard < 5000; shard++) insert.run(shard, now - 8 * 86400);
      await runRetention(
        {
          DB: f.db,
          UPTIMER_RUNTIME_PROFILE: profile,
          UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: '1',
          UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
        } as Env,
        { scheduledTime: now * 1000 } as ScheduledController,
      );
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM check_result_buckets').get()!.n).toBe(
        remaining,
      );
      expect(f.queries.length).toBeLessThan(50);
    } finally {
      f.sqlite.close();
    }
  });
});
