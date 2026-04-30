import type { NotificationEventType } from '@uptimer/db';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type PathToken = { type: 'prop'; key: string } | { type: 'index'; index: number };

function parsePath(path: string): PathToken[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const tokens: PathToken[] = [];
  let i = 0;

  while (i < trimmed.length) {
    // Skip leading dots.
    if (trimmed[i] === '.') {
      i++;
      continue;
    }

    // Parse property name.
    const start = i;
    while (i < trimmed.length && trimmed[i] !== '.' && trimmed[i] !== '[') {
      i++;
    }
    if (i > start) {
      const key = trimmed.slice(start, i);
      if (!key || FORBIDDEN_KEYS.has(key)) return null;
      tokens.push({ type: 'prop', key });
    }

    // Parse optional [index] segments.
    while (i < trimmed.length && trimmed[i] === '[') {
      i++; // consume '['
      const idxStart = i;
      while (i < trimmed.length && trimmed[i] !== ']') {
        i++;
      }
      if (i >= trimmed.length) return null;
      const raw = trimmed.slice(idxStart, i).trim();
      i++; // consume ']'
      if (!/^\d+$/.test(raw)) return null;
      const index = Number(raw);
      if (!Number.isInteger(index)) return null;
      tokens.push({ type: 'index', index });
    }

    if (i < trimmed.length && trimmed[i] === '.') {
      i++;
    }
  }

  return tokens.length > 0 ? tokens : null;
}

function resolvePathValue(vars: Record<string, unknown>, path: string): unknown {
  const tokens = parsePath(path);
  if (!tokens) return undefined;

  let cur: unknown = vars;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;

    if (t.type === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t.index];
      continue;
    }

    if (typeof cur !== 'object') return undefined;
    const rec = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, t.key)) return undefined;
    cur = rec[t.key];
  }

  return cur;
}

function toTemplateString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function renderStringTemplate(template: string, vars: Record<string, unknown>): string {
  const msg = typeof vars.message === 'string' ? vars.message : '';

  // Legacy compatibility: replace $MSG.
  if (template === '$MSG') return msg;
  const withMsg = msg ? template.split('$MSG').join(msg) : template;

  return withMsg.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr: string) => {
    const value = resolvePathValue(vars, expr);
    return toTemplateString(value);
  });
}

export function renderJsonTemplate(
  value: unknown,
  vars: Record<string, unknown>,
  opts: { maxDepth?: number } = {},
): unknown {
  const maxDepth = opts.maxDepth ?? 32;

  function inner(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return null;

    if (typeof v === 'string') {
      return renderStringTemplate(v, vars);
    }
    if (Array.isArray(v)) {
      return v.map((it) => inner(it, depth + 1));
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = inner(vv, depth + 1);
      }
      return out;
    }

    return v;
  }

  return inner(value, 0);
}

function asString(vars: Record<string, unknown>, path: string): string {
  const v = resolvePathValue(vars, path);
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function defaultMessageForEvent(
  eventType: NotificationEventType | string,
  vars: Record<string, unknown>,
): string {
  switch (eventType) {
    case 'monitor.down': {
      const name = asString(vars, 'monitor.name');
      const target = asString(vars, 'monitor.target');
      const err = asString(vars, 'state.error');
      return `Monitor DOWN: ${name}${target ? ` (${target})` : ''}${err ? `\nError: ${err}` : ''}`;
    }
    case 'monitor.up': {
      const name = asString(vars, 'monitor.name');
      const target = asString(vars, 'monitor.target');
      return `Monitor UP: ${name}${target ? ` (${target})` : ''}`;
    }
    case 'incident.created': {
      const title = asString(vars, 'incident.title');
      const impact = asString(vars, 'incident.impact');
      return `Incident created: ${title}${impact ? ` (impact: ${impact})` : ''}`;
    }
    case 'incident.updated': {
      const title = asString(vars, 'incident.title');
      const msg = asString(vars, 'update.message');
      return `Incident updated: ${title}${msg ? `\n${msg}` : ''}`;
    }
    case 'incident.resolved': {
      const title = asString(vars, 'incident.title');
      return `Incident resolved: ${title}`;
    }
    case 'maintenance.started': {
      const title = asString(vars, 'maintenance.title');
      return `Maintenance started: ${title}`;
    }
    case 'maintenance.ended': {
      const title = asString(vars, 'maintenance.title');
      return `Maintenance ended: ${title}`;
    }
    case 'test.ping': {
      return 'Uptimer test notification';
    }
    default: {
      const ev = asString(vars, 'event');
      return ev ? `Uptimer event: ${ev}` : 'Uptimer notification';
    }
  }
}
