export type TimeZone = string;
export type Locale = string;

export function getBrowserTimeZone(): TimeZone | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

function resolveLocale(locale?: Locale): Locale | undefined {
  if (locale && locale.trim().length > 0) return locale;
  if (typeof document === 'undefined') return undefined;
  const docLocale = document.documentElement.lang?.trim();
  return docLocale ? docLocale : undefined;
}

function safeDate(tsSec: number): Date | null {
  if (!Number.isFinite(tsSec)) return null;
  const d = new Date(tsSec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
// Every monitor renders the same completed UTC days. Reuse their translated
// labels as well as the formatter; keep implicit local-time fallbacks dynamic.
const dateLabels = new Map<string, string>();

function formatCached(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const key = JSON.stringify([locale, options]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, formatter);
  }
  // Date.toLocale* uses regular spaces in runtimes whose formatter emits U+202F.
  return formatter.format(date).replace(/\u202f/g, ' ');
}

export function formatDateTime(tsSec: number, timeZone?: TimeZone, locale?: Locale): string {
  const d = safeDate(tsSec);
  if (!d) return '';
  const resolvedLocale = resolveLocale(locale);

  try {
    return formatCached(d, resolvedLocale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    // Invalid/unsupported timeZone in this runtime; fall back to local.
    return formatCached(d, resolvedLocale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }
}

export function formatDate(tsSec: number, timeZone?: TimeZone, locale?: Locale): string {
  const resolvedLocale = resolveLocale(locale);
  const key = timeZone && resolvedLocale ? JSON.stringify([tsSec, timeZone, resolvedLocale]) : null;
  const cached = key ? dateLabels.get(key) : undefined;
  if (cached !== undefined) return cached;
  const d = safeDate(tsSec);
  if (!d) return '';

  try {
    const result = formatCached(d, resolvedLocale, timeZone ? { timeZone } : {});
    if (key) {
      if (dateLabels.size >= 512) dateLabels.delete(dateLabels.keys().next().value!);
      dateLabels.set(key, result);
    }
    return result;
  } catch {
    return formatCached(d, resolvedLocale, {});
  }
}

export function formatTime(
  tsSec: number,
  opts: { timeZone?: TimeZone; hour12?: boolean; locale?: Locale } = {},
): string {
  const d = safeDate(tsSec);
  if (!d) return '';
  const resolvedLocale = resolveLocale(opts.locale);

  try {
    return formatCached(d, resolvedLocale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(opts.hour12 === undefined ? {} : { hour12: opts.hour12 }),
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    });
  } catch {
    return formatCached(d, resolvedLocale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(opts.hour12 === undefined ? {} : { hour12: opts.hour12 }),
    });
  }
}
