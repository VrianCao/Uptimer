import { useMemo } from 'react';

import type { PublicMonitor } from '../api/types';
import { HeartbeatBar } from './HeartbeatBar';
import { UptimeBar30d } from './UptimeBar30d';
import { Badge, Card, StatusDot } from './ui';
import { formatTime } from '../utils/datetime';
import {
  formatLatency,
  formatPct,
  getUptimeBgClasses,
  getUptimePillClasses,
  getUptimeTier,
} from '../utils/uptime';

const HEARTBEAT_BARS = 60;
const AVAILABILITY_BARS = 60;

export interface MonitorCardProps {
  monitor: PublicMonitor;
  timeZone: string;
  onSelect: () => void;
  onDayClick: (dayStartAt: number) => void;
}

function getHeartbeatLatencyStats(heartbeats: PublicMonitor['heartbeats']): {
  fastestMs: number | null;
  avgMs: number | null;
  slowestMs: number | null;
} {
  const latencies = heartbeats
    .filter((hb) => hb.status === 'up' && hb.latency_ms !== null)
    .map((hb) => hb.latency_ms as number);

  if (latencies.length === 0) {
    return { fastestMs: null, avgMs: null, slowestMs: null };
  }

  const fastestMs = Math.min(...latencies);
  const slowestMs = Math.max(...latencies);
  const avgMs = Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length);

  return { fastestMs, avgMs, slowestMs };
}

export function MonitorCard({ monitor, onSelect, onDayClick, timeZone }: MonitorCardProps) {
  const uptime30d = monitor.uptime_30d;
  const checkedAt = monitor.last_checked_at
    ? (timeZone ? formatTime(monitor.last_checked_at, { timeZone }) : formatTime(monitor.last_checked_at))
    : 'Never checked';
  const latencyStats = useMemo(
    () => getHeartbeatLatencyStats(monitor.heartbeats ?? []),
    [monitor.heartbeats],
  );

  const tier = uptime30d ? getUptimeTier(uptime30d.uptime_pct, monitor.uptime_rating_level) : null;

  return (
    <Card hover onClick={onSelect} className="p-3 sm:p-4">
      {/* Header */}
      <div className="mb-2.5 sm:mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2.5">
          <StatusDot status={monitor.status} pulse={monitor.status === 'down'} size="sm" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold leading-tight text-slate-900 dark:text-slate-100">
              {monitor.name}
            </h3>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span>{monitor.type}</span>
              {monitor.is_stale && (
                <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                  stale
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {uptime30d && tier ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${getUptimePillClasses(tier)}`}
              title="30-day availability"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${getUptimeBgClasses(tier)}`} />
              {formatPct(uptime30d.uptime_pct)}
            </span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-slate-500">-</span>
          )}
          <Badge variant={monitor.status}>{monitor.status}</Badge>
        </div>
      </div>

      {/* Availability (30d) */}
      <div>
        <div className="mb-2 text-[11px] text-slate-400 dark:text-slate-500">30-day availability</div>
        <UptimeBar30d
          days={monitor.uptime_days}
          ratingLevel={monitor.uptime_rating_level}
          maxBars={AVAILABILITY_BARS}
          timeZone={timeZone}
          onDayClick={onDayClick}
          density="compact"
        />
      </div>

      {/* Heartbeat */}
      <div className="mt-2">
        <div className="mb-2 text-[11px] text-slate-400 dark:text-slate-500">Last {HEARTBEAT_BARS} checks</div>
        <HeartbeatBar
          heartbeats={monitor.heartbeats ?? []}
          maxBars={HEARTBEAT_BARS}
          density="compact"
        />
      </div>

      {/* Latency + timestamp footer */}
      <div className="mt-2 sm:mt-2.5 flex flex-wrap items-baseline justify-between gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-baseline gap-2 sm:gap-3 tabular-nums">
          <span><span className="text-slate-400 dark:text-slate-500">fast</span> {formatLatency(latencyStats.fastestMs)}</span>
          <span><span className="text-slate-400 dark:text-slate-500">avg</span> {formatLatency(latencyStats.avgMs)}</span>
          <span><span className="text-slate-400 dark:text-slate-500">slow</span> {formatLatency(latencyStats.slowestMs)}</span>
        </div>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          {monitor.last_checked_at ? checkedAt : 'Never checked'}
        </span>
      </div>
    </Card>
  );
}
