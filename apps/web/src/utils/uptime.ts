import type { UptimeColorTier, UptimeRatingLevel } from '../api/types';

// ──────── Thresholds ────────

export const UPTIME_THRESHOLDS_BY_LEVEL: Record<
  UptimeRatingLevel,
  { emerald: number; green: number; lime: number; yellow: number; amber: number; orange: number; red: number }
> = {
  1: { emerald: 99.0, green: 98.0, lime: 97.0, yellow: 96.0, amber: 95.0, orange: 90.0, red: 80.0 },
  2: { emerald: 99.9, green: 99.5, lime: 99.0, yellow: 98.5, amber: 98.0, orange: 97.0, red: 95.0 },
  3: { emerald: 99.99, green: 99.95, lime: 99.9, yellow: 99.5, amber: 99.0, orange: 98.0, red: 97.0 },
  4: { emerald: 99.999, green: 99.995, lime: 99.99, yellow: 99.95, amber: 99.9, orange: 99.5, red: 99.0 },
  5: { emerald: 100.0, green: 99.999, lime: 99.995, yellow: 99.99, amber: 99.95, orange: 99.9, red: 99.5 },
};

// ──────── Tier resolution ────────

export function getUptimeTier(uptimePct: number, level: UptimeRatingLevel): UptimeColorTier {
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

// ──────── Tailwind class mappings ────────

export function getUptimeBgClasses(tier: UptimeColorTier): string {
  switch (tier) {
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

export function getUptimePillClasses(tier: UptimeColorTier): string {
  switch (tier) {
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

// ──────── Formatting ────────

export function formatPct(v: number): string {
  if (!Number.isFinite(v)) return '-';
  return `${v.toFixed(3)}%`;
}

export function formatLatency(v: number | null): string {
  return v === null ? '-' : `${v}ms`;
}
