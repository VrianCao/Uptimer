import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { UptimeDay, UptimeRatingLevel } from '../api/types';
import { formatDate } from '../utils/datetime';
import { getUptimeBgClasses, getUptimeTier } from '../utils/uptime';

type DowntimeInterval = { start: number; end: number };

interface UptimeBar30dProps {
  days: UptimeDay[];
  ratingLevel?: UptimeRatingLevel;
  maxBars?: number;
  timeZone: string;
  onDayClick?: (dayStartAt: number) => void;
  density?: 'default' | 'compact';
  fillMode?: 'pad' | 'stretch';
}

function formatDay(ts: number, timeZone: string): string {
  return formatDate(ts, timeZone);
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

function getUptimeColorClasses(uptimePct: number | null, level: UptimeRatingLevel): string {
  if (uptimePct === null) return 'bg-slate-300 dark:bg-slate-600';
  return getUptimeBgClasses(getUptimeTier(uptimePct, level));
}

function getUptimeGlow(uptimePct: number | null, level: UptimeRatingLevel): string {
  if (uptimePct === null) return '';

  // Keep glow coarse: good (>= green), warn (>= amber), bad (< amber).
  const goodThresholdByLevel: Record<UptimeRatingLevel, number> = {
    1: 98.0,
    2: 99.5,
    3: 99.95,
    4: 99.995,
    5: 99.999,
  };

  const warnThresholdByLevel: Record<UptimeRatingLevel, number> = {
    1: 95.0,
    2: 98.0,
    3: 99.0,
    4: 99.9,
    5: 99.95,
  };

  const good = goodThresholdByLevel[level] ?? goodThresholdByLevel[3];
  const warn = warnThresholdByLevel[level] ?? warnThresholdByLevel[3];

  if (uptimePct >= good) return 'shadow-emerald-500/50';
  if (uptimePct >= warn) return 'shadow-amber-500/50';
  return 'shadow-red-500/50';
}

function mergeIntervals(intervals: DowntimeInterval[]): DowntimeInterval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: DowntimeInterval[] = [];

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

interface TooltipState {
  day: UptimeDay;
  slotKey: string;
  position: { x: number; y: number };
}

function Tooltip({ day, position, ratingLevel, timeZone }: { day: UptimeDay; position: { x: number; y: number }; ratingLevel: UptimeRatingLevel; timeZone: string }) {
  return (
    <div
      className="fixed z-50 px-3 py-2 text-xs bg-slate-900 dark:bg-slate-700 text-white rounded-lg shadow-lg pointer-events-none animate-fade-in"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-8px)',
      }}
    >
      <div className="font-medium mb-1">{formatDay(day.day_start_at, timeZone)}</div>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${getUptimeColorClasses(day.uptime_pct, ratingLevel)}`} />
        <span>
          {day.uptime_pct === null ? 'No data' : `${day.uptime_pct.toFixed(3)}%`} uptime
        </span>
      </div>
      <div className="mt-1 text-slate-300">Downtime: {formatSec(day.downtime_sec)}</div>
      {day.unknown_sec > 0 && <div className="text-slate-300">Unknown: {formatSec(day.unknown_sec)}</div>}
      <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-slate-900 dark:bg-slate-700 rotate-45" />
    </div>
  );
}

export function UptimeBar30d({
  days,
  ratingLevel = 3,
  maxBars = 30,
  timeZone,
  onDayClick,
  density = 'default',
  fillMode = 'pad',
}: UptimeBar30dProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const compact = density === 'compact';

  const sourceDays = useMemo(() => {
    if (!Array.isArray(days)) return [];
    // Backend returns oldest -> newest; we want newest on the right.
    return days.slice(-maxBars);
  }, [days, maxBars]);

  const displayBars = useMemo(() => {
    if (sourceDays.length === 0) return [];

    if (fillMode === 'stretch' && sourceDays.length < maxBars) {
      return Array.from({ length: maxBars }, (_, slot) => {
        const mappedIndex = Math.min(
          sourceDays.length - 1,
          Math.floor((slot * sourceDays.length) / maxBars),
        );
        const day = sourceDays[mappedIndex];
        if (!day) return null;
        return { day, slotKey: `${day.day_start_at}-${slot}` };
      }).filter((entry): entry is { day: UptimeDay; slotKey: string } => entry !== null);
    }

    return sourceDays.map((day) => ({ day, slotKey: `${day.day_start_at}` }));
  }, [fillMode, maxBars, sourceDays]);

  // Ensure stable layout in default mode when fewer bars are available.
  const emptyCount = fillMode === 'stretch' ? 0 : Math.max(0, maxBars - displayBars.length);

  const handleMouseEnter = (d: UptimeDay, slotKey: string, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      day: d,
      slotKey,
      position: { x: rect.left + rect.width / 2, y: rect.top },
    });
  };

  return (
    <>
      <div
        data-bar-chart
        className={compact
          ? 'flex h-5 items-end gap-[2px] sm:h-6'
          : 'flex h-6 items-end gap-[2px] sm:h-8 sm:gap-[3px]'}
      >
        {emptyCount > 0 &&
          Array.from({ length: emptyCount }).map((_, idx) => (
            <div
              key={`empty-${idx}`}
              className={compact
                ? 'h-[100%] max-w-[6px] min-w-[3px] flex-1 rounded-sm bg-slate-200 dark:bg-slate-700'
                : 'h-[100%] max-w-[6px] min-w-[3px] flex-1 rounded-sm bg-slate-200 dark:bg-slate-700 sm:max-w-[8px] sm:min-w-[4px]'}
            />
          ))}

        {displayBars.map(({ day: d, slotKey }) => {
          const pct = d.uptime_pct;

          return (
            <button
              key={slotKey}
              type="button"
              aria-label={`Uptime ${formatDay(d.day_start_at, timeZone)}`}
              className={`${compact
                ? 'max-w-[6px] min-w-[3px] flex-1'
                : 'max-w-[6px] min-w-[3px] flex-1 sm:max-w-[8px] sm:min-w-[4px]'} rounded-sm transition-all duration-150
                ${getUptimeColorClasses(pct, ratingLevel)}
                ${compact ? 'hover:scale-y-105' : 'hover:scale-y-110'} hover:shadow-md ${tooltip?.slotKey === slotKey ? getUptimeGlow(pct, ratingLevel) : ''}`}
              style={{ height: '100%' }}
              onMouseEnter={(e) => handleMouseEnter(d, slotKey, e)}
              onMouseLeave={() => setTooltip(null)}
              onClick={(e) => {
                e.stopPropagation();
                onDayClick?.(d.day_start_at);
              }}
            />
          );
        })}
      </div>

      {tooltip && createPortal(
        <Tooltip
          day={tooltip.day}
          position={tooltip.position}
          ratingLevel={ratingLevel}
          timeZone={timeZone}
        />,
        document.body,
      )}
    </>
  );
}

export function computeDayDowntimeIntervals(
  dayStartAt: number,
  outages: Array<{ started_at: number; ended_at: number | null }>,
  nowSec: number = Math.floor(Date.now() / 1000),
): DowntimeInterval[] {
  const dayEndAt = dayStartAt + 86400;
  const capEndAt = dayStartAt <= nowSec && nowSec < dayEndAt ? nowSec : dayEndAt;

  const intervals: DowntimeInterval[] = [];
  for (const o of outages) {
    const s = Math.max(o.started_at, dayStartAt);
    const e = Math.min(o.ended_at ?? capEndAt, capEndAt);
    if (e > s) intervals.push({ start: s, end: e });
  }

  return mergeIntervals(intervals);
}

export function computeIntervalTotalSeconds(intervals: DowntimeInterval[]): number {
  return intervals.reduce((acc, it) => acc + Math.max(0, it.end - it.start), 0);
}
