import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createSqliteD1 } from './helpers/sqlite-d1';
import type { Env } from '../src/env';

describe('latest completed latency samples', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(['legacy', 'archive', 'pending'])(
    'includes current-minute %s samples in both response formats',
    async (storage) => {
      const f = createSqliteD1();
      const now = 1_800_000_140;
      const latest = now - 10;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: async () => undefined }) });
      try {
        f.sqlite
          .prepare(
            `INSERT INTO monitors(id,name,type,target,created_at,updated_at)
          VALUES(1,'API','http','https://example.com',?,?)`,
          )
          .run(now - 86400, now);
        const points = [now - 86400 - 1, now - 86400, latest, now + 1];
        if (storage === 'pending') {
          f.sqlite
            .prepare(
              `INSERT INTO monitor_state(monitor_id,status,last_checked_at,pending_hour,pending_samples_json)
            VALUES(1,'up',?,?,?)`,
            )
            .run(
              latest,
              Math.floor(latest / 3600) * 3600,
              JSON.stringify(points.slice(2).map((at) => [1, at, 'up', 42, 200, null, null, 1])),
            );
          for (const at of points.slice(0, 2))
            f.sqlite
              .prepare(
                `INSERT INTO check_results(monitor_id,checked_at,status,latency_ms)
            VALUES(1,?,'up',42)`,
              )
              .run(at);
        } else {
          const table = storage === 'legacy' ? 'check_results_legacy' : 'check_results';
          for (const at of points)
            f.sqlite
              .prepare(
                `INSERT INTO ${table}(monitor_id,checked_at,status,latency_ms)
            VALUES(1,?,'up',42)`,
              )
              .run(at);
        }
        for (const compact of [false, true]) {
          const response = await worker.fetch(
            new Request(
              `https://example.com/api/v1/public/monitors/1/latency?range=24h${compact ? '&format=compact-v1' : ''}`,
              { headers: { 'Cache-Control': 'no-cache' } },
            ),
            { DB: f.db } as Env,
            { waitUntil() {} } as ExecutionContext,
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            range_end_at: number;
            range_start_at: number;
            avg_latency_ms: number;
            p95_latency_ms: number;
            points: { checked_at: number[] } | Array<{ checked_at: number }>;
          };
          const timestamps = Array.isArray(body.points)
            ? body.points.map((p) => p.checked_at)
            : body.points.checked_at;
          expect(timestamps).toEqual([now - 86400, latest]);
          expect(body.range_end_at).toBe(now);
          expect(body.range_start_at).toBe(now - 86400);
          expect(body.avg_latency_ms).toBe(42);
          expect(body.p95_latency_ms).toBe(42);
        }
      } finally {
        f.sqlite.close();
      }
    },
  );
});
