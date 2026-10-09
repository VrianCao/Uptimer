export const TRACE_HEADER = 'X-Uptimer-Trace';
export const TRACE_ID_HEADER = 'X-Uptimer-Trace-Id';
export const TRACE_TOKEN_HEADER = 'X-Uptimer-Trace-Token';
export const TRACE_MODE_HEADER = 'X-Uptimer-Trace-Mode';
export const TRACE_INFO_HEADER = 'X-Uptimer-Trace';

function normalizeTruthyHeader(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeFalsyHeader(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
  );
}

function readTraceToken(env: Record<string, unknown> | undefined): string | null {
  if (!env) return null;
  const raw = env['UPTIMER_TRACE_TOKEN'] ?? env['TRACE_TOKEN'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type TraceOptions = {
  enabled: boolean;
  id: string;
  mode: string | null;
  timingsEnabled?: boolean;
};

export function resolveTraceOptions(opts: {
  header: (name: string) => string | undefined;
  env?: Record<string, unknown>;
}): TraceOptions {
  const enabled = normalizeTruthyHeader(opts.header(TRACE_HEADER));
  const modeRaw = opts.header(TRACE_MODE_HEADER);
  const mode = typeof modeRaw === 'string' && modeRaw.trim().length > 0 ? modeRaw.trim() : null;

  if (!enabled) {
    return { enabled: false, id: '', mode, timingsEnabled: false };
  }

  const token = readTraceToken(opts.env);
  if (!token) {
    return { enabled: false, id: '', mode, timingsEnabled: false };
  }

  const provided = opts.header(TRACE_TOKEN_HEADER) ?? '';
  if (provided !== token) {
    return { enabled: false, id: '', mode, timingsEnabled: false };
  }

  const idFromHeader = opts.header(TRACE_ID_HEADER);
  const id =
    typeof idFromHeader === 'string' && idFromHeader.trim().length > 0
      ? idFromHeader.trim()
      : crypto.randomUUID();

  const timingsRaw = opts.env?.['UPTIMER_TRACE_TIMINGS'];
  const timingsEnabled = typeof timingsRaw === 'string' ? !normalizeFalsyHeader(timingsRaw) : true;

  return { enabled: true, id, mode, timingsEnabled };
}

function formatServerTimingMetric(name: string, durMs: number): string {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dur = Number.isFinite(durMs) ? Math.max(0, durMs) : 0;
  return `${safeName};dur=${dur.toFixed(2)}`;
}

export class Trace {
  readonly enabled: boolean;
  readonly id: string;
  readonly mode: string | null;
  readonly timingsEnabled: boolean;

  #t0: number;
  #spans: Array<{ name: string; durMs: number }> = [];
  #labels: Map<string, string> = new Map();

  constructor(opts: TraceOptions) {
    this.enabled = opts.enabled;
    this.id = opts.id;
    this.mode = opts.mode;
    this.timingsEnabled = opts.enabled && opts.timingsEnabled !== false;
    this.#t0 = this.timingsEnabled ? performance.now() : 0;
  }

  setLabel(key: string, value: string | number | boolean | null | undefined): void {
    if (!this.enabled) return;
    if (!key) return;
    if (value === null || value === undefined) return;
    const str = typeof value === 'string' ? value : String(value);
    if (!str) return;
    this.#labels.set(key, str);
  }

  addSpan(name: string, durMs: number): void {
    if (!this.timingsEnabled) return;
    if (!name) return;
    this.#spans.push({ name, durMs });
  }

  time<T>(name: string, fn: () => T): T {
    if (!this.timingsEnabled) return fn();
    const t0 = performance.now();
    const out = fn();
    const t1 = performance.now();
    this.addSpan(name, t1 - t0);
    return out;
  }

  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.timingsEnabled) return fn();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      const t1 = performance.now();
      this.addSpan(name, t1 - t0);
    }
  }

  finish(totalName = 'total'): void {
    if (!this.timingsEnabled) return;
    const t1 = performance.now();
    this.addSpan(totalName, t1 - this.#t0);
  }

  toServerTiming(prefix?: string): string {
    if (!this.enabled || !this.timingsEnabled) return '';
    const trimmedPrefix = prefix ? prefix.trim() : '';
    const prefixValue = trimmedPrefix.length > 0 ? `${trimmedPrefix}_` : '';
    return this.#spans
      .map((span) => formatServerTimingMetric(`${prefixValue}${span.name}`, span.durMs))
      .join(', ');
  }

  toInfoHeader(): string {
    if (!this.enabled) return '';
    const pairs: string[] = [];
    for (const [key, value] of this.#labels.entries()) {
      const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const safeValue = value.replace(/[;\r\n]/g, '_');
      pairs.push(`${safeKey}=${safeValue}`);
    }
    if (this.mode) {
      pairs.push(`mode=${this.mode.replace(/[;\r\n]/g, '_')}`);
    }
    return pairs.join(';');
  }
}

export function appendServerTimingHeader(res: Response, value: string): void {
  if (!value) return;
  const existing = res.headers.get('Server-Timing');
  if (existing) {
    res.headers.set('Server-Timing', `${existing}, ${value}`);
  } else {
    res.headers.set('Server-Timing', value);
  }
}

export function applyTraceToResponse(opts: {
  res: Response;
  trace: Trace;
  prefix?: string;
  info?: string;
  serverTiming?: string;
}): void {
  if (!opts.trace.enabled) return;
  opts.res.headers.set(TRACE_ID_HEADER, opts.trace.id);

  const info = opts.info ?? opts.trace.toInfoHeader();
  if (info) {
    const existing = opts.res.headers.get(TRACE_INFO_HEADER);
    opts.res.headers.set(TRACE_INFO_HEADER, existing ? `${existing};${info}` : info);
  }

  const serverTiming = opts.serverTiming ?? opts.trace.toServerTiming(opts.prefix);
  appendServerTimingHeader(opts.res, serverTiming);
}
