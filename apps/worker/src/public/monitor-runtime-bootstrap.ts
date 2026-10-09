import { computeTodayPartialUptimeBatch, listHeartbeatsByMonitorId } from './data';
import {
  MONITOR_RUNTIME_HEARTBEAT_POINTS,
  MONITOR_RUNTIME_SNAPSHOT_VERSION,
  type PublicMonitorRuntimeSnapshot,
  runtimeHeartbeatsToGapSec,
  toRuntimeStatusCode,
  utcDayStart,
} from './monitor-runtime';

type MonitorRuntimeSeedRow = {
  id: number;
  interval_sec: number;
  created_at: number;
  state_status: string | null;
  last_checked_at: number | null;
};

type RuntimeHeartbeatSeed = {
  checked_at: number;
  latency_ms: number | null;
  status: 'up' | 'down' | 'maintenance' | 'unknown';
};

function zeroTotals() {
  return {
    total_sec: 0,
    downtime_sec: 0,
    unknown_sec: 0,
    uptime_sec: 0,
    uptime_pct: null,
  };
}

export async function rebuildPublicMonitorRuntimeSnapshot(
  db: D1Database,
  now: number,
): Promise<PublicMonitorRuntimeSnapshot> {
  const dayStart = utcDayStart(now);
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.interval_sec,
        m.created_at,
        s.status AS state_status,
        s.last_checked_at
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
      ORDER BY m.id
    `,
    )
    .all<MonitorRuntimeSeedRow>();

  const rows = results ?? [];
  const monitorIds = rows.map((row) => row.id);
  const [heartbeatsByMonitorId, todayByMonitorId] = await Promise.all([
    monitorIds.length > 0
      ? listHeartbeatsByMonitorId(db, monitorIds, MONITOR_RUNTIME_HEARTBEAT_POINTS)
      : Promise.resolve(new Map()),
    rows.length > 0
      ? computeTodayPartialUptimeBatch(
          db,
          rows.map((row) => ({
            id: row.id,
            interval_sec: row.interval_sec,
            created_at: row.created_at,
            last_checked_at: row.last_checked_at,
          })),
          dayStart,
          now,
        )
      : Promise.resolve(new Map()),
  ]);

  return {
    version: MONITOR_RUNTIME_SNAPSHOT_VERSION,
    generated_at: now,
    day_start_at: dayStart,
    monitors: rows.map((row) => {
      const heartbeats = (heartbeatsByMonitorId.get(row.id) ?? []) as RuntimeHeartbeatSeed[];
      const latestHeartbeat = heartbeats[0] ?? null;
      const today = todayByMonitorId.get(row.id) ?? zeroTotals();
      const range_start_at =
        today.total_sec > 0
          ? Math.max(0, now - today.total_sec)
          : row.created_at >= dayStart
            ? (latestHeartbeat?.checked_at ?? null)
            : dayStart;

      return {
        monitor_id: row.id,
        created_at: row.created_at,
        interval_sec: row.interval_sec,
        range_start_at,
        materialized_at: now,
        last_checked_at: latestHeartbeat?.checked_at ?? row.last_checked_at ?? null,
        last_status_code: toRuntimeStatusCode(latestHeartbeat?.status ?? row.state_status),
        last_outage_open: row.state_status === 'down',
        total_sec: today.total_sec,
        downtime_sec: today.downtime_sec,
        unknown_sec: today.unknown_sec,
        uptime_sec: today.uptime_sec,
        heartbeat_gap_sec: runtimeHeartbeatsToGapSec(
          heartbeats.map((heartbeat) => heartbeat.checked_at),
        ),
        heartbeat_latency_ms: heartbeats.map((heartbeat) => heartbeat.latency_ms),
        heartbeat_status_codes: heartbeats
          .map((heartbeat) => toRuntimeStatusCode(heartbeat.status))
          .join(''),
      };
    }),
  };
}
