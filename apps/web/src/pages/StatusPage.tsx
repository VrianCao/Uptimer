import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useI18n } from '../app/I18nContext';
import { useApplyServerLocaleSetting } from '../app/useApplyServerLocaleSetting';
import {
  fetchLatency,
  fetchHomepage,
  fetchPublicDayContext,
  fetchPublicIncidentDetail,
  fetchPublicMonitorOutages,
} from '../api/client';
import type { Incident, IncidentSummary, Outage, PublicHomepageResponse } from '../api/types';
import { DayDowntimeModal } from '../components/DayDowntimeModal';
import { Markdown } from '../components/Markdown';
import { MonitorCard } from '../components/MonitorCard';
import { incidentImpactLabel, incidentStatusLabel } from '../i18n/labels';
import { formatDateTime, getBrowserTimeZone } from '../utils/datetime';
import { Badge, Card, MODAL_OVERLAY_CLASS, MODAL_PANEL_CLASS, ThemeToggle } from '../components/ui';

type BannerStatus = PublicHomepageResponse['banner']['status'];
type IncidentCardData = IncidentSummary | Incident;

const LatencyChart = lazy(async () => {
  const mod = await import('../components/LatencyChart');
  return { default: mod.LatencyChart };
});

function getBannerConfig(status: BannerStatus, t: ReturnType<typeof useI18n>['t']) {
  const configs = {
    operational: {
      iconBg: 'bg-emerald-500',
      text: t('status_page.all_systems_operational'),
      icon: '✓',
    },
    partial_outage: {
      iconBg: 'bg-amber-500',
      text: t('status_page.partial_system_outage'),
      icon: '!',
    },
    major_outage: {
      iconBg: 'bg-red-500',
      text: t('status_page.major_system_outage'),
      icon: '✕',
    },
    maintenance: {
      iconBg: 'bg-blue-500',
      text: t('status_page.scheduled_maintenance'),
      icon: '⚙',
    },
    unknown: {
      iconBg: 'bg-slate-500',
      text: t('status_page.status_unknown'),
      icon: '?',
    },
  };
  return configs[status] || configs.unknown;
}

function monitorGroupLabel(groupName: string | null | undefined, ungroupedLabel: string): string {
  const trimmed = groupName?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : ungroupedLabel;
}

function MonitorDetail({ monitorId, onClose }: { monitorId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isLoading } = useQuery({
    queryKey: ['latency', monitorId],
    queryFn: () => fetchLatency(monitorId),
  });

  return (
    <div className={MODAL_OVERLAY_CLASS} onClick={onClose}>
      <div
        className={`${MODAL_PANEL_CLASS} sm:max-w-2xl p-5 sm:p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {data?.monitor.name ?? t('common.loading')}
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
            {t('status_page.loading_chart')}
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:gap-6 mb-6">
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 sm:px-4 py-2.5 sm:py-3">
                <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                  {t('status_page.avg_latency')}
                </div>
                <div className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {data.avg_latency_ms ?? '-'}ms
                </div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 sm:px-4 py-2.5 sm:py-3">
                <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                  {t('status_page.p95_latency')}
                </div>
                <div className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {data.p95_latency_ms ?? '-'}ms
                </div>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
                  {t('status_page.loading_chart')}
                </div>
              }
            >
              <LatencyChart points={data.points} />
            </Suspense>
          </>
        ) : (
          <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
            {t('status_page.failed_load_data')}
          </div>
        )}
      </div>
    </div>
  );
}

function IncidentCard({
  incident,
  onClick,
  timeZone,
}: {
  incident: IncidentCardData;
  onClick: () => void;
  timeZone: string;
}) {
  const { locale, t } = useI18n();

  return (
    <button
      onClick={onClick}
      className="ui-panel ui-panel-hover w-full rounded-xl p-3.5 sm:p-5 text-left"
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
          {incidentImpactLabel(incident.impact, t)}
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 mb-3">
        <Badge variant="info">{incidentStatusLabel(incident.status, t)}</Badge>
        <span>{formatDateTime(incident.started_at, timeZone, locale)}</span>
      </div>
      {incident.message && (
        <p className="text-sm text-slate-600 dark:text-slate-300 line-clamp-2">
          {incident.message}
        </p>
      )}
    </button>
  );
}

function IncidentDetail({
  incident,
  monitorNames,
  onClose,
  timeZone,
  isLoadingDetails,
  hasDetailsError,
}: {
  incident: Incident;
  monitorNames: Map<number, string>;
  onClose: () => void;
  timeZone: string;
  isLoadingDetails: boolean;
  hasDetailsError: boolean;
}) {
  const { locale, t } = useI18n();

  return (
    <div className={MODAL_OVERLAY_CLASS} onClick={onClose}>
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
                {incidentImpactLabel(incident.impact, t)}
              </Badge>
              <Badge variant="info">{incidentStatusLabel(incident.status, t)}</Badge>
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
              {t('common.affected')}:
            </span>
            <span className="text-sm">
              {incident.monitor_ids.length > 0
                ? incident.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')
                : isLoadingDetails
                  ? t('common.loading')
                  : hasDetailsError
                    ? t('status_page.failed_load_data')
                    : '-'}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:gap-2">
            <span className="text-slate-400 dark:text-slate-500 sm:w-20 text-xs sm:text-sm">
              {t('common.started')}:
            </span>
            <span className="text-sm">{formatDateTime(incident.started_at, timeZone, locale)}</span>
          </div>
          {incident.resolved_at && (
            <div className="flex flex-col sm:flex-row sm:gap-2">
              <span className="text-slate-400 dark:text-slate-500 sm:w-20 text-xs sm:text-sm">
                {t('common.resolved')}:
              </span>
              <span className="text-sm">
                {formatDateTime(incident.resolved_at, timeZone, locale)}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {incident.message && (
            <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">
                {t('status_page.initial_report')}
              </div>
              <Markdown text={incident.message} />
            </div>
          )}

          {incident.updates.map((u) => (
            <div key={u.id} className="border-l-2 border-slate-200 dark:border-slate-600 pl-4">
              <div className="flex items-center gap-3 mb-2">
                {u.status && <Badge variant="info">{incidentStatusLabel(u.status, t)}</Badge>}
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {formatDateTime(u.created_at, timeZone, locale)}
                </span>
              </div>
              <Markdown text={u.message} />
            </div>
          ))}

          {incident.updates.length === 0 && isLoadingDetails && (
            <div className="text-sm text-slate-500 dark:text-slate-400">{t('common.loading')}</div>
          )}

          {incident.updates.length === 0 && hasDetailsError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {t('status_page.failed_load_data')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPageSkeleton() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/95 backdrop-blur dark:border-slate-700/80 dark:bg-slate-800/95">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <div className="ui-skeleton h-6 w-28 rounded" />
          <div className="ui-skeleton h-8 w-20 rounded-full" />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-7 lg:px-8">
        <div className="ui-skeleton h-16 sm:h-24 rounded-2xl mb-6 sm:mb-8" />

        <section>
          <div className="h-6 w-24 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
          <div className="grid gap-2.5 sm:gap-3 md:grid-cols-2">
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
  const { locale, t } = useI18n();
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);
  const [selectedIncidentRequest, setSelectedIncidentRequest] = useState<{
    incident: IncidentCardData;
    resolvedOnly: boolean;
  } | null>(null);
  const [selectedDay, setSelectedDay] = useState<{ monitorId: number; dayStartAt: number } | null>(
    null,
  );

  const homepageQuery = useQuery({
    queryKey: ['homepage'],
    queryFn: fetchHomepage,
    staleTime: 30_000,
    refetchInterval: 30_000,
    // Keep a recent injected homepage bootstrap stable through the current monitor window.
    // Immediate mount refetch can temporarily downgrade recent artifact data to UNKNOWN
    // before the next scheduled check has refreshed monitor_state/snapshots.
    refetchOnMount: (query) => {
      const data = query.state.data as PublicHomepageResponse | undefined;
      if (!data || typeof data.generated_at !== 'number') {
        return true;
      }
      return Date.now() - data.generated_at * 1000 > 60_000;
    },
  });

  const derivedTitle = homepageQuery.data?.site_title || 'Uptimer';
  const derivedTimeZone = getBrowserTimeZone() || homepageQuery.data?.site_timezone || 'UTC';

  useApplyServerLocaleSetting(homepageQuery.data?.site_locale);

  useEffect(() => {
    document.title = derivedTitle;
  }, [derivedTitle]);

  const outagesQuery = useQuery({
    queryKey: ['public-monitor-outages', selectedDay?.monitorId, selectedDay?.dayStartAt],
    queryFn: () =>
      fetchPublicMonitorOutages(selectedDay?.monitorId as number, { range: '30d', limit: 200 }),
    enabled: selectedDay !== null,
  });

  const dayContextQuery = useQuery({
    queryKey: ['public-day-context', selectedDay?.monitorId, selectedDay?.dayStartAt],
    queryFn: () =>
      fetchPublicDayContext(selectedDay?.monitorId as number, selectedDay?.dayStartAt as number),
    enabled: selectedDay !== null,
  });

  const currentDayOutages = useMemo((): Outage[] => {
    if (!selectedDay) return [];
    const all = outagesQuery.data?.outages ?? [];
    const dayStart = selectedDay.dayStartAt;
    const dayEnd = dayStart + 86400;
    return all.filter((o) => o.started_at < dayEnd && (o.ended_at ?? dayEnd) > dayStart);
  }, [outagesQuery.data?.outages, selectedDay]);

  const incidentDetailQuery = useQuery({
    queryKey: [
      'public-incident-detail',
      selectedIncidentRequest?.incident.id,
      selectedIncidentRequest?.resolvedOnly,
    ],
    queryFn: () => {
      const resolvedOnly = selectedIncidentRequest?.resolvedOnly;
      return fetchPublicIncidentDetail(
        selectedIncidentRequest?.incident.id as number,
        resolvedOnly === undefined ? {} : { resolvedOnly },
      );
    },
    enabled: selectedIncidentRequest !== null,
  });

  const selectedIncident =
    incidentDetailQuery.data ??
    (selectedIncidentRequest
      ? {
          ...selectedIncidentRequest.incident,
          monitor_ids: [],
          updates: [],
        }
      : null);

  const resolvedIncidentPreview = homepageQuery.data?.resolved_incident_preview ?? null;
  const maintenanceHistoryPreview = homepageQuery.data?.maintenance_history_preview ?? null;

  const groupedMonitors = useMemo(() => {
    const groups = new Map<string, PublicHomepageResponse['monitors']>();
    for (const monitor of homepageQuery.data?.monitors ?? []) {
      const key = monitorGroupLabel(monitor.group_name, t('status_page.group_ungrouped'));
      const list = groups.get(key) ?? [];
      list.push(monitor);
      groups.set(key, list);
    }

    return [...groups.entries()].map(([name, monitors]) => ({ name, monitors }));
  }, [homepageQuery.data?.monitors, t]);
  const monitorNames = useMemo(
    () => new Map((homepageQuery.data?.monitors ?? []).map((m) => [m.id, m.name] as const)),
    [homepageQuery.data?.monitors],
  );

  if (homepageQuery.isLoading && !homepageQuery.data) {
    return <StatusPageSkeleton />;
  }

  if (!homepageQuery.data) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            {t('status_page.unable_to_load_status')}
          </h2>
          <p className="text-slate-500 dark:text-slate-400">{t('status_page.check_connection')}</p>
        </div>
      </div>
    );
  }

  const data = homepageQuery.data;
  const bannerConfig = getBannerConfig(data.banner.status, t);
  const activeIncidents = data.active_incidents;

  const siteTitle = derivedTitle;
  const timeZone = derivedTimeZone;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/95 backdrop-blur dark:border-slate-700/80 dark:bg-slate-800/95">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <Link to="/" className="flex flex-col justify-center min-w-0 min-h-9">
            <span className="text-xl sm:text-2xl font-bold leading-tight text-slate-900 dark:text-slate-100 truncate">
              {siteTitle}
            </span>
            {data.site_description ? (
              <span className="mt-0.5 text-sm leading-tight text-slate-500 dark:text-slate-400 truncate">
                {data.site_description}
              </span>
            ) : null}
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Status Banner */}
      <div>
        <div className="mx-auto max-w-5xl px-4 pt-7 pb-3 sm:px-6 sm:pt-12 sm:pb-5 lg:px-8 text-center">
          <div
            className={`inline-flex items-center justify-center w-9 h-9 sm:w-12 sm:h-12 rounded-full ${bannerConfig.iconBg} text-white text-lg sm:text-2xl mb-2 sm:mb-3`}
          >
            {bannerConfig.icon}
          </div>
          <h2 className="text-lg sm:text-2xl font-bold mb-1 text-slate-900 dark:text-slate-100">
            {bannerConfig.text}
          </h2>
          {data.banner.source === 'incident' && data.banner.incident && (
            <p className="text-slate-500 dark:text-slate-400 text-sm px-4">
              {t('status_page.incident_prefix', { value: data.banner.incident.title })}
            </p>
          )}
          {data.banner.source === 'maintenance' && data.banner.maintenance_window && (
            <p className="text-slate-500 dark:text-slate-400 text-sm px-4">
              {t('status_page.maintenance_prefix', { value: data.banner.maintenance_window.title })}
            </p>
          )}
          <p className="text-slate-400 dark:text-slate-500 text-xs mt-2">
            {t('common.last_updated', {
              value: formatDateTime(data.generated_at, timeZone, locale),
            })}
          </p>
        </div>
      </div>

      <main className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-7 lg:px-8">
        {/* Maintenance Windows */}
        {(data.maintenance_windows.active.length > 0 ||
          data.maintenance_windows.upcoming.length > 0) && (
          <section className="mb-6 sm:mb-8">
            <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2.5 sm:mb-3 flex items-center gap-2">
              <svg
                className="w-4 h-4 sm:w-5 sm:h-5 text-blue-500 dark:text-blue-400"
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              {t('status_page.scheduled_maintenance')}
            </h3>

            {data.maintenance_windows.active.length > 0 && (
              <div className="mb-4">
                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">
                  {t('common.active')}
                </div>
                <div className="space-y-3">
                  {data.maintenance_windows.active.map((w) => (
                    <Card
                      key={w.id}
                      className="p-4 sm:p-5 border-l-4 border-l-blue-500 dark:border-l-blue-400"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                          {w.title}
                        </h4>
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(w.starts_at, timeZone, locale)} –{' '}
                          {formatDateTime(w.ends_at, timeZone, locale)}
                        </span>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                        {t('common.affected')}:{' '}
                        {w.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
                      </div>
                      {w.message && <Markdown text={w.message} />}
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {data.maintenance_windows.upcoming.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2">
                  {t('common.upcoming')}
                </div>
                <div className="space-y-3">
                  {data.maintenance_windows.upcoming.map((w) => (
                    <Card
                      key={w.id}
                      className="p-4 sm:p-5 border-l-4 border-l-slate-300 dark:border-l-slate-600"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                          {w.title}
                        </h4>
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(w.starts_at, timeZone, locale)} –{' '}
                          {formatDateTime(w.ends_at, timeZone, locale)}
                        </span>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-300">
                        {t('common.affected')}:{' '}
                        {w.monitor_ids.map((id) => monitorNames.get(id) ?? `#${id}`).join(', ')}
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
          <section className="mb-6 sm:mb-8">
            <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2.5 sm:mb-3 flex items-center gap-2">
              <svg
                className="w-4 h-4 sm:w-5 sm:h-5 text-amber-500 dark:text-amber-400"
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
              {t('status_page.active_incidents')}
            </h3>
            <div className="space-y-3">
              {activeIncidents.map((it) => (
                <IncidentCard
                  key={it.id}
                  incident={it}
                  timeZone={timeZone}
                  onClick={() =>
                    setSelectedIncidentRequest({
                      incident: it,
                      resolvedOnly: false,
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* Monitors */}
        <section>
          <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2.5 sm:mb-3">
            {t('status_page.services')}
          </h3>
          <div className="space-y-5">
            {groupedMonitors.map((group) => (
              <div key={group.name}>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                    {group.name}
                  </h4>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {group.monitors.length}
                  </span>
                </div>
                <div className="grid gap-2.5 sm:gap-3 md:grid-cols-2">
                  {group.monitors.map((monitor) => (
                    <MonitorCard
                      key={monitor.id}
                      monitor={monitor}
                      ratingLevel={data.uptime_rating_level}
                      timeZone={timeZone}
                      onSelect={() => setSelectedMonitorId(monitor.id)}
                      onDayClick={(dayStartAt) =>
                        setSelectedDay({ monitorId: monitor.id, dayStartAt })
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {data.monitors.length === 0 && (
            <Card className="p-8 text-center">
              <p className="text-slate-500 dark:text-slate-400">{t('status_page.no_monitors')}</p>
            </Card>
          )}
        </section>

        <section className="mt-6 pt-5 sm:mt-8 sm:pt-6 border-t border-slate-100 dark:border-slate-800 space-y-6 sm:space-y-8">
          <div>
            <div className="flex items-center justify-between mb-2.5 sm:mb-3">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                {t('status_page.incident_history')}
              </h3>
              <Link
                to="/history/incidents"
                className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                {t('common.view_more')}
              </Link>
            </div>

            {resolvedIncidentPreview ? (
              <IncidentCard
                incident={resolvedIncidentPreview}
                timeZone={timeZone}
                onClick={() =>
                  setSelectedIncidentRequest({
                    incident: resolvedIncidentPreview,
                    resolvedOnly: true,
                  })
                }
              />
            ) : (
              <Card className="p-6 text-center">
                <p className="text-slate-500 dark:text-slate-400">
                  {t('status_page.no_past_incidents')}
                </p>
              </Card>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2.5 sm:mb-3">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100">
                {t('status_page.maintenance_history')}
              </h3>
              <Link
                to="/history/maintenance"
                className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                {t('common.view_more')}
              </Link>
            </div>

            {maintenanceHistoryPreview ? (
              <Card className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2">
                  <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                    {maintenanceHistoryPreview.title}
                  </h4>
                  <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatDateTime(maintenanceHistoryPreview.starts_at, timeZone, locale)} –{' '}
                    {formatDateTime(maintenanceHistoryPreview.ends_at, timeZone, locale)}
                  </span>
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                  {t('common.affected')}:{' '}
                  {maintenanceHistoryPreview.monitor_ids
                    .map((id) => monitorNames.get(id) ?? `#${id}`)
                    .join(', ')}
                </div>
                {maintenanceHistoryPreview.message && (
                  <Markdown text={maintenanceHistoryPreview.message} />
                )}
              </Card>
            ) : (
              <Card className="p-6 text-center">
                <p className="text-slate-500 dark:text-slate-400">
                  {t('status_page.no_past_maintenance')}
                </p>
              </Card>
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800">
        <div className="mx-auto max-w-5xl px-4 py-3 text-center text-sm text-slate-400 dark:text-slate-500 sm:px-6 sm:py-4 lg:px-8">
          {t('status_page.powered_by', { value: siteTitle })}
        </div>
      </footer>

      {/* Modals */}
      {selectedMonitorId !== null && (
        <MonitorDetail monitorId={selectedMonitorId} onClose={() => setSelectedMonitorId(null)} />
      )}

      {selectedIncident && (
        <IncidentDetail
          incident={selectedIncident}
          monitorNames={monitorNames}
          timeZone={timeZone}
          isLoadingDetails={incidentDetailQuery.isLoading}
          hasDetailsError={incidentDetailQuery.isError}
          onClose={() => setSelectedIncidentRequest(null)}
        />
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
          <div className="bg-slate-900/80 text-white text-sm px-3 py-2 rounded-lg">
            {t('status_page.loading_outages')}
          </div>
        </div>
      )}

      {selectedDay && outagesQuery.isError && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-red-600/90 text-white text-sm px-3 py-2 rounded-lg">
            {t('status_page.failed_load_outages')}
          </div>
        </div>
      )}

      {selectedDay && dayContextQuery.isLoading && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/80 text-white text-sm px-3 py-2 rounded-lg">
            {t('status_page.loading_context')}
          </div>
        </div>
      )}

      {selectedDay && dayContextQuery.isError && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-red-600/90 text-white text-sm px-3 py-2 rounded-lg">
            {t('status_page.failed_load_context')}
          </div>
        </div>
      )}
    </div>
  );
}
