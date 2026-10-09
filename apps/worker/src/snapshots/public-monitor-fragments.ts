import { z } from 'zod';

import { parseMonitorRuntimeUpdate, type MonitorRuntimeUpdate } from '../public/monitor-runtime';
import {
  homepageMonitorCardSchema,
  publicHomepageResponseSchema,
  storedPublicHomepageResponseSchema,
  type PublicHomepageResponse,
} from '../schemas/public-homepage';
import {
  publicStatusResponseSchema,
  storedPublicStatusResponseSchema,
  type PublicStatusResponse,
} from '../schemas/public-status';
import {
  readPublicSnapshotFragments,
  readPublicSnapshotFragmentsPage,
  type PublicSnapshotFragmentRow,
  type PublicSnapshotFragmentWrite,
} from './public-fragments';

export const STATUS_MONITOR_FRAGMENTS_KEY = 'status:monitors';
export const HOMEPAGE_MONITOR_FRAGMENTS_KEY = 'homepage:monitors';
export const STATUS_ENVELOPE_FRAGMENT_KEY = 'status:envelope';
export const HOMEPAGE_ENVELOPE_FRAGMENT_KEY = 'homepage:envelope';
export const MONITOR_RUNTIME_UPDATE_FRAGMENTS_KEY = 'monitor-runtime:updates';
export const PUBLIC_SNAPSHOT_ENVELOPE_FRAGMENT_KEY = 'envelope';

const MONITOR_FRAGMENT_PREFIX = 'monitor:';

function assertMonitorId(monitorId: number): void {
  if (!Number.isInteger(monitorId) || monitorId <= 0) {
    throw new Error('public monitor fragment id must be a positive integer');
  }
}

function toSelectedMonitorIdSet(monitorIds?: Iterable<number>): Set<number> | null {
  if (!monitorIds) {
    return null;
  }

  const selected = new Set<number>();
  for (const monitorId of monitorIds) {
    assertMonitorId(monitorId);
    selected.add(monitorId);
  }
  return selected;
}

export function toPublicMonitorFragmentKey(monitorId: number): string {
  assertMonitorId(monitorId);
  return `${MONITOR_FRAGMENT_PREFIX}${monitorId}`;
}

export function parsePublicMonitorFragmentKey(fragmentKey: string): number | null {
  if (!fragmentKey.startsWith(MONITOR_FRAGMENT_PREFIX)) {
    return null;
  }
  const parsed = Number.parseInt(fragmentKey.slice(MONITOR_FRAGMENT_PREFIX.length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function shouldWriteMonitorFragment(
  selectedMonitorIds: ReadonlySet<number> | null,
  monitorId: number,
): boolean {
  return selectedMonitorIds === null || selectedMonitorIds.has(monitorId);
}

function buildMonitorFragmentWrite(opts: {
  snapshotKey: string;
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
}): PublicSnapshotFragmentWrite {
  return {
    snapshotKey: opts.snapshotKey,
    fragmentKey: opts.fragmentKey,
    generatedAt: opts.generatedAt,
    bodyJson: opts.bodyJson,
    updatedAt: opts.updatedAt,
  };
}

export function buildStatusMonitorFragmentWrites(
  payload: PublicStatusResponse,
  updatedAt: number,
  monitorIds?: Iterable<number>,
): PublicSnapshotFragmentWrite[] {
  const selectedMonitorIds = toSelectedMonitorIdSet(monitorIds);
  const writes: PublicSnapshotFragmentWrite[] = [];

  for (const monitor of payload.monitors) {
    if (!shouldWriteMonitorFragment(selectedMonitorIds, monitor.id)) {
      continue;
    }
    writes.push(
      buildMonitorFragmentWrite({
        snapshotKey: STATUS_MONITOR_FRAGMENTS_KEY,
        fragmentKey: toPublicMonitorFragmentKey(monitor.id),
        generatedAt: payload.generated_at,
        bodyJson: JSON.stringify(monitor),
        updatedAt,
      }),
    );
  }

  return writes;
}

export function buildHomepageMonitorFragmentWrites(
  payload: PublicHomepageResponse,
  updatedAt: number,
  monitorIds?: Iterable<number>,
): PublicSnapshotFragmentWrite[] {
  const selectedMonitorIds = toSelectedMonitorIdSet(monitorIds);
  const writes: PublicSnapshotFragmentWrite[] = [];

  for (const monitor of payload.monitors) {
    if (!shouldWriteMonitorFragment(selectedMonitorIds, monitor.id)) {
      continue;
    }
    writes.push(
      buildMonitorFragmentWrite({
        snapshotKey: HOMEPAGE_MONITOR_FRAGMENTS_KEY,
        fragmentKey: toPublicMonitorFragmentKey(monitor.id),
        generatedAt: payload.generated_at,
        bodyJson: JSON.stringify(monitor),
        updatedAt,
      }),
    );
  }

  return writes;
}

const positiveMonitorIdArraySchema = z.array(z.number().int().positive());
const statusMonitorFragmentSchema = storedPublicStatusResponseSchema.shape.monitors.element;
const statusEnvelopeFragmentSchema = storedPublicStatusResponseSchema
  .omit({ monitors: true })
  .extend({ monitor_ids: positiveMonitorIdArraySchema });
const homepageEnvelopeFragmentSchema = storedPublicHomepageResponseSchema
  .omit({ monitors: true })
  .extend({ monitor_ids: positiveMonitorIdArraySchema });

export type PublicStatusEnvelopeFragment = z.infer<typeof statusEnvelopeFragmentSchema>;
export type PublicHomepageEnvelopeFragment = z.infer<typeof homepageEnvelopeFragmentSchema>;
export type StatusMonitorFragment = PublicStatusResponse['monitors'][number];
export type HomepageMonitorFragment = PublicHomepageResponse['monitors'][number];

function normalizeDisplayUrl(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function toStatusEnvelopeFragment(
  payload: PublicStatusResponse,
): PublicStatusEnvelopeFragment {
  const { monitors, ...envelope } = payload;
  return {
    ...envelope,
    monitor_ids: monitors.map((monitor) => monitor.id),
  };
}

export function toHomepageEnvelopeFragment(
  payload: PublicHomepageResponse,
): PublicHomepageEnvelopeFragment {
  const { monitors, ...envelope } = payload;
  return {
    ...envelope,
    monitor_ids: monitors.map((monitor) => monitor.id),
  };
}

export function buildStatusEnvelopeFragmentWrite(
  payload: PublicStatusResponse,
  updatedAt: number,
): PublicSnapshotFragmentWrite {
  return buildMonitorFragmentWrite({
    snapshotKey: STATUS_ENVELOPE_FRAGMENT_KEY,
    fragmentKey: PUBLIC_SNAPSHOT_ENVELOPE_FRAGMENT_KEY,
    generatedAt: payload.generated_at,
    bodyJson: JSON.stringify(toStatusEnvelopeFragment(payload)),
    updatedAt,
  });
}

export function buildHomepageEnvelopeFragmentWrite(
  payload: PublicHomepageResponse,
  updatedAt: number,
): PublicSnapshotFragmentWrite {
  return buildMonitorFragmentWrite({
    snapshotKey: HOMEPAGE_ENVELOPE_FRAGMENT_KEY,
    fragmentKey: PUBLIC_SNAPSHOT_ENVELOPE_FRAGMENT_KEY,
    generatedAt: payload.generated_at,
    bodyJson: JSON.stringify(toHomepageEnvelopeFragment(payload)),
    updatedAt,
  });
}

function toCompactRuntimeUpdate(update: MonitorRuntimeUpdate): unknown[] {
  return [
    update.monitor_id,
    update.interval_sec,
    update.created_at,
    update.checked_at,
    update.check_status,
    update.next_status,
    update.latency_ms,
  ];
}

export function buildMonitorRuntimeUpdateFragmentWrites(
  updates: readonly MonitorRuntimeUpdate[],
  updatedAt: number,
): PublicSnapshotFragmentWrite[] {
  const latestUpdateByMonitorId = new Map<number, MonitorRuntimeUpdate>();
  for (const update of updates) {
    assertMonitorId(update.monitor_id);
    const previous = latestUpdateByMonitorId.get(update.monitor_id);
    if (!previous || update.checked_at >= previous.checked_at) {
      latestUpdateByMonitorId.set(update.monitor_id, update);
    }
  }

  return [...latestUpdateByMonitorId.values()].map((update) =>
    buildMonitorFragmentWrite({
      snapshotKey: MONITOR_RUNTIME_UPDATE_FRAGMENTS_KEY,
      fragmentKey: toPublicMonitorFragmentKey(update.monitor_id),
      generatedAt: update.checked_at,
      bodyJson: JSON.stringify(toCompactRuntimeUpdate(update)),
      updatedAt,
    }),
  );
}

export type MonitorRuntimeUpdateFragmentReadOptions = {
  minGeneratedAt?: number;
  maxGeneratedAt?: number;
};

export type MonitorRuntimeUpdateFragmentReadResult = {
  updates: MonitorRuntimeUpdate[];
  invalidCount: number;
  staleCount: number;
};

export type MonitorRuntimeUpdateFragmentPageReadResult = MonitorRuntimeUpdateFragmentReadResult & {
  hasMore: boolean;
  rowCount: number;
};

function shouldSkipRuntimeUpdateFragmentByTime(
  row: PublicSnapshotFragmentRow,
  opts: MonitorRuntimeUpdateFragmentReadOptions,
): boolean {
  return (
    (opts.minGeneratedAt !== undefined && row.generated_at < opts.minGeneratedAt) ||
    (opts.maxGeneratedAt !== undefined && row.generated_at > opts.maxGeneratedAt)
  );
}

export function parseMonitorRuntimeUpdateFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
  opts: MonitorRuntimeUpdateFragmentReadOptions = {},
): MonitorRuntimeUpdateFragmentReadResult {
  const latestUpdateByMonitorId = new Map<number, MonitorRuntimeUpdate>();
  let invalidCount = 0;
  let staleCount = 0;

  for (const row of rows) {
    if (shouldSkipRuntimeUpdateFragmentByTime(row, opts)) {
      staleCount += 1;
      continue;
    }

    const monitorId = parsePublicMonitorFragmentKey(row.fragment_key);
    if (monitorId === null) {
      invalidCount += 1;
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(row.body_json) as unknown;
    } catch {
      invalidCount += 1;
      continue;
    }

    const update = parseMonitorRuntimeUpdate(raw);
    if (!update || update.monitor_id !== monitorId || update.checked_at !== row.generated_at) {
      invalidCount += 1;
      continue;
    }

    const previous = latestUpdateByMonitorId.get(update.monitor_id);
    if (!previous || update.checked_at >= previous.checked_at) {
      latestUpdateByMonitorId.set(update.monitor_id, update);
    }
  }

  return {
    updates: [...latestUpdateByMonitorId.values()].sort((a, b) => a.monitor_id - b.monitor_id),
    invalidCount,
    staleCount,
  };
}

export type PublicSnapshotFragmentParseResult<T> = {
  data: T[];
  invalidCount: number;
  staleCount: number;
};

export type PublicSnapshotEnvelopeReadResult<T> = {
  data: T;
  generatedAt: number;
  updatedAt: number | null;
};

export type PublicSnapshotBodyJsonFragmentReadResult = {
  bodyJson: string;
  generatedAt: number;
  monitorCount: number;
  invalidCount: number;
  staleCount: number;
};

type RawMonitorJsonFragmentParseResult = {
  bodyJsonByMonitorId: Map<number, string>;
  invalidCount: number;
  staleCount: number;
};

function parseFragmentJson(row: PublicSnapshotFragmentRow): unknown | null {
  try {
    return JSON.parse(row.body_json) as unknown;
  } catch {
    return null;
  }
}

function findEnvelopeRow(
  rows: readonly PublicSnapshotFragmentRow[],
): PublicSnapshotFragmentRow | null {
  let selected: PublicSnapshotFragmentRow | null = null;
  for (const row of rows) {
    if (row.fragment_key !== PUBLIC_SNAPSHOT_ENVELOPE_FRAGMENT_KEY) {
      continue;
    }
    if (!selected || row.generated_at >= selected.generated_at) {
      selected = row;
    }
  }
  return selected;
}

function parseEnvelopeFragment<T extends { generated_at: number }>(
  rows: readonly PublicSnapshotFragmentRow[],
  schema: z.ZodType<T>,
): PublicSnapshotEnvelopeReadResult<T> | null {
  const row = findEnvelopeRow(rows);
  if (!row) {
    return null;
  }
  const raw = parseFragmentJson(row);
  if (raw === null) {
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.generated_at !== row.generated_at) {
    return null;
  }
  return {
    data: parsed.data,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

function parseMonitorFragmentRows<T extends { id: number }>(
  rows: readonly PublicSnapshotFragmentRow[],
  schema: z.ZodType<T>,
  opts: MonitorRuntimeUpdateFragmentReadOptions = {},
): PublicSnapshotFragmentParseResult<T> {
  const latestByMonitorId = new Map<number, T>();
  const generatedAtByMonitorId = new Map<number, number>();
  let invalidCount = 0;
  let staleCount = 0;

  for (const row of rows) {
    if (shouldSkipRuntimeUpdateFragmentByTime(row, opts)) {
      staleCount += 1;
      continue;
    }

    const monitorId = parsePublicMonitorFragmentKey(row.fragment_key);
    if (monitorId === null) {
      invalidCount += 1;
      continue;
    }

    const raw = parseFragmentJson(row);
    if (raw === null) {
      invalidCount += 1;
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== monitorId) {
      invalidCount += 1;
      continue;
    }

    const previousGeneratedAt = generatedAtByMonitorId.get(monitorId);
    if (previousGeneratedAt === undefined || row.generated_at >= previousGeneratedAt) {
      latestByMonitorId.set(monitorId, parsed.data);
      generatedAtByMonitorId.set(monitorId, row.generated_at);
    }
  }

  return {
    data: [...latestByMonitorId.values()].sort((a, b) => a.id - b.id),
    invalidCount,
    staleCount,
  };
}

export function parseHomepageEnvelopeFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
): PublicSnapshotEnvelopeReadResult<PublicHomepageEnvelopeFragment> | null {
  return parseEnvelopeFragment(rows, homepageEnvelopeFragmentSchema);
}

export function parseStatusEnvelopeFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
): PublicSnapshotEnvelopeReadResult<PublicStatusEnvelopeFragment> | null {
  return parseEnvelopeFragment(rows, statusEnvelopeFragmentSchema);
}

export function parseHomepageMonitorFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
  opts: MonitorRuntimeUpdateFragmentReadOptions = {},
): PublicSnapshotFragmentParseResult<HomepageMonitorFragment> {
  const parsed = parseMonitorFragmentRows(rows, homepageMonitorCardSchema, opts);
  return {
    ...parsed,
    data: parsed.data.map(
      (monitor): HomepageMonitorFragment => ({
        ...monitor,
        display_url: normalizeDisplayUrl(monitor.display_url),
      }),
    ),
  };
}

export function parseStatusMonitorFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
  opts: MonitorRuntimeUpdateFragmentReadOptions = {},
): PublicSnapshotFragmentParseResult<StatusMonitorFragment> {
  const parsed = parseMonitorFragmentRows(rows, statusMonitorFragmentSchema, opts);
  return {
    ...parsed,
    data: parsed.data.map(
      (monitor): StatusMonitorFragment => ({
        ...monitor,
        display_url: normalizeDisplayUrl(monitor.display_url),
      }),
    ),
  };
}

function orderMonitorFragmentsByEnvelope<T extends { id: number }>(
  monitorIds: readonly number[],
  monitors: readonly T[],
): T[] | null {
  const byId = new Map<number, T>();
  for (const monitor of monitors) {
    byId.set(monitor.id, monitor);
  }
  const ordered: T[] = [];
  for (const id of monitorIds) {
    const monitor = byId.get(id);
    if (!monitor) {
      return null;
    }
    ordered.push(monitor);
  }
  return ordered;
}

export function assemblePublicHomepagePayloadFromFragments(
  envelope: PublicHomepageEnvelopeFragment,
  monitors: readonly HomepageMonitorFragment[],
): PublicHomepageResponse | null {
  const orderedMonitors = orderMonitorFragmentsByEnvelope(envelope.monitor_ids, monitors);
  if (!orderedMonitors) {
    return null;
  }
  const { monitor_ids: _monitorIds, ...publicEnvelope } = envelope;
  const assembled = {
    ...publicEnvelope,
    monitors: orderedMonitors,
  };
  const parsed = publicHomepageResponseSchema.safeParse(assembled);
  return parsed.success ? parsed.data : null;
}

export function assemblePublicStatusPayloadFromFragments(
  envelope: PublicStatusEnvelopeFragment,
  monitors: readonly StatusMonitorFragment[],
): PublicStatusResponse | null {
  const orderedMonitors = orderMonitorFragmentsByEnvelope(envelope.monitor_ids, monitors);
  if (!orderedMonitors) {
    return null;
  }
  const { monitor_ids: _monitorIds, ...publicEnvelope } = envelope;
  const assembled = {
    ...publicEnvelope,
    monitors: orderedMonitors,
  };
  const parsed = publicStatusResponseSchema.safeParse(assembled);
  return parsed.success ? parsed.data : null;
}

function looksLikeJsonObjectText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

function parseRawMonitorJsonFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
  expectedGeneratedAt: number,
): RawMonitorJsonFragmentParseResult {
  const bodyJsonByMonitorId = new Map<number, string>();
  let invalidCount = 0;
  let staleCount = 0;

  for (const row of rows) {
    const monitorId = parsePublicMonitorFragmentKey(row.fragment_key);
    if (monitorId === null) {
      invalidCount += 1;
      continue;
    }
    if (row.generated_at !== expectedGeneratedAt) {
      staleCount += 1;
      continue;
    }
    const bodyJson = row.body_json.trim();
    if (!looksLikeJsonObjectText(bodyJson)) {
      invalidCount += 1;
      continue;
    }
    bodyJsonByMonitorId.set(monitorId, bodyJson);
  }

  return { bodyJsonByMonitorId, invalidCount, staleCount };
}

function assemblePublicSnapshotBodyJsonFromRawMonitorFragments<T extends { monitor_ids: number[] }>(
  envelope: T,
  bodyJsonByMonitorId: ReadonlyMap<number, string>,
): string | null {
  const monitorJson: string[] = [];
  for (const monitorId of envelope.monitor_ids) {
    const bodyJson = bodyJsonByMonitorId.get(monitorId);
    if (!bodyJson) {
      return null;
    }
    monitorJson.push(bodyJson);
  }

  const { monitor_ids: _monitorIds, ...publicEnvelope } = envelope;
  const envelopeJson = JSON.stringify(publicEnvelope);
  if (envelopeJson === '{}') {
    return `{"monitors":[${monitorJson.join(',')}]}`;
  }
  return `${envelopeJson.slice(0, -1)},"monitors":[${monitorJson.join(',')}]}`;
}

async function readSnapshotBodyJsonFromFragments<
  T extends { generated_at: number; monitor_ids: number[] },
>(
  db: D1Database,
  envelopeSnapshotKey: string,
  monitorSnapshotKey: string,
  parseEnvelope: (
    rows: readonly PublicSnapshotFragmentRow[],
  ) => PublicSnapshotEnvelopeReadResult<T> | null,
): Promise<PublicSnapshotBodyJsonFragmentReadResult | null> {
  const [envelopeRows, monitorRows] = await Promise.all([
    readPublicSnapshotFragments(db, envelopeSnapshotKey),
    readPublicSnapshotFragments(db, monitorSnapshotKey),
  ]);
  const envelope = parseEnvelope(envelopeRows);
  if (!envelope) {
    return null;
  }

  const monitors = parseRawMonitorJsonFragmentRows(monitorRows, envelope.generatedAt);
  const bodyJson = assemblePublicSnapshotBodyJsonFromRawMonitorFragments(
    envelope.data,
    monitors.bodyJsonByMonitorId,
  );
  if (bodyJson === null) {
    return null;
  }

  return {
    bodyJson,
    generatedAt: envelope.generatedAt,
    monitorCount: envelope.data.monitor_ids.length,
    invalidCount: monitors.invalidCount,
    staleCount: monitors.staleCount,
  };
}

export async function readHomepageSnapshotBodyJsonFromFragments(
  db: D1Database,
): Promise<PublicSnapshotBodyJsonFragmentReadResult | null> {
  return await readSnapshotBodyJsonFromFragments(
    db,
    HOMEPAGE_ENVELOPE_FRAGMENT_KEY,
    HOMEPAGE_MONITOR_FRAGMENTS_KEY,
    parseHomepageEnvelopeFragmentRows,
  );
}

export async function readStatusSnapshotBodyJsonFromFragments(
  db: D1Database,
): Promise<PublicSnapshotBodyJsonFragmentReadResult | null> {
  return await readSnapshotBodyJsonFromFragments(
    db,
    STATUS_ENVELOPE_FRAGMENT_KEY,
    STATUS_MONITOR_FRAGMENTS_KEY,
    parseStatusEnvelopeFragmentRows,
  );
}

export async function readHomepageSnapshotFragments(db: D1Database): Promise<{
  envelope: PublicSnapshotEnvelopeReadResult<PublicHomepageEnvelopeFragment> | null;
  monitors: PublicSnapshotFragmentParseResult<HomepageMonitorFragment>;
}> {
  const [envelopeRows, monitorRows] = await Promise.all([
    readPublicSnapshotFragments(db, HOMEPAGE_ENVELOPE_FRAGMENT_KEY),
    readPublicSnapshotFragments(db, HOMEPAGE_MONITOR_FRAGMENTS_KEY),
  ]);
  return {
    envelope: parseHomepageEnvelopeFragmentRows(envelopeRows),
    monitors: parseHomepageMonitorFragmentRows(monitorRows),
  };
}

export async function readStatusSnapshotFragments(db: D1Database): Promise<{
  envelope: PublicSnapshotEnvelopeReadResult<PublicStatusEnvelopeFragment> | null;
  monitors: PublicSnapshotFragmentParseResult<StatusMonitorFragment>;
}> {
  const [envelopeRows, monitorRows] = await Promise.all([
    readPublicSnapshotFragments(db, STATUS_ENVELOPE_FRAGMENT_KEY),
    readPublicSnapshotFragments(db, STATUS_MONITOR_FRAGMENTS_KEY),
  ]);
  return {
    envelope: parseStatusEnvelopeFragmentRows(envelopeRows),
    monitors: parseStatusMonitorFragmentRows(monitorRows),
  };
}

export async function readMonitorRuntimeUpdateFragments(
  db: D1Database,
  opts: MonitorRuntimeUpdateFragmentReadOptions = {},
): Promise<MonitorRuntimeUpdateFragmentReadResult> {
  const rows = await readPublicSnapshotFragments(db, MONITOR_RUNTIME_UPDATE_FRAGMENTS_KEY);
  return parseMonitorRuntimeUpdateFragmentRows(rows, opts);
}

export async function readMonitorRuntimeUpdateFragmentsPage(
  db: D1Database,
  opts: MonitorRuntimeUpdateFragmentReadOptions & { offset: number; limit: number },
): Promise<MonitorRuntimeUpdateFragmentPageReadResult> {
  const readLimit = Math.max(1, Math.floor(opts.limit)) + 1;
  const rows = await readPublicSnapshotFragmentsPage(db, MONITOR_RUNTIME_UPDATE_FRAGMENTS_KEY, {
    offset: Math.max(0, Math.floor(opts.offset)),
    limit: readLimit,
  });
  const pageRows = rows.slice(0, Math.max(1, Math.floor(opts.limit)));
  const parsed = parseMonitorRuntimeUpdateFragmentRows(pageRows, opts);
  return {
    ...parsed,
    hasMore: rows.length > pageRows.length,
    rowCount: pageRows.length,
  };
}
