import { describe, expect, it, vi } from 'vitest';

import {
  applyMonitorRuntimeUpdates,
  encodeMonitorRuntimeUpdatesCompact,
  materializeMonitorRuntimeTotals,
  monitorRuntimeUpdateSchema,
  parseMonitorRuntimeUpdate,
  parseMonitorRuntimeUpdates,
  refreshPublicMonitorRuntimeSnapshot,
  readPublicMonitorRuntimeSnapshot,
  readPublicMonitorRuntimeTotalsSnapshot,
  runtimeEntryToHeartbeats,
  writePublicMonitorRuntimeSnapshot,
  type PublicMonitorRuntimeSnapshot,
} from '../src/public/monitor-runtime';
import { createFakeD1Database } from './helpers/fake-d1';

describe('public/monitor-runtime', () => {
  it('advances totals and heartbeat strips incrementally for healthy checks', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 60,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 60,
          last_checked_at: 60,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 0,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 0,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [42],
          heartbeat_status_codes: 'u',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 120, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 120,
        check_status: 'up',
        next_status: 'up',
        latency_ms: 40,
      },
    ]);

    expect(next.generated_at).toBe(120);
    expect(next.monitors[0]).toMatchObject({
      total_sec: 60,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 60,
      materialized_at: 120,
      last_checked_at: 120,
      last_status_code: 'u',
      last_outage_open: false,
      heartbeat_gap_sec: '1o',
      heartbeat_latency_ms: [40, 42],
      heartbeat_status_codes: 'uu',
    });
  });

  it('stores the post-state status separately from the raw heartbeat result', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 60,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 60,
          last_checked_at: 60,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 0,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 0,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [42],
          heartbeat_status_codes: 'u',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 120, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 120,
        check_status: 'down',
        next_status: 'up',
        latency_ms: null,
      },
    ]);

    expect(next.monitors[0]).toMatchObject({
      last_status_code: 'u',
      last_outage_open: false,
      heartbeat_status_codes: 'du',
    });
  });

  it('normalizes runtime update latency values to non-negative integers', () => {
    expect(
      monitorRuntimeUpdateSchema.parse({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'up',
        next_status: 'up',
        latency_ms: -3.7,
      }),
    ).toMatchObject({
      latency_ms: 0,
    });
  });

  it('rejects invalid privileged runtime update statuses', () => {
    expect(() =>
      monitorRuntimeUpdateSchema.parse({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'degraded',
        next_status: 'up',
        latency_ms: 12,
      }),
    ).toThrow();
  });

  it('parses runtime updates with the same privileged latency normalization on the hot path', () => {
    expect(
      parseMonitorRuntimeUpdate({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'up',
        next_status: 'up',
        latency_ms: -3.7,
      }),
    ).toEqual({
      monitor_id: 1,
      interval_sec: 60,
      created_at: 0,
      checked_at: 60,
      check_status: 'up',
      next_status: 'up',
      latency_ms: 0,
    });
  });

  it('parses compact runtime update tuples on the hot path', () => {
    expect(parseMonitorRuntimeUpdate([1, 60, 0, 60, 'up', 'up', -3.7])).toEqual({
      monitor_id: 1,
      interval_sec: 60,
      created_at: 0,
      checked_at: 60,
      check_status: 'up',
      next_status: 'up',
      latency_ms: 0,
    });
  });

  it('encodes runtime updates into compact tuples for internal transport', () => {
    expect(
      encodeMonitorRuntimeUpdatesCompact([
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 0,
          checked_at: 60,
          check_status: 'up',
          next_status: 'down',
          latency_ms: 12,
        },
      ]),
    ).toEqual([[1, 60, 0, 60, 'up', 'down', 12]]);
  });

  it('rejects invalid runtime update arrays on the hot path', () => {
    expect(
      parseMonitorRuntimeUpdates([
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 0,
          checked_at: 60,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 12,
        },
        {
          monitor_id: 2,
          interval_sec: 60,
          created_at: 0,
          checked_at: 120,
          check_status: 'degraded',
          next_status: 'up',
          latency_ms: 12,
        },
      ]),
    ).toBeNull();
  });

  it('ignores out-of-order updates for existing runtime entries', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 120,
          last_checked_at: 120,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 60,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 60,
          heartbeat_gap_sec: '1o',
          heartbeat_latency_ms: [40, 42],
          heartbeat_status_codes: 'uu',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 180, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 90,
        check_status: 'down',
        next_status: 'down',
        latency_ms: null,
      },
    ]);

    expect(next).toEqual({
      ...snapshot,
      generated_at: 180,
    });
  });

  it('preserves downtime precedence over unknown tail when an outage is open', () => {
    const totals = materializeMonitorRuntimeTotals(
      {
        monitor_id: 1,
        created_at: 0,
        interval_sec: 60,
        range_start_at: 0,
        materialized_at: 120,
        last_checked_at: 120,
        last_status_code: 'x',
        last_outage_open: true,
        total_sec: 120,
        downtime_sec: 60,
        unknown_sec: 0,
        uptime_sec: 60,
        heartbeat_gap_sec: '1o',
        heartbeat_latency_ms: [null, 42],
        heartbeat_status_codes: 'xu',
      },
      180,
    );

    expect(totals.total_sec).toBe(180);
    expect(totals.downtime_sec).toBe(120);
    expect(totals.unknown_sec).toBe(0);
    expect(totals.uptime_sec).toBe(60);
    expect(totals.uptime_pct).toBeCloseTo(100 / 3, 12);
  });

  it('decodes runtime heartbeat strips back into public heartbeat rows', () => {
    const heartbeats = runtimeEntryToHeartbeats({
      monitor_id: 1,
      created_at: 0,
      interval_sec: 60,
      range_start_at: 0,
      materialized_at: 120,
      last_checked_at: 120,
      last_status_code: 'u',
      last_outage_open: false,
      total_sec: 60,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 60,
      heartbeat_gap_sec: '1o,1o',
      heartbeat_latency_ms: [40, null, 22],
      heartbeat_status_codes: 'udm',
    });

    expect(heartbeats).toEqual([
      { checked_at: 120, latency_ms: 40, status: 'up' },
      { checked_at: 60, latency_ms: null, status: 'down' },
      { checked_at: 0, latency_ms: 22, status: 'maintenance' },
    ]);
  });

  it('accepts legacy runtime snapshots and normalizes them on read', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 120,
          body_json: JSON.stringify({
            version: 1,
            generated_at: 120,
            day_start_at: 0,
            monitors: [
              {
                monitor_id: 1,
                created_at: null,
                interval_sec: 60,
                range_start_at: 0,
                materialized_at: 120,
                last_checked_at: 120,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 60,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 60,
                heartbeat_checked_at: [120, 60, 0],
                heartbeat_latency_ms: [40, null, 22],
                heartbeat_status_codes: 'udm',
              },
            ],
          }),
        }),
      },
    ]);

    const snapshot = await readPublicMonitorRuntimeSnapshot(db, 120);
    expect(snapshot?.monitors[0]?.created_at).toBeNull();
    expect(snapshot?.monitors[0]?.heartbeat_gap_sec).toBe('1o,1o');
    expect(snapshot?.monitors[0] && runtimeEntryToHeartbeats(snapshot.monitors[0])).toEqual([
      { checked_at: 120, latency_ms: 40, status: 'up' },
      { checked_at: 60, latency_ms: null, status: 'down' },
      { checked_at: 0, latency_ms: 22, status: 'maintenance' },
    ]);
  });

  it('does not let an older runtime snapshot overwrite a newer one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1970-01-01T00:02:20.000Z'));

    try {
      const rows = new Map<
        string,
        { generated_at: number; body_json: string; updated_at: number }
      >();
      const db = createFakeD1Database([
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            const tuples = [
              args.slice(0, 4) as [string, number, string, number],
              args.slice(4, 8) as [string, number, string, number],
            ];
            for (const [key, generatedAt, bodyJson, updatedAt] of tuples) {
              const existing = rows.get(key);
              if (!existing || generatedAt >= existing.generated_at) {
                rows.set(key, {
                  generated_at: generatedAt,
                  body_json: bodyJson,
                  updated_at: updatedAt,
                });
              }
            }
            return { meta: { changes: 1 } };
          },
        },
      ]);

      const newer: PublicMonitorRuntimeSnapshot = {
        version: 1,
        generated_at: 120,
        day_start_at: 0,
        monitors: [],
      };
      const older: PublicMonitorRuntimeSnapshot = {
        version: 1,
        generated_at: 90,
        day_start_at: 0,
        monitors: [],
      };

      await writePublicMonitorRuntimeSnapshot(db, newer, 140);
      vi.setSystemTime(new Date('1970-01-01T00:02:40.000Z'));
      await writePublicMonitorRuntimeSnapshot(db, older, 160);

      expect(rows.get('monitor-runtime')).toEqual({
        generated_at: 120,
        body_json: JSON.stringify(newer),
        updated_at: 140,
      });
      expect(rows.get('monitor-runtime:totals')).toEqual({
        generated_at: 120,
        body_json: JSON.stringify({
          version: 1,
          generated_at: 120,
          day_start_at: 0,
          monitors: [],
        }),
        updated_at: 140,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the actual write time when deciding whether an existing snapshot is truly future-dated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1970-01-01T00:03:20.000Z'));

    try {
      const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>(
        [
          [
            'monitor-runtime',
            {
              generated_at: 170,
              body_json: JSON.stringify({
                version: 1,
                generated_at: 170,
                day_start_at: 0,
                monitors: [],
              }),
              updated_at: 170,
            },
          ],
          [
            'monitor-runtime:totals',
            {
              generated_at: 170,
              body_json: JSON.stringify({
                version: 1,
                generated_at: 170,
                day_start_at: 0,
                monitors: [],
              }),
              updated_at: 170,
            },
          ],
        ],
      );
      const db = createFakeD1Database([
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            const futureCutoff = args[8] as number;
            const tuples = [
              args.slice(0, 4) as [string, number, string, number],
              args.slice(4, 8) as [string, number, string, number],
            ];
            for (const [key, generatedAt, bodyJson, updatedAt] of tuples) {
              const existing = rows.get(key);
              if (
                !existing ||
                generatedAt >= existing.generated_at ||
                existing.generated_at > futureCutoff
              ) {
                rows.set(key, {
                  generated_at: generatedAt,
                  body_json: bodyJson,
                  updated_at: updatedAt,
                });
              }
            }
            return { meta: { changes: 1 } };
          },
        },
      ]);

      await writePublicMonitorRuntimeSnapshot(
        db,
        {
          version: 1,
          generated_at: 100,
          day_start_at: 0,
          monitors: [],
        },
        100,
      );

      expect(rows.get('monitor-runtime')).toMatchObject({
        generated_at: 170,
        updated_at: 170,
      });
      expect(rows.get('monitor-runtime:totals')).toMatchObject({
        generated_at: 170,
        updated_at: 170,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats future runtime snapshots as unreadable and lets real snapshots self-heal them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1970-01-01T00:01:40.000Z'));

    try {
      const rows = new Map<
        string,
        { generated_at: number; body_json: string; updated_at: number }
      >();
      const db = createFakeD1Database([
        {
          match: 'from public_snapshots',
          first: (args) => rows.get(args[0] as string) ?? null,
        },
        {
          match: 'insert into public_snapshots',
          run: (args) => {
            const futureCutoff = args[8] as number;
            const tuples = [
              args.slice(0, 4) as [string, number, string, number],
              args.slice(4, 8) as [string, number, string, number],
            ];
            for (const [key, generatedAt, bodyJson, updatedAt] of tuples) {
              const existing = rows.get(key);
              if (
                !existing ||
                generatedAt >= existing.generated_at ||
                existing.generated_at > futureCutoff
              ) {
                rows.set(key, {
                  generated_at: generatedAt,
                  body_json: bodyJson,
                  updated_at: updatedAt,
                });
              }
            }
            return { meta: { changes: 1 } };
          },
        },
      ]);

      const future: PublicMonitorRuntimeSnapshot = {
        version: 1,
        generated_at: 1_000,
        day_start_at: 0,
        monitors: [],
      };
      const real: PublicMonitorRuntimeSnapshot = {
        version: 1,
        generated_at: 200,
        day_start_at: 0,
        monitors: [],
      };

      await writePublicMonitorRuntimeSnapshot(db, future, 100);
      await expect(readPublicMonitorRuntimeSnapshot(db, 100)).resolves.toBeNull();
      await expect(readPublicMonitorRuntimeTotalsSnapshot(db, 100)).resolves.toBeNull();

      vi.setSystemTime(new Date('1970-01-01T00:03:20.000Z'));
      await writePublicMonitorRuntimeSnapshot(db, real, 200);

      expect(rows.get('monitor-runtime')).toEqual({
        generated_at: 200,
        body_json: JSON.stringify(real),
        updated_at: 200,
      });
      expect(rows.get('monitor-runtime:totals')).toEqual({
        generated_at: 200,
        body_json: JSON.stringify({
          version: 1,
          generated_at: 200,
          day_start_at: 0,
          monitors: [],
        }),
        updated_at: 200,
      });
      await expect(readPublicMonitorRuntimeSnapshot(db, 200)).resolves.toEqual(real);
      await expect(readPublicMonitorRuntimeTotalsSnapshot(db, 200)).resolves.toEqual({
        version: 1,
        generated_at: 200,
        day_start_at: 0,
        monitors: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse a per-db runtime snapshot cache entry when body_json changes in place', async () => {
    let runtimeBodyJson = JSON.stringify({
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [],
    });
    let totalsBodyJson = JSON.stringify({
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [],
    });
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          const [key] = args as [string];
          if (key === 'monitor-runtime') {
            return {
              generated_at: 120,
              updated_at: 120,
              body_json: runtimeBodyJson,
            };
          }
          if (key === 'monitor-runtime:totals') {
            return {
              generated_at: 120,
              updated_at: 120,
              body_json: totalsBodyJson,
            };
          }
          return null;
        },
      },
    ]);

    await expect(readPublicMonitorRuntimeSnapshot(db, 120)).resolves.toEqual({
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [],
    });
    runtimeBodyJson = JSON.stringify({
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 9,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 120,
          last_checked_at: 120,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 120,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 120,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [42],
          heartbeat_status_codes: 'u',
        },
      ],
    });
    totalsBodyJson = JSON.stringify({
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 9,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 120,
          last_checked_at: 120,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 120,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 120,
        },
      ],
    });

    await expect(readPublicMonitorRuntimeSnapshot(db, 120)).resolves.toMatchObject({
      monitors: [
        expect.objectContaining({
          monitor_id: 9,
          heartbeat_status_codes: 'u',
        }),
      ],
    });
    await expect(readPublicMonitorRuntimeTotalsSnapshot(db, 120)).resolves.toMatchObject({
      monitors: [
        expect.objectContaining({
          monitor_id: 9,
          total_sec: 120,
        }),
      ],
    });
  });

  it('rebuilds when a newly backfilled monitor first lands exactly one interval after day start', async () => {
    const storedSnapshot = {
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 120,
          last_checked_at: 120,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 120,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 120,
          heartbeat_gap_sec: '1o',
          heartbeat_latency_ms: [42, 40],
          heartbeat_status_codes: 'uu',
        },
      ],
    } satisfies PublicMonitorRuntimeSnapshot;
    const rebuiltSnapshot = {
      ...storedSnapshot,
      generated_at: 180,
      monitors: [
        ...storedSnapshot.monitors,
        {
          monitor_id: 2,
          created_at: -60,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 180,
          last_checked_at: 60,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 60,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 60,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [25],
          heartbeat_status_codes: 'u',
        },
      ],
    } satisfies PublicMonitorRuntimeSnapshot;
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          const [key] = args as [string];
          if (key !== 'monitor-runtime') {
            return null;
          }
          return {
            generated_at: storedSnapshot.generated_at,
            updated_at: storedSnapshot.generated_at,
            body_json: JSON.stringify(storedSnapshot),
          };
        },
      },
      {
        match: 'insert into public_snapshots',
        run: () => ({ meta: { changes: 1 } }),
      },
    ]);
    const rebuild = async () => rebuiltSnapshot;

    const snapshot = await refreshPublicMonitorRuntimeSnapshot({
      db,
      now: 180,
      updates: [
        {
          monitor_id: 2,
          interval_sec: 60,
          created_at: -60,
          checked_at: 60,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 25,
        },
      ],
      rebuild,
    });

    expect(snapshot).toEqual(rebuiltSnapshot);
  });

  it('prefers the compact totals snapshot key on read', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => {
          const [key] = args as [string];
          if (key !== 'monitor-runtime:totals') {
            return null;
          }

          return {
            generated_at: 120,
            updated_at: 120,
            body_json: JSON.stringify({
              version: 1,
              generated_at: 120,
              day_start_at: 0,
              monitors: [
                {
                  monitor_id: 1,
                  interval_sec: 60,
                  range_start_at: 0,
                  materialized_at: 120,
                  last_checked_at: 120,
                  last_status_code: 'u',
                  last_outage_open: false,
                  total_sec: 120,
                  downtime_sec: 0,
                  unknown_sec: 0,
                  uptime_sec: 120,
                },
              ],
            }),
          };
        },
      },
    ]);

    const snapshot = await readPublicMonitorRuntimeTotalsSnapshot(db, 120);
    expect(snapshot).toMatchObject({
      monitors: [
        {
          monitor_id: 1,
          total_sec: 120,
          uptime_sec: 120,
        },
      ],
    });
  });
});
