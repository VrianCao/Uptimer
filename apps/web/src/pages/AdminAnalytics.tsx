import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { useAuth } from '../app/AuthContext';
import { useI18n } from '../app/I18nContext';
import { useApplyServerLocaleSetting } from '../app/useApplyServerLocaleSetting';
import { ADMIN_PATH } from '../app/adminPaths';
import {
  fetchAdminAnalyticsOverview,
  fetchAdminMonitorAnalytics,
  fetchAdminMonitorOutages,
  fetchAdminMonitors,
  fetchAdminSettings,
} from '../api/client';
import type { AnalyticsOverviewRange, AnalyticsRange } from '../api/types';
import { DailyLatencyChart } from '../components/DailyLatencyChart';
import { DailyUptimeChart } from '../components/DailyUptimeChart';
import { LatencyChart } from '../components/LatencyChart';
import { Button, Card, ThemeToggle, cn } from '../components/ui';
import { formatDateTime } from '../utils/datetime';
import { formatPct } from '../utils/uptime';

const overviewRanges: AnalyticsOverviewRange[] = ['24h', '7d'];
const monitorRanges: AnalyticsRange[] = ['24h', '7d', '30d', '90d'];

function formatSec(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v < 60) return `${v}s`;

  const m = Math.floor(v / 60);
  const s = v % 60;
  if (m < 60) return `${m}m ${s}s`;

  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function RangeTabs<T extends string>({
  values,
  current,
  onChange,
}: {
  values: readonly T[];
  current: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800/70">
      {values.map((value) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3',
            current === value
              ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
              : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700/80 dark:bg-slate-800/50">
      <div className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'danger'
            ? 'text-red-600 dark:text-red-400'
            : 'text-slate-900 dark:text-slate-100',
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function AdminAnalytics() {
  const { logout } = useAuth();
  const { locale, t } = useI18n();

  const [overviewRange, setOverviewRange] = useState<AnalyticsOverviewRange>('24h');
  const [monitorRange, setMonitorRange] = useState<AnalyticsRange>('24h');
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    queryFn: fetchAdminSettings,
  });

  const overviewQuery = useQuery({
    queryKey: ['admin-analytics-overview', overviewRange],
    queryFn: () => fetchAdminAnalyticsOverview(overviewRange),
  });

  const monitorsQuery = useQuery({
    queryKey: ['admin-monitors', 'for-analytics'],
    queryFn: () => fetchAdminMonitors(200),
  });

  const monitors = useMemo(
    () => monitorsQuery.data?.monitors ?? [],
    [monitorsQuery.data?.monitors],
  );

  const settings = settingsQuery.data?.settings;
  useApplyServerLocaleSetting(settings?.site_locale);
  const timeZone = settings?.site_timezone || 'UTC';

  useEffect(() => {
    document.title = `Uptimer · ${t('admin_analytics.analytics_title')}`;
  }, [t]);

  useEffect(() => {
    if (!settings) return;
    setOverviewRange(settings.admin_default_overview_range);
    setMonitorRange(settings.admin_default_monitor_range);
  }, [settings]);

  useEffect(() => {
    if (monitors.length === 0) {
      setSelectedMonitorId(null);
      return;
    }

    const exists =
      selectedMonitorId !== null && monitors.some((monitor) => monitor.id === selectedMonitorId);

    if (!exists) {
      setSelectedMonitorId(monitors[0]?.id ?? null);
    }
  }, [monitors, selectedMonitorId]);

  const selectedMonitor = useMemo(
    () => monitors.find((monitor) => monitor.id === selectedMonitorId) ?? null,
    [monitors, selectedMonitorId],
  );

  const monitorAnalyticsQuery = useQuery({
    queryKey: ['admin-monitor-analytics', selectedMonitorId, monitorRange],
    queryFn: () => fetchAdminMonitorAnalytics(selectedMonitorId as number, monitorRange),
    enabled: selectedMonitorId !== null,
  });

  const outagesQuery = useInfiniteQuery({
    queryKey: ['admin-monitor-outages', selectedMonitorId, monitorRange],
    queryFn: ({ pageParam }) => {
      const opts: { range: AnalyticsRange; limit: number; cursor?: number } = {
        range: monitorRange,
        limit: 50,
      };
      if (typeof pageParam === 'number') opts.cursor = pageParam;
      return fetchAdminMonitorOutages(selectedMonitorId as number, opts);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: selectedMonitorId !== null,
  });

  const outages = outagesQuery.data?.pages.flatMap((page) => page.outages) ?? [];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700">
        <div className="mx-auto max-w-[92rem] px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
            {t('admin_analytics.analytics_title')}
          </h1>

          <div className="flex items-center gap-1">
            <Link
              to={ADMIN_PATH}
              aria-label={t('common.dashboard')}
              title={t('common.dashboard')}
              className="flex items-center justify-center h-10 text-base text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors px-3 rounded-lg"
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                />
              </svg>
              <span className="hidden sm:inline">{t('common.dashboard')}</span>
            </Link>
            <Link
              to="/"
              aria-label={t('common.status')}
              title={t('common.status')}
              className="flex items-center justify-center h-10 text-base text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors px-3 rounded-lg"
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="hidden sm:inline">{t('common.status')}</span>
            </Link>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
            <ThemeToggle />
            <button
              type="button"
              onClick={logout}
              aria-label={t('common.logout')}
              title={t('common.logout')}
              className="flex items-center justify-center h-10 text-base text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors px-3 rounded-lg"
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
              <span className="hidden sm:inline">{t('common.logout')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[92rem] space-y-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 sm:text-xl">
                {t('admin_analytics.overview_title')}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t('admin_analytics.overview_desc')}
              </p>
            </div>
            <RangeTabs
              values={overviewRanges}
              current={overviewRange}
              onChange={setOverviewRange}
            />
          </div>

          {overviewQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, idx) => (
                <div
                  key={idx}
                  className="ui-skeleton h-24 rounded-xl border border-slate-200/70 dark:border-slate-700/70"
                />
              ))}
            </div>
          ) : overviewQuery.isError || !overviewQuery.data ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300">
              {t('admin_analytics.failed_overview')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label={t('admin_analytics.uptime')}
                value={formatPct(overviewQuery.data.totals.uptime_pct)}
              />
              <StatTile
                label={t('admin_analytics.alerts')}
                value={String(overviewQuery.data.alerts.count)}
              />
              <StatTile
                label={t('admin_analytics.longest_outage')}
                value={
                  overviewQuery.data.outages.longest_sec === null
                    ? '-'
                    : formatSec(overviewQuery.data.outages.longest_sec)
                }
                tone="danger"
              />
              <StatTile
                label={t('admin_analytics.mttr')}
                value={
                  overviewQuery.data.outages.mttr_sec === null
                    ? '-'
                    : formatSec(overviewQuery.data.outages.mttr_sec)
                }
              />
            </div>
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 sm:text-xl">
                  {t('admin_analytics.monitor_title')}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {t('admin_analytics.monitor_desc')}
                </p>
              </div>
              <RangeTabs values={monitorRanges} current={monitorRange} onChange={setMonitorRange} />
            </div>

            <label className="ui-label mb-0 text-sm font-medium text-slate-700 dark:text-slate-300">
              {t('admin_analytics.monitor_label')}
              <select
                value={selectedMonitorId ?? ''}
                onChange={(e) => setSelectedMonitorId(Number(e.target.value))}
                className="ui-select mt-2 max-w-sm"
                disabled={monitorsQuery.isLoading || monitors.length === 0}
              >
                {monitors.length === 0 ? (
                  <option value="">{t('admin_analytics.no_monitors_available')}</option>
                ) : (
                  monitors.map((monitor) => (
                    <option key={monitor.id} value={monitor.id}>
                      {monitor.name} (#{monitor.id})
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>

          {!selectedMonitor ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              {t('admin_analytics.create_monitor_first')}
            </div>
          ) : monitorAnalyticsQuery.isLoading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="ui-skeleton h-24 rounded-xl border border-slate-200/70 dark:border-slate-700/70"
                  />
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="ui-skeleton h-64 rounded-xl border border-slate-200/70 dark:border-slate-700/70" />
                <div className="ui-skeleton h-64 rounded-xl border border-slate-200/70 dark:border-slate-700/70" />
              </div>
            </div>
          ) : monitorAnalyticsQuery.isError || !monitorAnalyticsQuery.data ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300">
              {t('admin_analytics.failed_monitor')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <StatTile
                  label={t('admin_analytics.uptime')}
                  value={formatPct(monitorAnalyticsQuery.data.uptime_pct)}
                />
                <StatTile
                  label={t('admin_analytics.unknown')}
                  value={formatPct(monitorAnalyticsQuery.data.unknown_pct)}
                />
                <StatTile
                  label={t('admin_analytics.downtime')}
                  value={formatSec(monitorAnalyticsQuery.data.downtime_sec)}
                  tone="danger"
                />
                <StatTile
                  label={t('admin_analytics.p95')}
                  value={
                    monitorAnalyticsQuery.data.p95_latency_ms === null
                      ? '-'
                      : `${monitorAnalyticsQuery.data.p95_latency_ms}ms`
                  }
                />
                <StatTile
                  label={t('admin_analytics.p50')}
                  value={
                    monitorAnalyticsQuery.data.p50_latency_ms === null
                      ? '-'
                      : `${monitorAnalyticsQuery.data.p50_latency_ms}ms`
                  }
                />
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700/80 dark:bg-slate-800/60">
                  <div className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_analytics.daily_uptime')}
                  </div>
                  {monitorRange === '24h' ? (
                    <div className="flex h-[220px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
                      {t('admin_analytics.daily_rollup_hint')}
                    </div>
                  ) : (
                    <DailyUptimeChart points={monitorAnalyticsQuery.data.daily} />
                  )}
                </div>

                <div className="rounded-xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700/80 dark:bg-slate-800/60">
                  <div className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_analytics.latency')}
                  </div>
                  {monitorRange === '24h' ? (
                    <LatencyChart points={monitorAnalyticsQuery.data.points} />
                  ) : (
                    <DailyLatencyChart points={monitorAnalyticsQuery.data.daily} />
                  )}
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700/80 dark:bg-slate-800/60">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_analytics.outages')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {selectedMonitor.name} (#{selectedMonitor.id})
                  </div>
                </div>

                {outagesQuery.isLoading ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    {t('admin_analytics.loading_outages')}
                  </div>
                ) : outages.length === 0 ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    {t('admin_analytics.no_outages')}
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[540px] text-sm">
                        <thead className="text-xs text-slate-500 dark:text-slate-400">
                          <tr>
                            <th className="py-2 pr-4 text-left">
                              {t('admin_analytics.outage_start')}
                            </th>
                            <th className="py-2 pr-4 text-left">
                              {t('admin_analytics.outage_end')}
                            </th>
                            <th className="py-2 pr-4 text-left">
                              {t('admin_analytics.initial_error')}
                            </th>
                            <th className="py-2 pr-4 text-left">
                              {t('admin_analytics.last_error')}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                          {outages.map((outage) => (
                            <tr key={outage.id}>
                              <td className="py-2 pr-4 whitespace-nowrap text-slate-900 dark:text-slate-100">
                                {formatDateTime(outage.started_at, timeZone, locale)}
                              </td>
                              <td className="py-2 pr-4 whitespace-nowrap text-slate-900 dark:text-slate-100">
                                {outage.ended_at
                                  ? formatDateTime(outage.ended_at, timeZone, locale)
                                  : t('admin_analytics.ongoing')}
                              </td>
                              <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">
                                {outage.initial_error ?? '-'}
                              </td>
                              <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">
                                {outage.last_error ?? '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {outagesQuery.hasNextPage && (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          onClick={() => outagesQuery.fetchNextPage()}
                          disabled={outagesQuery.isFetchingNextPage}
                        >
                          {outagesQuery.isFetchingNextPage
                            ? t('common.loading_ellipsis')
                            : t('common.load_more')}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
