import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeTodayPartialUptimeBatch } from '../src/public/data';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

describe('public/data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chunks today partial uptime SQL to stay within the D1 bind limit', async () => {
    const rangeStart = 1_776_172_800;
    const now = rangeStart + 600;
    const monitors = Array.from({ length: 26 }, (_, index) => ({
      id: index + 1,
      interval_sec: 60,
      created_at: rangeStart - 3_600,
      last_checked_at: now - 30,
    }));

    const sqlChunkArgLengths: number[] = [];
    const sqlChunkIds: number[][] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'with input(monitor_id, interval_sec, created_at, last_checked_at) as (',
        all: (args) => {
          sqlChunkArgLengths.push(args.length);

          const ids: number[] = [];
          for (let index = 2; index < args.length; index += 4) {
            const id = args[index];
            if (typeof id === 'number') ids.push(id);
          }
          sqlChunkIds.push(ids);

          return ids.map((id) => ({
            monitor_id: id,
            start_at: rangeStart,
            total_sec: now - rangeStart,
            downtime_sec: 0,
            unknown_sec: 0,
          }));
        },
      },
    ];

    const result = await computeTodayPartialUptimeBatch(
      createFakeD1Database(handlers),
      monitors,
      rangeStart,
      now,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(sqlChunkArgLengths).toEqual([98, 10]);
    expect(Math.max(...sqlChunkArgLengths)).toBeLessThanOrEqual(100);
    expect(sqlChunkIds).toEqual([Array.from({ length: 24 }, (_, index) => index + 1), [25, 26]]);
    expect(result.size).toBe(26);
    expect(result.get(1)).toMatchObject({
      total_sec: 600,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 600,
      uptime_pct: 100,
    });
    expect(result.get(26)).toMatchObject({
      total_sec: 600,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 600,
      uptime_pct: 100,
    });
  });
});
