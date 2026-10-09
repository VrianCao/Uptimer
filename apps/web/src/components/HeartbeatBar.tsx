import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CheckStatus, Heartbeat, HomepageHeartbeatStrip } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { statusLabel } from '../i18n/labels';
import { clampLatencyToCeiling, suggestLatencyAxisCeiling } from '../utils/latencyScale';

interface HeartbeatBarProps {
  heartbeats?: Heartbeat[] | undefined;
  strip?: HomepageHeartbeatStrip | undefined;
  maxBars?: number;
  visualBars?: number;
  density?: 'default' | 'compact';
}

interface LatencyScale {
  min: number;
  span: number;
  ceiling: number | null;
}

interface DisplayHeartbeat extends Heartbeat {
  from_checked_at: number;
  to_checked_at: number;
  sample_count: number;
}

type DisplaySlot = {
  heartbeat: DisplayHeartbeat | null;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function decodeStatusCode(code: string | undefined): CheckStatus {
  switch (code) {
    case 'u':
      return 'up';
    case 'd':
      return 'down';
    case 'm':
      return 'maintenance';
    case 'x':
    default:
      return 'unknown';
  }
}

function decodeHeartbeatStrip(strip: HomepageHeartbeatStrip | undefined): Heartbeat[] {
  if (!strip) return [];

  const out: Heartbeat[] = [];
  const count = Math.min(
    strip.checked_at.length,
    strip.latency_ms.length,
    strip.status_codes.length,
  );

  for (let index = 0; index < count; index += 1) {
    out.push({
      checked_at: strip.checked_at[index] ?? 0,
      status: decodeStatusCode(strip.status_codes[index]),
      latency_ms: strip.latency_ms[index] ?? null,
    });
  }

  return out;
}

function statusPriority(status: CheckStatus): number {
  switch (status) {
    case 'down':
      return 4;
    case 'unknown':
      return 3;
    case 'maintenance':
      return 2;
    case 'up':
    default:
      return 1;
  }
}

function buildLatencyScale(heartbeats: DisplayHeartbeat[]): LatencyScale | null {
  const latencies: number[] = [];
  for (const hb of heartbeats) {
    if (hb.status !== 'up') continue;
    if (typeof hb.latency_ms !== 'number' || !Number.isFinite(hb.latency_ms)) continue;
    latencies.push(hb.latency_ms);
  }

  if (latencies.length === 0) return null;

  const ceiling = suggestLatencyAxisCeiling(latencies);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const latency of latencies) {
    const display = clampLatencyToCeiling(latency, ceiling);
    if (display < min) min = display;
    if (display > max) max = display;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, span: Math.max(1, max - min), ceiling };
}

function getBarHeightPct(
  heartbeat: DisplayHeartbeat,
  scale: LatencyScale | null,
  compact: boolean,
): number {
  if (heartbeat.status === 'down') return 100;
  if (heartbeat.status === 'maintenance') return compact ? 62 : 65;
  if (heartbeat.status === 'unknown') return compact ? 48 : 52;

  if (heartbeat.latency_ms === null || !scale) return compact ? 74 : 78;

  const displayLatency = clampLatencyToCeiling(heartbeat.latency_ms, scale.ceiling);
  const normalized = (displayLatency - scale.min) / scale.span;
  const clamped = Math.max(0, Math.min(1, normalized));
  const minHeight = compact ? 36 : 38;
  return minHeight + clamped * (100 - minHeight);
}

function heartbeatFill(status: CheckStatus): string {
  switch (status) {
    case 'up':
      return '#10b981';
    case 'down':
      return '#ef4444';
    case 'maintenance':
      return '#3b82f6';
    case 'unknown':
    default:
      return '#cbd5e1';
  }
}

function tooltipDotClass(status: CheckStatus): string {
  switch (status) {
    case 'up':
      return 'bg-emerald-500 dark:bg-emerald-400';
    case 'down':
      return 'bg-red-500 dark:bg-red-400';
    case 'maintenance':
      return 'bg-blue-500 dark:bg-blue-400';
    case 'unknown':
    default:
      return 'bg-slate-300 dark:bg-slate-600';
  }
}

function buildSvgDataUri(
  slots: DisplaySlot[],
  compact: boolean,
  scale: LatencyScale | null,
): string {
  const height = compact ? 20 : 24;
  const barWidth = compact ? 4 : 6;
  const gap = compact ? 2 : 3;
  const width = slots.length === 0 ? barWidth : slots.length * barWidth + (slots.length - 1) * gap;

  const rects = slots
    .map((slot, index) => {
      const x = index * (barWidth + gap);
      if (!slot.heartbeat) {
        const emptyHeight = compact ? height * 0.46 : height * 0.48;
        const y = height - emptyHeight;
        return `<rect x="${x}" y="${y.toFixed(2)}" width="${barWidth}" height="${emptyHeight.toFixed(2)}" rx="1" fill="transparent"/>`;
      }

      const barHeight = (height * getBarHeightPct(slot.heartbeat, scale, compact)) / 100;
      const y = height - barHeight;
      return `<rect x="${x}" y="${y.toFixed(2)}" width="${barWidth}" height="${barHeight.toFixed(2)}" rx="1" fill="${heartbeatFill(slot.heartbeat.status)}"/>`;
    })
    .join('');

  const svg = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function formatTime(timestamp: number, locale: string): string {
  return new Date(timestamp * 1000).toLocaleString(locale);
}

function aggregateHeartbeats(heartbeats: Heartbeat[], slots: number): DisplayHeartbeat[] {
  if (heartbeats.length === 0) return [];

  const chronological = [...heartbeats].reverse();
  if (slots >= chronological.length) {
    return chronological.map((hb) => ({
      ...hb,
      from_checked_at: hb.checked_at,
      to_checked_at: hb.checked_at,
      sample_count: 1,
    }));
  }

  const groupSize = Math.ceil(chronological.length / slots);
  const groups: DisplayHeartbeat[] = [];

  for (let start = 0; start < chronological.length; start += groupSize) {
    const endExclusive = Math.min(chronological.length, start + groupSize);
    const first = chronological[start];
    const last = chronological[endExclusive - 1];
    if (!first || !last) continue;

    let worst = first;
    let latencySum = 0;
    let latencyCount = 0;
    for (let index = start; index < endExclusive; index += 1) {
      const hb = chronological[index];
      if (!hb) continue;

      if (statusPriority(hb.status) > statusPriority(worst.status)) {
        worst = hb;
      }

      if (
        hb.status === 'up' &&
        typeof hb.latency_ms === 'number' &&
        Number.isFinite(hb.latency_ms)
      ) {
        latencySum += hb.latency_ms;
        latencyCount++;
      }
    }

    groups.push({
      checked_at: last.checked_at,
      status: worst.status,
      latency_ms: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
      from_checked_at: first.checked_at,
      to_checked_at: last.checked_at,
      sample_count: endExclusive - start,
    });
  }

  return groups;
}

function Tooltip({
  heartbeat,
  position,
}: {
  heartbeat: DisplayHeartbeat;
  position: { x: number; y: number };
}) {
  const { locale, t } = useI18n();
  const hasWindow =
    heartbeat.sample_count > 1 && heartbeat.from_checked_at !== heartbeat.to_checked_at;

  return (
    <div
      className="fixed z-50 px-3 py-2 text-xs bg-slate-900 dark:bg-slate-700 text-white rounded-lg shadow-lg pointer-events-none animate-fade-in"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-8px)',
      }}
    >
      <div className="font-medium mb-1">
        {hasWindow
          ? `${formatTime(heartbeat.from_checked_at, locale)} ${t('heartbeat.to')} ${formatTime(heartbeat.to_checked_at, locale)}`
          : formatTime(heartbeat.checked_at, locale)}
      </div>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${tooltipDotClass(heartbeat.status)}`} />
        <span>{statusLabel(heartbeat.status, t)}</span>
        {heartbeat.latency_ms !== null && (
          <span className="text-slate-400 dark:text-slate-300">• {heartbeat.latency_ms}ms</span>
        )}
      </div>
      {heartbeat.sample_count > 1 && (
        <div className="mt-1 text-slate-300">
          {t('heartbeat.sample_checks', { count: heartbeat.sample_count })}
        </div>
      )}
      <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-slate-900 dark:bg-slate-700 rotate-45" />
    </div>
  );
}

export function HeartbeatBar({
  heartbeats,
  strip,
  maxBars = 60,
  visualBars,
  density = 'default',
}: HeartbeatBarProps) {
  const { t } = useI18n();
  const [tooltip, setTooltip] = useState<{
    heartbeat: DisplayHeartbeat;
    index: number;
    position: { x: number; y: number };
  } | null>(null);
  const compact = density === 'compact';

  const sourceHeartbeats = useMemo(() => {
    const decoded = heartbeats ?? decodeHeartbeatStrip(strip);
    return decoded.slice(0, maxBars);
  }, [heartbeats, maxBars, strip]);
  const slotCount = useMemo(() => {
    if (!visualBars || visualBars < 1) return maxBars;
    return Math.min(maxBars, visualBars);
  }, [maxBars, visualBars]);
  const displayHeartbeats = useMemo(
    () => aggregateHeartbeats(sourceHeartbeats, slotCount),
    [sourceHeartbeats, slotCount],
  );
  const latencyScale = useMemo(() => buildLatencyScale(displayHeartbeats), [displayHeartbeats]);
  const slots = useMemo<DisplaySlot[]>(
    () => [
      ...displayHeartbeats.map((heartbeat) => ({ heartbeat })),
      ...Array.from({ length: Math.max(0, slotCount - displayHeartbeats.length) }, () => ({
        heartbeat: null,
      })),
    ],
    [displayHeartbeats, slotCount],
  );
  const backgroundImage = useMemo(
    () => buildSvgDataUri(slots, compact, latencyScale),
    [compact, latencyScale, slots],
  );

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (slotCount === 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999999, (event.clientX - rect.left) / rect.width));
    const index = Math.floor(ratio * slotCount);
    const slot = slots[index];
    if (!slot?.heartbeat) {
      if (tooltip) setTooltip(null);
      return;
    }

    setTooltip({
      heartbeat: slot.heartbeat,
      index,
      position: {
        x: rect.left + ((index + 0.5) / slotCount) * rect.width,
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
          role="img"
          aria-label={t('monitor_card.last_checks', {
            count: Math.min(sourceHeartbeats.length, slotCount),
          })}
          className="relative h-full w-full rounded-md bg-slate-200 dark:bg-slate-700"
          style={{
            backgroundImage,
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: '100% 100%',
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
        />
        {tooltip && (
          <div
            key={`heartbeat-overlay-${tooltip.index}-${tooltip.heartbeat.from_checked_at}-${tooltip.heartbeat.to_checked_at}`}
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
          <Tooltip heartbeat={tooltip.heartbeat} position={tooltip.position} />,
          document.body,
        )}
    </>
  );
}
