import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchLatency, fetchPublicDayContext, fetchPublicIncidents, fetchPublicMaintenanceWindows, fetchPublicMonitorOutages, fetchStatus } from '../api/client';
import type { Incident, MaintenanceWindow, MonitorStatus, Outage, PublicMonitor, StatusResponse } from '../api/types';
import { DayDowntimeModal } from '../components/DayDowntimeModal';
import { HeartbeatBar } from '../components/HeartbeatBar';
import { Markdown } from '../components/Markdown';
import { UptimeBar30d } from '../components/UptimeBar30d';
import { formatDateTime, formatTime } from '../utils/datetime';
import {
  Badge,
  Card,
  MODAL_OVERLAY_CLASS,
  MODAL_PANEL_CLASS,
  StatusDot,
  ThemeToggle,
} from '../components/ui';

type MaintenanceHistoryPreview = Pick<MaintenanceWindow, 'id' | 'title' | 'message' | 'starts_at' | 'ends_at' | 'monitor_ids'>;

type BannerStatus = StatusResponse['banner']['status'];

const LatencyChart = lazy(async () => {
  const mod = await import('../components/LatencyChart');
  return { default: mod.LatencyChart };
});

function getBannerConfig(status: BannerStatus) {
  const configs = {
    operational: {
      bg: 'from-emerald-500 to-emerald-600',
      text: 'All Systems Operational',
      icon: '✓',
    },
    partial_outage: {
      bg: 'from-amber-500 to-orange-500',
      text: 'Partial System Outage',
      icon: '!',
    },
    major_outage: {
      bg: 'from-red-500 to-red-600',
      text: 'Major System Outage',
      icon: '✕',
    },
    maintenance: {
      bg: 'from-blue-500 to-blue-600',
      text: 'Scheduled Maintenance',
      icon: '⚙',
    },
    unknown: {
      bg: 'from-slate-500 to-slate-600',
      text: 'Status Unknown',
      icon: '?',
    },
  };
  return configs[status] || configs.unknown;
}

function getStatusBadgeVariant(
  status: MonitorStatus,
): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  return status as 'up' | 'down' | 'maintenance' | 'paused' | 'unknown';
}

function formatPct(v: number): string {
  if (!Number.isFinite(v)) return '-';
  return `${v.toFixed(3)}%`;
}

function formatLatency(v: number | null): string {
  return v === null ? '-' : `${v}ms`;
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

const HEARTBEAT_BARS = 60;
const AVAILABILITY_BARS = 60;

type UptimeTier = 'emerald' | 'green' | 'lime' | 'yellow' | 'amber' | 'orange' | 'red' | 'rose' | 'slate';

const UPTIME_THRESHOLDS_BY_LEVEL: Record<
  1 | 2 | 3 | 4 | 5,
  { emerald: number; green: number; lime: number; yellow: number; amber: number; orange: number; red: number }
> = {
  1: { emerald: 99.0, green: 98.0, lime: 97.0, yellow: 96.0, amber: 95.0, orange: 90.0, red: 80.0 },
  2: { emerald: 99.9, green: 99.5, lime: 99.0, yellow: 98.5, amber: 98.0, orange: 97.0, red: 95.0 },
  3: { emerald: 99.99, green: 99.95, lime: 99.9, yellow: 99.5, amber: 99.0, orange: 98.0, red: 97.0 },
  4: { emerald: 99.999, green: 99.995, lime: 99.99, yellow: 99.95, amber: 99.9, orange: 99.5, red: 99.0 },
  5: { emerald: 100.0, green: 99.999, lime: 99.995, yellow: 99.99, amber: 99.95, orange: 99.9, red: 99.5 },
};

function getUptimeTier(uptimePct: number, level: 1 | 2 | 3 | 4 | 5): UptimeTier {
  if (!Number.isFinite(uptimePct)) return 'slate';

  const t = UPTIME_THRESHOLDS_BY_LEVEL[level] ?? UPTIME_THRESHOLDS_BY_LEVEL[3];

  if (uptimePct >= t.emerald) return 'emerald';
  if (uptimePct >= t.green) return 'green';
  if (uptimePct >= t.lime) return 'lime';
  if (uptimePct >= t.yellow) return 'yellow';
  if (uptimePct >= t.amber) return 'amber';
  if (uptimePct >= t.orange) return 'orange';
  if (uptimePct >= t.red) return 'red';
  return 'rose';
}

function getUptimeDotBgClasses(uptimePct: number, level: 1 | 2 | 3 | 4 | 5): string {
  switch (getUptimeTier(uptimePct, level)) {
    case 'emerald':
      return 'bg-emerald-500 dark:bg-emerald-400';
    case 'green':
      return 'bg-green-500 dark:bg-green-400';
    case 'lime':
      return 'bg-lime-500 dark:bg-lime-400';
    case 'yellow':
      return 'bg-yellow-500 dark:bg-yellow-400';
    case 'amber':
      return 'bg-amber-500 dark:bg-amber-400';
    case 'orange':
      return 'bg-orange-500 dark:bg-orange-400';
    case 'red':
      return 'bg-red-500 dark:bg-red-400';
    case 'rose':
      return 'bg-rose-600 dark:bg-rose-400';
    case 'slate':
    default:
      return 'bg-slate-300 dark:bg-slate-600';
  }
}

function getAvailabilityPillClasses(uptimePct: number, level: 1 | 2 | 3 | 4 | 5): string {
  switch (getUptimeTier(uptimePct, level)) {
    case 'emerald':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800/60';
    case 'green':
      return 'bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-800/60';
    case 'lime':
      return 'bg-lime-50 text-lime-800 border-lime-200 dark:bg-lime-950/40 dark:text-lime-200 dark:border-lime-800/60';
    case 'yellow':
      return 'bg-yellow-50 text-yellow-900 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-800/60';
    case 'amber':
      return 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800/60';
    case 'orange':
      return 'bg-orange-50 text-orange-900 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-800/60';
    case 'red':
      return 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-800/60';
    case 'rose':
      return 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-800/60';
    case 'slate':
    default:
      return 'bg-slate-100/80 text-slate-700 border-slate-200 dark:bg-slate-700/50 dark:text-slate-200 dark:border-slate-600/60';
  }
}

function MonitorCard({ monitor, onSelect, onDayClick, timeZone }: { monitor: PublicMonitor; onSelect: () => void; onDayClick: (dayStartAt: number) => void; timeZone: string }) {
  const uptime30d = monitor.uptime_30d;
  const checkedAt = monitor.last_checked_at
    ? (timeZone ? formatTime(monitor.last_checked_at, { timeZone }) : formatTime(monitor.last_checked_at))
    : 'Never checked';
  const latencyStats = useMemo(
    () => getHeartbeatLatencyStats(monitor.heartbeats ?? []),
    [monitor.heartbeats],
  );

  return (
    <Card hover onClick={onSelect} className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2.5">
          <StatusDot status={monitor.status} pulse={monitor.status === 'down'} size="sm" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold leading-tight text-slate-900 dark:text-slate-100 sm:text-[1.05rem]">
              {monitor.name}
            </h3>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
              <span>{monitor.type}</span>
              {monitor.is_stale && (
                <span className="rounded bg-amber-100 px-1.5 py-[1px] text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                  stale
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {uptime30d ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${getAvailabilityPillClasses(uptime30d.uptime_pct, monitor.uptime_rating_level)}`}
              title="Average availability over the last 30 days"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${getUptimeDotBgClasses(uptime30d.uptime_pct, monitor.uptime_rating_level)}`}
              />
              {formatPct(uptime30d.uptime_pct)}
            </span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-slate-500">30d -</span>
          )}
          <div className="leading-none">
            <Badge variant={getStatusBadgeVariant(monitor.status)}>{monitor.status}</Badge>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span className="uppercase tracking-[0.12em]">Availability (30d)</span>
            <span>Last 30 days</span>
          </div>
          <UptimeBar30d
            days={monitor.uptime_days}
            ratingLevel={monitor.uptime_rating_level}
            maxBars={AVAILABILITY_BARS}
            timeZone={timeZone}
            onDayClick={onDayClick}
            fillMode="stretch"
            density="compact"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span className="uppercase tracking-[0.12em]">Heartbeat</span>
            <span>Last {HEARTBEAT_BARS} checks</span>
          </div>
          <HeartbeatBar
            heartbeats={monitor.heartbeats ?? []}
            maxBars={HEARTBEAT_BARS}
            density="compact"
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {[
          { label: 'Fastest', value: latencyStats.fastestMs },
          { label: 'Avg', value: latencyStats.avgMs },
          { label: 'Slowest', value: latencyStats.slowestMs },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-md border border-slate-200/80 bg-slate-50/85 px-2 py-1 dark:border-slate-700/80 dark:bg-slate-800/70"
          >
            <div className="text-[10px] uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">
              {item.label}
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {formatLatency(item.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-end text-[11px] text-slate-400 dark:text-slate-500">
        {monitor.last_checked_at ? `Updated ${checkedAt}` : checkedAt}
      </div>
    </Card>
  );
}

function MonitorDetail({ monitorId, onClose }: { monitorId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['latency', monitorId],
    queryFn: () => fetchLatency(monitorId),
  });

  return (
    <div
      className={MODAL_OVERLAY_CLASS}
      onClick={onClose}
    >
      <div
        className={`${MODAL_PANEL_CLASS} sm:max-w-2xl p-5 sm:p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {data?.monitor.name ?? 'Loading...'}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {isLoading ? (
          <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
            Loading chart...
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:gap-6 mb-6">
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 sm:px-4 py-2.5 sm:py-3">
                <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                  Avg Latency
                </div>
                <div className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {data.avg_latency_ms ?? '-'}ms
                </div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 sm:px-4 py-2.5 sm:py-3">
                <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                  P95 Latency
                </div>
                <div className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {data.p95_latency_ms ?? '-'}ms
                </div>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
                  Loading chart...
                </div>
              }
            >
              <LatencyChart points={data.points} />
            </Suspense>
          </>
        ) : (
          <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
            Failed to load data
          </div>
        )}
      </div>
    </div>
  );
}

function IncidentCard({ incident, onClick, timeZone }: { incident: Incident; onClick: () => void; timeZone: string }) {
  return (
    <button
      onClick={onClick}
      className="ui-panel ui-panel-hover w-full rounded-xl p-5 text-left"
    >
      <div className="flex items-start justify-between gap-4 mb-2">
        <h4 className="font-semibold text-slate-900 dark:text-slate-100">{incident.title}</h4>
        <Badge
          variant={
            incident.impact === 'critical'
              ? 'down'
              : incident.impact === 'major'
                ? 'down'
                : 'paused'
          }
        >
          {incident.impact}
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 mb-3">
        <Badge variant="info">{incident.status}</Badge>
        <span>{formatDateTime(incident.started_at, timeZone)}</span>
      </div>
      {incident.message && (
        <p className="text-sm text-slate-600 dark:text-slate-300 line-clamp-2">{incident.message}</p>
      )}
    </button>
  );
}

function IncidentDetail({
  incident,
  monitorNames,
  onClose,
  timeZone,
}: {
  incident: Incident;
  monitorNames: Map<number, string>;
  onClose: () => void;
  timeZone: string;
}) {
  return (
    <div
      className={MODAL_OVERLAY_CLASS}
      onClick={onClose}
    >
      <div
        className={`${MODAL_PANEL_CLASS} sm:max-w-2xl p-5 sm:p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4 sm:mb-6">
          <div>
            <h2 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
              {incident.title}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  incident.impact === 'critical' || incident.impact === 'major' ? 'down' : 'paused'
                }
              >
                {incident.impact}
              </Badge>
              <Badge variant="info">{incident.status}</Badge>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-2 sm:space-y-3 text-sm text-slate-600 dark:text-slate-300 mb-4 sm:mb-6 pb-4 sm:pb-6 border-b border-slate-100 dark:border-slate-700">
          <div className="flex flex-col sm:flex-row sm:gap-2">
            <span className="text-slate-400 dark:text-slate-500 sm:w-20 text-xs sm:text-sm">
              Affected:
            </span>
            <span className="text-sm">
              {incident.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:gap-2">
            <span className="text-slate-400 dark:text-slate-500 sm:w-20 text-xs sm:text-sm">
              Started:
            </span>
            <span className="text-sm">{formatDateTime(incident.started_at, timeZone)}</span>
          </div>
          {incident.resolved_at && (
            <div className="flex flex-col sm:flex-row sm:gap-2">
              <span className="text-slate-400 dark:text-slate-500 sm:w-20 text-xs sm:text-sm">
                Resolved:
              </span>
              <span className="text-sm">{formatDateTime(incident.resolved_at, timeZone)}</span>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {incident.message && (
            <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">
                Initial Report
              </div>
              <Markdown text={incident.message} />
            </div>
          )}

          {incident.updates.map((u) => (
            <div key={u.id} className="border-l-2 border-slate-200 dark:border-slate-600 pl-4">
              <div className="flex items-center gap-3 mb-2">
                {u.status && <Badge variant="info">{u.status}</Badge>}
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {formatDateTime(u.created_at, timeZone)}
                </span>
              </div>
              <Markdown text={u.message} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusPageSkeleton() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/95 backdrop-blur dark:border-slate-700/80 dark:bg-slate-800/95">
        <div className="mx-auto max-w-[88rem] px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <div className="ui-skeleton h-6 w-28 rounded" />
          <div className="ui-skeleton h-8 w-20 rounded-full" />
        </div>
      </header>

      <main className="mx-auto max-w-[88rem] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="ui-skeleton h-20 sm:h-24 rounded-2xl mb-8" />

        <section>
          <div className="h-6 w-24 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Card key={idx} className="p-4 sm:p-5">
                <div className="mb-2.5 flex items-start justify-between">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="h-3 w-3 rounded-full bg-slate-200 dark:bg-slate-700" />
                    <div className="min-w-0">
                      <div className="mb-1.5 h-4 w-32 rounded bg-slate-200 dark:bg-slate-700" />
                      <div className="h-3 w-12 rounded bg-slate-200 dark:bg-slate-700" />
                    </div>
                  </div>
                  <div className="h-5 w-14 rounded-full bg-slate-200 dark:bg-slate-700" />
                </div>
                <div className="mb-2.5 h-5 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="flex justify-between">
                  <div className="h-3.5 w-20 rounded bg-slate-200 dark:bg-slate-700" />
                  <div className="h-3.5 w-24 rounded bg-slate-200 dark:bg-slate-700" />
                </div>
              </Card>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export function StatusPage() {
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [selectedDay, setSelectedDay] = useState<{ monitorId: number; dayStartAt: number } | null>(null);

  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: fetchStatus,
    refetchInterval: 30_000,
  });

  const derivedTitle = statusQuery.data?.site_title || 'Uptimer';
  const derivedTimeZone = statusQuery.data?.site_timezone || 'UTC';

  useEffect(() => {
    document.title = derivedTitle;
  }, [derivedTitle]);

  const outagesQuery = useQuery({
    queryKey: ['public-monitor-outages', selectedDay?.monitorId, selectedDay?.dayStartAt],
    queryFn: () => fetchPublicMonitorOutages(selectedDay?.monitorId as number, { range: '30d', limit: 200 }),
    enabled: selectedDay !== null,
  });

  const dayContextQuery = useQuery({
    queryKey: ['public-day-context', selectedDay?.monitorId, selectedDay?.dayStartAt],
    queryFn: () => fetchPublicDayContext(selectedDay?.monitorId as number, selectedDay?.dayStartAt as number),
    enabled: selectedDay !== null,
  });

  const currentDayOutages = useMemo((): Outage[] => {
    if (!selectedDay) return [];
    const all = outagesQuery.data?.outages ?? [];
    const dayStart = selectedDay.dayStartAt;
    const dayEnd = dayStart + 86400;
    return all.filter((o) => o.started_at < dayEnd && (o.ended_at ?? dayEnd) > dayStart);
  }, [outagesQuery.data?.outages, selectedDay]);

  const resolvedHistoryQuery = useQuery({
    queryKey: ['public-incidents', 'resolved', 'preview'],
    queryFn: () => fetchPublicIncidents(1, undefined, { resolvedOnly: true }),
    enabled: statusQuery.isSuccess,
  });

  const maintenanceHistoryQuery = useQuery({
    queryKey: ['public-maintenance-windows', 'history', 'preview'],
    queryFn: () => fetchPublicMaintenanceWindows(1),
    enabled: statusQuery.isSuccess,
  });

  const resolvedIncidentPreview = resolvedHistoryQuery.data?.incidents[0] ?? null;
  const maintenanceHistoryPreview = maintenanceHistoryQuery.data?.maintenance_windows[0] ?? null;

  const maintenanceHistoryPreviewSafe: MaintenanceHistoryPreview | null = maintenanceHistoryPreview
    ? {
        id: maintenanceHistoryPreview.id,
        title: maintenanceHistoryPreview.title,
        message: maintenanceHistoryPreview.message,
        starts_at: maintenanceHistoryPreview.starts_at,
        ends_at: maintenanceHistoryPreview.ends_at,
        monitor_ids: maintenanceHistoryPreview.monitor_ids,
      }
    : null;

  if (statusQuery.isLoading) {
    return <StatusPageSkeleton />;
  }

  if (!statusQuery.data) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Unable to load status
          </h2>
          <p className="text-slate-500 dark:text-slate-400">
            Please check your connection and try again.
          </p>
        </div>
      </div>
    );
  }

  const data = statusQuery.data;
  const bannerConfig = getBannerConfig(data.banner.status);
  const activeIncidents = data.active_incidents;
  const monitorNames = new Map(data.monitors.map((m) => [m.id, m.name] as const));

  const siteTitle = derivedTitle;
  const timeZone = derivedTimeZone;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/95 backdrop-blur dark:border-slate-700/80 dark:bg-slate-800/95">
        <div className="mx-auto max-w-[88rem] px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <Link to="/" className="flex flex-col justify-center min-w-0 min-h-9">
            <span className="text-xl sm:text-2xl font-bold leading-tight text-slate-900 dark:text-slate-100 truncate">{siteTitle}</span>
            {data.site_description ? (
              <span className="mt-0.5 text-sm leading-tight text-slate-500 dark:text-slate-400 truncate">{data.site_description}</span>
            ) : null}
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Status Banner */}
      <div className={`bg-gradient-to-r ${bannerConfig.bg} text-white`}>
        <div className="mx-auto max-w-[88rem] px-4 py-10 sm:px-6 sm:py-14 lg:px-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/20 text-2xl sm:text-3xl mb-3 sm:mb-4">
            {bannerConfig.icon}
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold mb-2">{bannerConfig.text}</h2>
          {data.banner.source === 'incident' && data.banner.incident && (
            <p className="text-white/80 text-base px-4">Incident: {data.banner.incident.title}</p>
          )}
          {data.banner.source === 'maintenance' && data.banner.maintenance_window && (
            <p className="text-white/80 text-base px-4">Maintenance: {data.banner.maintenance_window.title}</p>
          )}
          <p className="text-white/60 text-sm mt-3">
            Last updated: {formatDateTime(data.generated_at, timeZone)}
          </p>
        </div>
      </div>

      <main className="mx-auto max-w-[88rem] px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        {/* Maintenance Windows */}
        {(data.maintenance_windows.active.length > 0 || data.maintenance_windows.upcoming.length > 0) && (
          <section className="mb-10">
            <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4 flex items-center gap-2">
              <svg
                className="w-5 h-5 text-blue-500 dark:text-blue-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Maintenance
            </h3>

            {data.maintenance_windows.active.length > 0 && (
              <div className="mb-4">
                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">Active</div>
                <div className="space-y-3">
                  {data.maintenance_windows.active.map((w) => (
                    <Card
                      key={w.id}
                      className="p-4 sm:p-5 border-l-4 border-l-blue-500 dark:border-l-blue-400"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">{w.title}</h4>
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(w.starts_at, timeZone)} –{' '}
                          {formatDateTime(w.ends_at, timeZone)}
                        </span>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                        Affected: {w.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
                      </div>
                      {w.message && <Markdown text={w.message} />}
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {data.maintenance_windows.upcoming.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">Upcoming</div>
                <div className="space-y-3">
                  {data.maintenance_windows.upcoming.map((w) => (
                    <Card
                      key={w.id}
                      className="p-4 sm:p-5 border-l-4 border-l-slate-300 dark:border-l-slate-600"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">{w.title}</h4>
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(w.starts_at, timeZone)} –{' '}
                          {formatDateTime(w.ends_at, timeZone)}
                        </span>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-300">
                        Affected: {w.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Active Incidents */}
        {activeIncidents.length > 0 && (
          <section className="mb-10">
            <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4 flex items-center gap-2">
              <svg
                className="w-5 h-5 text-amber-500 dark:text-amber-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              Active Incidents
            </h3>
            <div className="space-y-3">
              {activeIncidents.map((it) => (
                <IncidentCard key={it.id} incident={it} timeZone={timeZone} onClick={() => setSelectedIncident(it)} />
              ))}
            </div>
          </section>
        )}

        {/* Monitors */}
        <section>
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4">Services</h3>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.monitors.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                timeZone={timeZone}
                onSelect={() => setSelectedMonitorId(monitor.id)}
                onDayClick={(dayStartAt) => setSelectedDay({ monitorId: monitor.id, dayStartAt })}
              />
            ))}
          </div>
          {data.monitors.length === 0 && (
            <Card className="p-8 text-center">
              <p className="text-slate-500 dark:text-slate-400">No monitors configured</p>
            </Card>
          )}
        </section>

        <section className="mt-12 pt-8 border-t border-slate-100 dark:border-slate-800 space-y-10">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Incident History</h3>
              <Link
                to="/history/incidents"
                className="text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                View more
              </Link>
            </div>

            {resolvedHistoryQuery.isLoading || resolvedHistoryQuery.isFetching ? (
              <div className="ui-skeleton h-28 rounded-xl border border-slate-200/70 dark:border-slate-700/70" />
            ) : resolvedHistoryQuery.isError ? (
              <Card className="p-6 text-center">
                <p className="text-sm text-red-600 dark:text-red-400">Failed to load incident history</p>
              </Card>
            ) : resolvedIncidentPreview ? (
              <IncidentCard
                incident={resolvedIncidentPreview}
                timeZone={timeZone}
                onClick={() => setSelectedIncident(resolvedIncidentPreview)}
              />
            ) : (
              <Card className="p-6 text-center">
                <p className="text-slate-500 dark:text-slate-400">No past incidents</p>
              </Card>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Maintenance History</h3>
              <Link
                to="/history/maintenance"
                className="text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                View more
              </Link>
            </div>

            {maintenanceHistoryQuery.isLoading || maintenanceHistoryQuery.isFetching ? (
              <div className="ui-skeleton h-28 rounded-xl border border-slate-200/70 dark:border-slate-700/70" />
            ) : maintenanceHistoryQuery.isError ? (
              <Card className="p-6 text-center">
                <p className="text-sm text-red-600 dark:text-red-400">Failed to load maintenance history</p>
              </Card>
            ) : maintenanceHistoryPreviewSafe ? (
              <Card className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                  <h4 className="font-semibold text-slate-900 dark:text-slate-100">{maintenanceHistoryPreviewSafe.title}</h4>
                  <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatDateTime(maintenanceHistoryPreviewSafe.starts_at, timeZone)} – {formatDateTime(maintenanceHistoryPreviewSafe.ends_at, timeZone)}
                  </span>
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                  Affected: {maintenanceHistoryPreviewSafe.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
                </div>
                {maintenanceHistoryPreviewSafe.message && <Markdown text={maintenanceHistoryPreviewSafe.message} />}
              </Card>
            ) : (
              <Card className="p-6 text-center">
                <p className="text-slate-500 dark:text-slate-400">No past maintenance windows</p>
              </Card>
            )}
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800">
        <div className="mx-auto max-w-[88rem] px-4 py-4 text-center text-base text-slate-400 dark:text-slate-500 sm:px-6 sm:py-6 lg:px-8">
          Powered by {siteTitle}
        </div>
      </footer>

      {/* Modals */}
      {selectedMonitorId !== null && (
        <MonitorDetail monitorId={selectedMonitorId} onClose={() => setSelectedMonitorId(null)} />
      )}

      {selectedIncident && (
        <IncidentDetail incident={selectedIncident} monitorNames={monitorNames} timeZone={timeZone} onClose={() => setSelectedIncident(null)} />
      )}

      {selectedDay && (
        <DayDowntimeModal
          dayStartAt={selectedDay.dayStartAt}
          outages={currentDayOutages}
          maintenanceWindows={dayContextQuery.data?.maintenance_windows ?? []}
          incidents={dayContextQuery.data?.incidents ?? []}
          timeZone={timeZone}
          onClose={() => setSelectedDay(null)}
        />
      )}

      {selectedDay && outagesQuery.isLoading && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/80 text-white text-sm px-3 py-2 rounded-lg">Loading outages…</div>
        </div>
      )}

      {selectedDay && outagesQuery.isError && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-red-600/90 text-white text-sm px-3 py-2 rounded-lg">Failed to load outages</div>
        </div>
      )}

      {selectedDay && dayContextQuery.isLoading && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/80 text-white text-sm px-3 py-2 rounded-lg">Loading context…</div>
        </div>
      )}

      {selectedDay && dayContextQuery.isError && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-red-600/90 text-white text-sm px-3 py-2 rounded-lg">Failed to load context</div>
        </div>
      )}
    </div>
  );
}
