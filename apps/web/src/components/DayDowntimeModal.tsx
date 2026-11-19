import { Dialog } from './Dialog';
import { useMemo } from 'react';

import type { Incident, MaintenanceWindow, Outage } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { Button } from './ui';
import { formatDate, formatTime } from '../utils/datetime';
import { computeDayDowntimeIntervals, computeIntervalTotalSeconds } from './UptimeBar30d';

function formatDay(ts: number, timeZone?: string, locale?: string): string {
  return formatDate(ts, timeZone, locale);
}

function formatClock(ts: number, timeZone?: string, locale?: string): string {
  return timeZone
    ? formatTime(ts, { timeZone, hour12: false, ...(locale ? { locale } : {}) })
    : formatTime(ts, { hour12: false, ...(locale ? { locale } : {}) });
}

function formatSec(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

type DayInterval = { start: number; end: number };

type ContextInterval = {
  start: number;
  end: number;
  kind: 'maintenance' | 'incident';
  label: string;
};

type ContextGroup = {
  start: number;
  end: number;
  kind: 'maintenance' | 'incident';
  label: string;
  downtime: DayInterval[];
};

function mergeIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: DayInterval[] = [];

  for (const it of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: it.start, end: it.end });
      continue;
    }

    if (it.start <= prev.end) {
      prev.end = Math.max(prev.end, it.end);
      continue;
    }

    merged.push({ start: it.start, end: it.end });
  }

  return merged;
}

function clipInterval(interval: DayInterval, range: DayInterval): DayInterval | null {
  const start = Math.max(interval.start, range.start);
  const end = Math.min(interval.end, range.end);
  return end > start ? { start, end } : null;
}

function groupDowntimeByContext(
  downtime: DayInterval[],
  contexts: ContextInterval[],
): { groups: ContextGroup[]; outside: DayInterval[] } {
  if (downtime.length === 0) return { groups: [], outside: [] };

  const mergedDowntime = mergeIntervals(downtime);

  const mergedContexts: Array<ContextInterval & DayInterval> = contexts
    .map((c) => ({ ...c, start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const groups: ContextGroup[] = [];
  for (const ctx of mergedContexts) {
    const overlappedDowntime = mergedDowntime
      .map((d) => clipInterval(d, ctx))
      .filter((x): x is DayInterval => x !== null);
    if (overlappedDowntime.length === 0) continue;
    groups.push({
      start: ctx.start,
      end: ctx.end,
      kind: ctx.kind,
      label: ctx.label,
      downtime: overlappedDowntime,
    });
  }

  const outside: DayInterval[] = [];
  for (const d of mergedDowntime) {
    let cursor = d.start;
    for (const ctx of mergedContexts) {
      if (ctx.end <= cursor) continue;
      if (ctx.start >= d.end) break;

      if (ctx.start > cursor) {
        outside.push({ start: cursor, end: Math.min(ctx.start, d.end) });
      }

      cursor = Math.max(cursor, ctx.end);
      if (cursor >= d.end) break;
    }

    if (cursor < d.end) {
      outside.push({ start: cursor, end: d.end });
    }
  }

  return { groups, outside };
}

function buildContextIntervals(
  dayStartAt: number,
  nowSec: number,
  maintenanceWindows: MaintenanceWindow[],
  incidents: Incident[],
): ContextInterval[] {
  const dayEndAt = dayStartAt + 86400;
  const capEndAt = dayStartAt <= nowSec && nowSec < dayEndAt ? nowSec : dayEndAt;

  const out: ContextInterval[] = [];

  for (const mw of maintenanceWindows) {
    const clipped = clipInterval(
      { start: mw.starts_at, end: mw.ends_at },
      { start: dayStartAt, end: capEndAt },
    );
    if (!clipped) continue;
    out.push({ start: clipped.start, end: clipped.end, kind: 'maintenance', label: mw.title });
  }

  for (const it of incidents) {
    const clipped = clipInterval(
      { start: it.started_at, end: it.resolved_at ?? capEndAt },
      { start: dayStartAt, end: capEndAt },
    );
    if (!clipped) continue;
    out.push({ start: clipped.start, end: clipped.end, kind: 'incident', label: it.title });
  }

  return out.sort(
    (a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === 'maintenance' ? -1 : 1),
  );
}

// NOTE: Downtime is grouped separately for maintenance and incidents.

function contextTagClasses(kind: ContextInterval['kind']): string {
  return kind === 'maintenance'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200';
}

export function DayDowntimeModal({
  dayStartAt,
  outages,
  maintenanceWindows,
  incidents,
  onClose,
  timeZone,
  availableDays,
  onDayChange,
  isLoading,
  hasError,
  onRetry,
}: {
  dayStartAt: number;
  outages: Outage[];
  maintenanceWindows: MaintenanceWindow[];
  incidents: Incident[];
  onClose: () => void;
  timeZone?: string;
  availableDays: number[];
  onDayChange: (dayStartAt: number) => void;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
}) {
  const { locale, t } = useI18n();
  const nowSec = Math.floor(Date.now() / 1000);

  const intervals = useMemo(
    () => computeDayDowntimeIntervals(dayStartAt, outages, nowSec),
    [dayStartAt, nowSec, outages],
  );

  const totalDowntimeSec = useMemo(() => computeIntervalTotalSeconds(intervals), [intervals]);

  const contextIntervals = useMemo(
    () => buildContextIntervals(dayStartAt, nowSec, maintenanceWindows, incidents),
    [dayStartAt, nowSec, maintenanceWindows, incidents],
  );

  const allGrouped = useMemo(
    () => groupDowntimeByContext(intervals, contextIntervals),
    [intervals, contextIntervals],
  );

  // Build a unified time-sorted list: context groups + outside intervals.
  const sortedEntries = useMemo(() => {
    const entries: Array<
      { kind: 'group'; group: ContextGroup } | { kind: 'outside'; interval: DayInterval }
    > = [];
    for (const g of allGrouped.groups) entries.push({ kind: 'group', group: g });
    for (const it of allGrouped.outside) entries.push({ kind: 'outside', interval: it });
    return entries.sort((a, b) => {
      const aStart = a.kind === 'group' ? a.group.start : a.interval.start;
      const bStart = b.kind === 'group' ? b.group.start : b.interval.start;
      return aStart - bStart;
    });
  }, [allGrouped]);

  return (
    <Dialog label={t('day_downtime.title')} onClose={onClose} className="sm:max-w-xl p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
            {t('day_downtime.title')}
          </div>
          <h2 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-slate-100">
            {formatDay(dayStartAt, timeZone, locale)}
          </h2>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {!isLoading && !hasError && (
              <>
                {t('common.total')}: {formatSec(totalDowntimeSec)}
              </>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      <label className="mb-4 block text-sm text-slate-700 dark:text-slate-300">
        {t('uptime.select_day')}
        <select
          className="ui-select mt-1 w-full"
          value={dayStartAt}
          onChange={(event) => onDayChange(Number(event.target.value))}
        >
          {[...new Set([dayStartAt, ...availableDays])]
            .sort((a, b) => b - a)
            .map((day) => (
              <option key={day} value={day}>
                {formatDay(day, timeZone, locale)}
              </option>
            ))}
        </select>
      </label>

      {isLoading ? (
        <p role="status" className="text-slate-500 dark:text-slate-400">
          {t('status_page.loading_outages')}
        </p>
      ) : hasError ? (
        <div className="space-y-3">
          <p role="alert" className="ui-error">
            {t('status_page.failed_load_data')}
          </p>
          <Button onClick={onRetry}>{t('common.retry')}</Button>
        </div>
      ) : intervals.length === 0 ? (
        <div className="text-slate-500 dark:text-slate-400">{t('day_downtime.no_downtime')}</div>
      ) : (
        <div className="space-y-3">
          {sortedEntries.map((entry, idx) => {
            if (entry.kind === 'outside') {
              const it = entry.interval;
              return (
                <div
                  key={`outside-${idx}`}
                  className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/50"
                >
                  <div className="text-sm text-slate-700 dark:text-slate-200">
                    {formatClock(it.start, timeZone, locale)} –{' '}
                    {formatClock(it.end, timeZone, locale)}
                  </div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    {formatSec(it.end - it.start)}
                  </div>
                </div>
              );
            }

            const g = entry.group;
            const isMaintenance = g.kind === 'maintenance';
            return (
              <div
                key={`group-${idx}`}
                className={
                  isMaintenance
                    ? 'p-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/10'
                    : 'p-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/10'
                }
              >
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div
                    className={`text-sm font-medium ${isMaintenance ? 'text-blue-700 dark:text-blue-300' : 'text-amber-800 dark:text-amber-200'}`}
                  >
                    {isMaintenance
                      ? t('day_downtime.kind_maintenance')
                      : t('day_downtime.kind_incident')}
                  </div>
                  <div
                    className={`text-xs tabular-nums ${isMaintenance ? 'text-blue-700/80 dark:text-blue-300/80' : 'text-amber-800/80 dark:text-amber-200/80'}`}
                  >
                    {formatClock(g.start, timeZone, locale)} –{' '}
                    {formatClock(g.end, timeZone, locale)}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mb-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${contextTagClasses(g.kind)}`}
                  >
                    {g.label}
                  </span>
                </div>

                <div className="space-y-2">
                  {g.downtime.map((it, didx) => (
                    <div
                      key={`d-${didx}`}
                      className="flex items-center justify-between gap-4 p-3 rounded-lg bg-white/70 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700"
                    >
                      <div className="text-sm text-slate-700 dark:text-slate-200">
                        {formatClock(it.start, timeZone, locale)} –{' '}
                        {formatClock(it.end, timeZone, locale)}
                      </div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                        {formatSec(it.end - it.start)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
