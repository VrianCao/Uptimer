import { avg, buildLatencyHistogram, percentileFromValues } from '../analytics/latency';
import {
  buildUnknownIntervals,
  mergeIntervals,
  overlapSeconds,
  sumIntervals,
  utcDayStart,
  type Interval,
} from '../analytics/uptime';
import type { Env } from '../env';
import { refreshPublicAnalyticsOverviewSnapshotIfNeeded } from '../public/analytics-overview';
import { acquireLease } from './lock';

type MonitorRow = {
  id: number;
  interval_sec: number;
  created_at: number;
};

type OutageRow = { monitor_id: number; started_at: number; ended_at: number | null };

type CheckRow = {
  monitor_id: number;
  checked_at: number;
  status: string;
  latency_ms: number | null;
};

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

const LOCK_LEASE_SECONDS = 10 * 60;
const LOCK_PREFIX = 'analytics:daily-rollup:';
const DAILY_ROLLUP_MONITOR_BATCH_SIZE = 90;

function chunkMonitorRows(rows: readonly MonitorRow[], size: number): MonitorRow[][] {
  if (rows.length === 0) {
    return [];
  }

  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: MonitorRow[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(', ');
}

function groupRowsByMonitorId<T extends { monitor_id: number }>(
  rows: readonly T[],
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.monitor_id);
    if (existing) {
      existing.push(row);
      continue;
    }
    grouped.set(row.monitor_id, [row]);
  }
  return grouped;
}

function groupMonitorRowsByNumber(
  rows: readonly MonitorRow[],
  getKey: (row: MonitorRow) => number,
): Map<number, MonitorRow[]> {
  const grouped = new Map<number, MonitorRow[]>();
  for (const row of rows) {
    const key = getKey(row);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
      continue;
    }
    grouped.set(key, [row]);
  }
  return grouped;
}

async function listOutageRowsForMonitorBatch(
  db: D1Database,
  monitorIds: number[],
  rangeEnd: number,
  earliestRangeStart: number,
): Promise<OutageRow[]> {
  if (monitorIds.length === 0) {
    return [];
  }

  const placeholders = buildPlaceholders(monitorIds.length);
  const { results } = await db
    .prepare(
      `
        SELECT monitor_id, started_at, ended_at
        FROM outages
        WHERE monitor_id IN (${placeholders})
          AND started_at < ?${monitorIds.length + 1}
          AND (ended_at IS NULL OR ended_at > ?${monitorIds.length + 2})
        ORDER BY monitor_id, started_at
      `,
    )
    .bind(...monitorIds, rangeEnd, earliestRangeStart)
    .all<OutageRow>();

  return results ?? [];
}

async function listCheckRowsForMonitorBatch(
  db: D1Database,
  monitorIds: number[],
  checksStart: number,
  rangeEnd: number,
): Promise<CheckRow[]> {
  if (monitorIds.length === 0) {
    return [];
  }

  const placeholders = buildPlaceholders(monitorIds.length);
  const { results } = await db
    .prepare(
      `
        SELECT monitor_id, checked_at, status, latency_ms
        FROM check_results
        WHERE monitor_id IN (${placeholders})
          AND checked_at >= ?${monitorIds.length + 1}
          AND checked_at < ?${monitorIds.length + 2}
        ORDER BY monitor_id, checked_at
      `,
    )
    .bind(...monitorIds, checksStart, rangeEnd)
    .all<CheckRow>();

  return results ?? [];
}

export async function runDailyRollup(
  env: Env,
  controller: ScheduledController,
  _ctx: ExecutionContext,
): Promise<void> {
  const nowSec = Math.floor((controller.scheduledTime ?? Date.now()) / 1000);
  const todayStart = utcDayStart(nowSec);
  const targetDayStart = todayStart - 86400;
  const targetDayEnd = targetDayStart + 86400;

  const lockName = `${LOCK_PREFIX}${targetDayStart}`;
  const acquired = await acquireLease(env.DB, lockName, nowSec, LOCK_LEASE_SECONDS);
  if (!acquired) return;

  const { results: monitorRows } = await env.DB.prepare(
    `
      SELECT id, interval_sec, created_at
      FROM monitors
      WHERE created_at < ?1
      ORDER BY id
    `,
  )
    .bind(targetDayEnd)
    .all<MonitorRow>();

  const monitors = monitorRows ?? [];
  if (monitors.length === 0) {
    return;
  }

  const statements: D1PreparedStatement[] = [];
  let processed = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const monitorBatch of chunkMonitorRows(monitors, DAILY_ROLLUP_MONITOR_BATCH_SIZE)) {
    const rangeStartByMonitorId = new Map<number, number>();
    for (const monitor of monitorBatch) {
      rangeStartByMonitorId.set(monitor.id, Math.max(targetDayStart, monitor.created_at));
    }

    const earliestRangeStart = monitorBatch.reduce(
      (min, monitor) => Math.min(min, rangeStartByMonitorId.get(monitor.id) ?? targetDayEnd),
      targetDayEnd,
    );
    const monitorIds = monitorBatch.map((monitor) => monitor.id);
    const checkRowsByStart = groupMonitorRowsByNumber(
      monitorBatch,
      (monitor) =>
        (rangeStartByMonitorId.get(monitor.id) ?? targetDayStart) - monitor.interval_sec * 2,
    );
    const [outageRows, checkRowGroups] = await Promise.all([
      listOutageRowsForMonitorBatch(env.DB, monitorIds, targetDayEnd, earliestRangeStart),
      Promise.all(
        Array.from(checkRowsByStart.entries(), ([checksStart, group]) =>
          listCheckRowsForMonitorBatch(
            env.DB,
            group.map((monitor) => monitor.id),
            checksStart,
            targetDayEnd,
          ),
        ),
      ),
    ]);
    const outageRowsByMonitorId = groupRowsByMonitorId(outageRows);
    const checkRowsByMonitorId = groupRowsByMonitorId(checkRowGroups.flat());

    for (const m of monitorBatch) {
      const rangeStart = rangeStartByMonitorId.get(m.id) ?? targetDayStart;
      const rangeEnd = targetDayEnd;
      if (rangeEnd <= rangeStart) continue;

      const total_sec = Math.max(0, rangeEnd - rangeStart);

      const downtimeIntervals: Interval[] = mergeIntervals(
        (outageRowsByMonitorId.get(m.id) ?? [])
          .map((r) => {
            const start = Math.max(r.started_at, rangeStart);
            const end = Math.min(r.ended_at ?? rangeEnd, rangeEnd);
            return { start, end };
          })
          .filter((it) => it.end > it.start),
      );
      const downtime_sec = sumIntervals(downtimeIntervals);

      const checkRowsForMonitor = checkRowsByMonitorId.get(m.id) ?? [];
      const checks = checkRowsForMonitor.map((r) => ({
        checked_at: r.checked_at,
        status: toCheckStatus(r.status),
      }));

      const unknownIntervals = buildUnknownIntervals(rangeStart, rangeEnd, m.interval_sec, checks);
      const unknown_sec = Math.max(
        0,
        sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
      );

      const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
      const uptime_sec = Math.max(0, total_sec - unavailable_sec);

      let checks_up = 0;
      let checks_down = 0;
      let checks_unknown = 0;
      let checks_maintenance = 0;
      const latencies: number[] = [];

      for (const r of checkRowsForMonitor) {
        if (r.checked_at < rangeStart) continue;
        const st = toCheckStatus(r.status);
        if (st === 'up') {
          checks_up++;
          if (typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms)) {
            latencies.push(r.latency_ms);
          }
        } else if (st === 'down') {
          checks_down++;
        } else if (st === 'maintenance') {
          checks_maintenance++;
        } else {
          checks_unknown++;
        }
      }

      const checks_total = checks_up + checks_down + checks_unknown + checks_maintenance;

      const avg_latency_ms = avg(latencies);
      const p50_latency_ms = percentileFromValues(latencies, 0.5);
      const p95_latency_ms = percentileFromValues(latencies, 0.95);
      const latency_histogram_json = JSON.stringify(buildLatencyHistogram(latencies));

      statements.push(
        env.DB.prepare(
          `
            INSERT INTO monitor_daily_rollups (
              monitor_id,
              day_start_at,
              total_sec,
              downtime_sec,
              unknown_sec,
              uptime_sec,
              checks_total,
              checks_up,
              checks_down,
              checks_unknown,
              checks_maintenance,
              avg_latency_ms,
              p50_latency_ms,
              p95_latency_ms,
              latency_histogram_json,
              created_at,
              updated_at
            )
            VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, ?9, ?10, ?11,
              ?12, ?13, ?14, ?15,
              ?16, ?17
            )
            ON CONFLICT(monitor_id, day_start_at) DO UPDATE SET
              total_sec = excluded.total_sec,
              downtime_sec = excluded.downtime_sec,
              unknown_sec = excluded.unknown_sec,
              uptime_sec = excluded.uptime_sec,
              checks_total = excluded.checks_total,
              checks_up = excluded.checks_up,
              checks_down = excluded.checks_down,
              checks_unknown = excluded.checks_unknown,
              checks_maintenance = excluded.checks_maintenance,
              avg_latency_ms = excluded.avg_latency_ms,
              p50_latency_ms = excluded.p50_latency_ms,
              p95_latency_ms = excluded.p95_latency_ms,
              latency_histogram_json = excluded.latency_histogram_json,
              updated_at = excluded.updated_at
          `,
        ).bind(
          m.id,
          targetDayStart,
          total_sec,
          downtime_sec,
          unknown_sec,
          uptime_sec,
          checks_total,
          checks_up,
          checks_down,
          checks_unknown,
          checks_maintenance,
          avg_latency_ms,
          p50_latency_ms,
          p95_latency_ms,
          latency_histogram_json,
          now,
          now,
        ),
      );

      processed++;

      // Flush in batches to keep memory bounded.
      if (statements.length >= 50) {
        await env.DB.batch(statements.splice(0, statements.length));
      }
    }
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  await refreshPublicAnalyticsOverviewSnapshotIfNeeded({
    db: env.DB,
    now,
    fullDayEndAt: targetDayEnd,
    force: true,
  });

  console.log(
    `daily-rollup: processed ${processed}/${monitors.length} monitors for day_start_at=${targetDayStart}`,
  );
}
