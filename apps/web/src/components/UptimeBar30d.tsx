import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { HomepageUptimeDayStrip, UptimeDayPreview, UptimeRatingLevel } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { formatDate } from '../utils/datetime';
import { getUptimeBgClasses, getUptimeTier } from '../utils/uptime';

type DowntimeInterval = { start: number; end: number };

interface UptimeBar30dProps {
  days?: UptimeDayPreview[] | undefined;
  strip?: HomepageUptimeDayStrip | undefined;
  ratingLevel?: UptimeRatingLevel;
  maxBars?: number;
  timeZone: string;
  onDayClick?: (dayStartAt: number) => void;
  density?: 'default' | 'compact';
  fillMode?: 'pad' | 'stretch';
}

type DisplaySlot = {
  day: UptimeDayPreview | null;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function decodeUptimeDayStrip(strip: HomepageUptimeDayStrip | undefined): UptimeDayPreview[] {
  if (!strip) return [];

  const count = Math.min(
    strip.day_start_at.length,
    strip.downtime_sec.length,
    strip.unknown_sec.length,
    strip.uptime_pct_milli.length,
  );
  const out: UptimeDayPreview[] = [];
  for (let index = 0; index < count; index += 1) {
    const milli = strip.uptime_pct_milli[index];
    out.push({
      day_start_at: strip.day_start_at[index] ?? 0,
      downtime_sec: strip.downtime_sec[index] ?? 0,
      unknown_sec: strip.unknown_sec[index] ?? 0,
      uptime_pct: milli === null || milli === undefined ? null : milli / 1000,
    });
  }
  return out;
}

function formatDay(ts: number, timeZone: string, locale: string): string {
  return formatDate(ts, timeZone, locale);
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

function tooltipDotClass(uptimePct: number | null, level: UptimeRatingLevel): string {
  if (uptimePct === null) return 'bg-slate-300 dark:bg-slate-600';
  return getUptimeBgClasses(getUptimeTier(uptimePct, level));
}

function uptimeFill(uptimePct: number | null, level: UptimeRatingLevel): string {
  if (uptimePct === null) return '#cbd5e1';

  const tier = getUptimeTier(uptimePct, level);
  switch (tier) {
    case 'emerald':
    case 'green':
      return '#10b981';
    case 'lime':
      return '#84cc16';
    case 'yellow':
    case 'amber':
    case 'orange':
      return '#f59e0b';
    case 'red':
    case 'rose':
      return '#ef4444';
    case 'slate':
    default:
      return '#cbd5e1';
  }
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

function buildSvgDataUri(
  slots: DisplaySlot[],
  ratingLevel: UptimeRatingLevel,
  compact: boolean,
): string {
  const height = compact ? 20 : 24;
  const barWidth = compact ? 4 : 6;
  const gap = compact ? 2 : 3;
  const width = slots.length === 0 ? barWidth : slots.length * barWidth + (slots.length - 1) * gap;

  const rects = slots
    .map((slot, index) => {
      const x = index * (barWidth + gap);
      const fill = slot.day ? uptimeFill(slot.day.uptime_pct, ratingLevel) : 'transparent';
      return `<rect x="${x}" y="0" width="${barWidth}" height="${height}" rx="1" fill="${fill}"/>`;
    })
    .join('');

  const svg = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function Tooltip({
  day,
  position,
  ratingLevel,
  timeZone,
}: {
  day: UptimeDayPreview;
  position: { x: number; y: number };
  ratingLevel: UptimeRatingLevel;
  timeZone: string;
}) {
  const { locale, t } = useI18n();

  return (
    <div
      className="fixed z-50 px-3 py-2 text-xs bg-slate-900 dark:bg-slate-700 text-white rounded-lg shadow-lg pointer-events-none animate-fade-in"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-8px)',
      }}
    >
      <div className="font-medium mb-1">{formatDay(day.day_start_at, timeZone, locale)}</div>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${tooltipDotClass(day.uptime_pct, ratingLevel)}`} />
        <span>
          {day.uptime_pct === null ? t('uptime.no_data') : `${day.uptime_pct.toFixed(3)}%`}{' '}
          {t('uptime.uptime')}
        </span>
      </div>
      <div className="mt-1 text-slate-300">
        {t('uptime.downtime')}: {formatSec(day.downtime_sec)}
      </div>
      {day.unknown_sec > 0 && (
        <div className="text-slate-300">
          {t('uptime.unknown')}: {formatSec(day.unknown_sec)}
        </div>
      )}
      <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-slate-900 dark:bg-slate-700 rotate-45" />
    </div>
  );
}

export function UptimeBar30d({
  days,
  strip,
  ratingLevel = 3,
  maxBars = 30,
  timeZone,
  onDayClick,
  density = 'default',
  fillMode = 'pad',
}: UptimeBar30dProps) {
  const { locale, t } = useI18n();
  const [tooltip, setTooltip] = useState<{
    day: UptimeDayPreview;
    index: number;
    position: { x: number; y: number };
  } | null>(null);
  const compact = density === 'compact';

  const sourceDays = useMemo(() => {
    const decoded = days ?? decodeUptimeDayStrip(strip);
    return decoded.slice(-maxBars);
  }, [days, maxBars, strip]);

  const displayBars = useMemo(() => {
    if (sourceDays.length === 0) return [];

    if (fillMode === 'stretch' && sourceDays.length < maxBars) {
      return Array.from({ length: maxBars }, (_, slot) => {
        const mappedIndex = Math.min(
          sourceDays.length - 1,
          Math.floor((slot * sourceDays.length) / maxBars),
        );
        const day = sourceDays[mappedIndex];
        return day ?? null;
      });
    }

    return sourceDays;
  }, [fillMode, maxBars, sourceDays]);

  const slots = useMemo<DisplaySlot[]>(() => {
    if (fillMode === 'stretch') {
      return displayBars.map((day) => ({ day }));
    }

    const emptyCount = Math.max(0, maxBars - displayBars.length);
    return [
      ...Array.from({ length: emptyCount }, () => ({ day: null })),
      ...displayBars.map((day) => ({ day })),
    ];
  }, [displayBars, fillMode, maxBars]);
  const slotCount = slots.length;
  const backgroundImage = useMemo(
    () => buildSvgDataUri(slots, ratingLevel, compact),
    [compact, ratingLevel, slots],
  );
  const showTooltip = (day: UptimeDayPreview, index: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setTooltip({
      day,
      index,
      position: {
        x: rect.left + rect.width / 2,
        y: rect.top,
      },
    });
  };

  return (
    <>
      <div
        className={
          compact ? 'relative h-5 overflow-hidden sm:h-6' : 'relative h-6 overflow-hidden sm:h-8'
        }
      >
        <div
          data-bar-chart
          className="relative h-full w-full rounded-md bg-slate-200 dark:bg-slate-700"
          style={{
            backgroundImage,
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: '100% 100%',
          }}
        />
        {slotCount > 0 && (
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))` }}
          >
            {slots.map((slot, index) => {
              const day = slot.day;
              return day ? (
                <button
                  key={`day-${day.day_start_at}-${index}`}
                  type="button"
                  aria-label={`${t('uptime.aria_prefix')}: ${formatDay(day.day_start_at, timeZone, locale)}`}
                  className="h-full w-full bg-transparent focus:outline-none"
                  onMouseEnter={(event) => showTooltip(day, index, event.currentTarget)}
                  onFocus={(event) => showTooltip(day, index, event.currentTarget)}
                  onBlur={() =>
                    setTooltip((current) => (current?.index === index ? null : current))
                  }
                  onMouseLeave={() =>
                    setTooltip((current) => (current?.index === index ? null : current))
                  }
                  onClick={(event) => {
                    if (!onDayClick) return;
                    event.stopPropagation();
                    onDayClick(day.day_start_at);
                  }}
                />
              ) : (
                <span key={`empty-${index}`} aria-hidden="true" />
              );
            })}
          </div>
        )}
        {tooltip && (
          <div
            className="pointer-events-none absolute inset-y-0 rounded-sm ring-1 ring-white/70 shadow-[0_0_0_1px_rgba(15,23,42,0.08)]"
            style={{
              left: `${(tooltip.index / slotCount) * 100}%`,
              width: `${100 / slotCount}%`,
            }}
          />
        )}
      </div>

      {tooltip &&
        createPortal(
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
