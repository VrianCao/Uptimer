import { Hono } from 'hono';
import { z } from 'zod';

import { getDb, monitors } from '@uptimer/db';

import type { Env } from '../env';
import type { PublicHomepageResponse } from '../schemas/public-homepage';
import { hasValidAdminTokenRequest } from '../middleware/auth';
import {
  homepageFromStatusPayload,
  readHomepageHistoryPreviews,
} from '../public/homepage';
import { computePublicStatusPayload } from '../public/status';
import {
  buildNumberedPlaceholders,
  chunkPositiveIntegerIds,
  filterStatusPageScopedMonitorIds,
  incidentStatusPageVisibilityPredicate,
  listStatusPageVisibleMonitorIds,
  maintenanceWindowStatusPageVisibilityPredicate,
  monitorVisibilityPredicate,
  shouldIncludeStatusPageScopedItem,
} from '../public/visibility';
import {
  applyHomepageCacheHeaders,
  applyStatusCacheHeaders,
  readHomepageSnapshotArtifactJson,
  readHomepageSnapshotJson,
  readStatusSnapshot,
  readStaleHomepageSnapshot,
  readStaleHomepageSnapshotArtifact,
  readStaleHomepageSnapshotArtifactJson,
  toSnapshotPayload,
  writeStatusSnapshot,
} from '../snapshots';

import { AppError } from '../middleware/errors';
import { cachePublic } from '../middleware/cache-public';

type PublicStatusSnapshotRow = {
  generated_at: number;
  body_json: string;
};

const HOMEPAGE_UNKNOWN_DOWNGRADE_GUARD_SECONDS = 2 * 60;

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isAuthorizedStatusAdminRequest(c: {
  env: Pick<Env, 'ADMIN_TOKEN'>;
  req: { header(name: string): string | undefined };
}): boolean {
  return hasValidAdminTokenRequest(c);
}

function applyPrivateNoStore(res: Response): Response {
  const vary = res.headers.get('Vary');
  if (!vary) {
    res.headers.set('Vary', 'Authorization');
  } else if (!vary.split(',').some((part) => part.trim().toLowerCase() === 'authorization')) {
    res.headers.set('Vary', `${vary}, Authorization`);
  }

  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function withVisibilityAwareCaching(res: Response, includeHiddenMonitors: boolean): Response {
  return includeHiddenMonitors ? applyPrivateNoStore(res) : res;
}

function shouldPreferRecentHomepageArtifact(opts: {
  artifact:
    | {
        age: number;
        data: {
          snapshot: {
            overall_status: string;
            banner: { status: string };
            summary: { unknown: number };
          };
        };
      }
    | null;
  computed: {
    overall_status: string;
    banner: { status: string };
    summary: { unknown: number };
  };
}): boolean {
  const { artifact, computed } = opts;
  if (!artifact) return false;

  const snapshot = artifact.data.snapshot;
  if (artifact.age > HOMEPAGE_UNKNOWN_DOWNGRADE_GUARD_SECONDS) {
    return false;
  }

  const computedShowsUnknownLead =
    computed.overall_status === 'unknown' || computed.banner.status === 'unknown';
  if (!computedShowsUnknownLead) {
    return false;
  }

  const artifactShowsKnownLead =
    snapshot.overall_status !== 'unknown' || snapshot.banner.status !== 'unknown';
  if (!artifactShowsKnownLead) {
    return false;
  }

  return (
    computed.summary.unknown > snapshot.summary.unknown ||
    computed.overall_status !== snapshot.overall_status ||
    computed.banner.status !== snapshot.banner.status
  );
}

function homepageHistoryPreviewsFromSnapshot(
  snapshot:
    | Pick<PublicHomepageResponse, 'resolved_incident_preview' | 'maintenance_history_preview'>
    | null
    | undefined,
) {
  return {
    resolvedIncidentPreview: snapshot?.resolved_incident_preview ?? null,
    maintenanceHistoryPreview: snapshot?.maintenance_history_preview ?? null,
  };
}

function hasReusableHomepageHistoryPreviews(
  previews: ReturnType<typeof homepageHistoryPreviewsFromSnapshot>,
): boolean {
  return previews.resolvedIncidentPreview !== null || previews.maintenanceHistoryPreview !== null;
}

async function readStaleStatusSnapshot(
  db: D1Database,
  now: number,
  maxStaleSeconds: number,
): Promise<{ data: unknown; age: number } | null> {
  try {
    const row = await db
      .prepare(
        `
        SELECT generated_at, body_json
        FROM public_snapshots
        WHERE key = 'status'
      `,
      )
      .first<PublicStatusSnapshotRow>();

    if (!row) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > maxStaleSeconds) return null;

    const parsed = safeJsonParse(row.body_json);
    if (parsed === null) return null;

    return { data: parsed, age };
  } catch {
    return null;
  }
}

export const publicRoutes = new Hono<{ Bindings: Env }>();

// Cache public endpoints at the edge to improve performance on slow networks.
publicRoutes.use('*', cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 30 }));

const latencyRangeSchema = z.enum(['24h']);
const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);
const uptimeOverviewRangeSchema = z.enum(['30d', '90d']);

type Interval = { start: number; end: number };

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return [];

  const merged: Interval[] = [{ start: first.start, end: first.end }];

  for (const cur of sorted.slice(1)) {
    if (!cur) continue;

    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: cur.start, end: cur.end });
      continue;
    }

    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }

    merged.push({ start: cur.start, end: cur.end });
  }

  return merged;
}

function sumIntervals(intervals: Interval[]): number {
  return intervals.reduce((acc, it) => acc + Math.max(0, it.end - it.start), 0);
}

function overlapSeconds(a: Interval[], b: Interval[]): number {
  let i = 0;
  let j = 0;
  let acc = 0;

  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;

    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) {
      acc += end - start;
    }

    if (x.end <= y.end) {
      i++;
    } else {
      j++;
    }
  }

  return acc;
}

function ensureInterval(interval: Interval): Interval | null {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) return null;
  if (interval.end <= interval.start) return null;
  return interval;
}

function pushMergedInterval(intervals: Interval[], next: Interval): void {
  const last = intervals[intervals.length - 1];
  if (last && next.start <= last.end) {
    last.end = Math.max(last.end, next.end);
    return;
  }
  intervals.push({ start: next.start, end: next.end });
}

function buildUnknownIntervals(
  rangeStart: number,
  rangeEnd: number,
  intervalSec: number,
  checks: Array<{ checked_at: number; status: string }>,
): Interval[] {
  if (rangeEnd <= rangeStart) return [];
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return [{ start: rangeStart, end: rangeEnd }];
  }

  let lastCheck: { checked_at: number; status: string } | null = null;
  let cursor = rangeStart;

  const unknown: Interval[] = [];

  function addUnknown(from: number, to: number) {
    const it = ensureInterval({ start: from, end: to });
    if (!it) return;
    pushMergedInterval(unknown, it);
  }

  function processSegment(segStart: number, segEnd: number) {
    if (segEnd <= segStart) return;

    if (!lastCheck) {
      addUnknown(segStart, segEnd);
      return;
    }

    const validUntil = lastCheck.checked_at + intervalSec * 2;

    // Allow up to 2x interval jitter before treating gaps as UNKNOWN (matches status-page stale threshold).
    if (segStart >= validUntil) {
      addUnknown(segStart, segEnd);
      return;
    }

    const coveredEnd = Math.min(segEnd, validUntil);
    if (lastCheck.status === 'unknown') {
      addUnknown(segStart, coveredEnd);
    }

    if (coveredEnd < segEnd) {
      addUnknown(coveredEnd, segEnd);
    }
  }

  for (const check of checks) {
    if (check.checked_at < rangeStart) {
      lastCheck = check;
      continue;
    }
    if (check.checked_at >= rangeEnd) {
      break;
    }

    processSegment(cursor, check.checked_at);
    lastCheck = check;
    cursor = check.checked_at;
  }

  processSegment(cursor, rangeEnd);
  return unknown;
}

function rangeToSeconds(
  range: z.infer<typeof uptimeRangeSchema> | z.infer<typeof latencyRangeSchema>,
): number {
  switch (range) {
    case '24h':
      return 24 * 60 * 60;
    case '7d':
      return 7 * 24 * 60 * 60;
    case '30d':
      return 30 * 24 * 60 * 60;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx] ?? null;
}

type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  status: string | null;
  message: string;
  created_at: number;
};

type IncidentMonitorLinkRow = {
  incident_id: number;
  monitor_id: number;
};

function toIncidentStatus(
  value: string | null,
): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  switch (value) {
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'resolved':
      return value;
    default:
      return 'investigating';
  }
}

function toIncidentImpact(value: string | null): 'none' | 'minor' | 'major' | 'critical' {
  switch (value) {
    case 'none':
    case 'minor':
    case 'major':
    case 'critical':
      return value;
    default:
      return 'minor';
  }
}

function incidentUpdateRowToApi(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status === null ? null : toIncidentStatus(row.status),
    message: row.message,
    created_at: row.created_at,
  };
}

function incidentRowToApi(
  row: IncidentRow,
  updates: IncidentUpdateRow[] = [],
  monitorIds: number[] = [],
) {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    monitor_ids: monitorIds,
    updates: updates.map(incidentUpdateRowToApi),
  };
}

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT id, incident_id, status, message, created_at
      FROM incident_updates
      WHERE incident_id IN (${placeholders})
      ORDER BY incident_id, created_at, id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<IncidentUpdateRow>();
    for (const r of results ?? []) {
      const existing = byIncident.get(r.incident_id) ?? [];
      existing.push(r);
      byIncident.set(r.incident_id, existing);
    }
  }

  return byIncident;
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT incident_id, monitor_id
      FROM incident_monitors
      WHERE incident_id IN (${placeholders})
      ORDER BY incident_id, monitor_id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<IncidentMonitorLinkRow>();
    for (const r of results ?? []) {
      const existing = byIncident.get(r.incident_id) ?? [];
      existing.push(r.monitor_id);
      byIncident.set(r.incident_id, existing);
    }
  }

  return byIncident;
}

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(windowIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const sql = `
      SELECT maintenance_window_id, monitor_id
      FROM maintenance_window_monitors
      WHERE maintenance_window_id IN (${placeholders})
      ORDER BY maintenance_window_id, monitor_id
    `;

    const { results } = await db
      .prepare(sql)
      .bind(...ids)
      .all<MaintenanceWindowMonitorLinkRow>();
    for (const r of results ?? []) {
      const existing = byWindow.get(r.maintenance_window_id) ?? [];
      existing.push(r.monitor_id);
      byWindow.set(r.maintenance_window_id, existing);
    }
  }

  return byWindow;
}

publicRoutes.get('/status', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);

  if (includeHiddenMonitors) {
    const payload = await computePublicStatusPayload(c.env.DB, now, {
      includeHiddenMonitors: true,
    });
    return applyPrivateNoStore(c.json(payload));
  }

  const snapshot = await readStatusSnapshot(c.env.DB, now);
  if (snapshot) {
    const res = c.json(snapshot.data);
    applyStatusCacheHeaders(res, snapshot.age);

    // If we're close to the freshness boundary, trigger a background refresh.
    if (snapshot.age >= 30) {
      c.executionCtx.waitUntil(
        (async () => {
          const refreshedAt = Math.floor(Date.now() / 1000);
          const payload = await computePublicStatusPayload(c.env.DB, refreshedAt);
          await writeStatusSnapshot(c.env.DB, refreshedAt, payload);
        })().catch((err) => {
          console.warn('public snapshot: refresh failed', err);
        }),
      );
    }

    return res;
  }
  try {
    const payload = await computePublicStatusPayload(c.env.DB, now);
    const res = c.json(payload);
    applyStatusCacheHeaders(res, 0);

    c.executionCtx.waitUntil(
      writeStatusSnapshot(c.env.DB, now, payload).catch((err) => {
        console.warn('public snapshot: write failed', err);
      }),
    );

    return res;
  } catch (err) {
    console.warn('public status: compute failed', err);

    // Last-resort fallback for weak networks / D1 hiccups: serve a stale snapshot (bounded)
    // instead of failing the entire status page.
    const stale = await readStaleStatusSnapshot(c.env.DB, now, 10 * 60);
    if (stale) {
      const res = c.json(toSnapshotPayload(stale.data));
      applyStatusCacheHeaders(res, Math.min(60, stale.age));
      return res;
    }

    throw err;
  }
});

publicRoutes.get('/homepage', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await readHomepageSnapshotJson(c.env.DB, now);
  if (snapshot) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(snapshot.bodyJson);
    applyHomepageCacheHeaders(res, snapshot.age);
    return res;
  }

  const artifactSnapshotPromise = readStaleHomepageSnapshotArtifact(c.env.DB, now);
  const historyPreviewsPromise = artifactSnapshotPromise
    .then((artifactSnapshot) => {
      if (artifactSnapshot && artifactSnapshot.age <= 60) {
        const artifactPreviews = homepageHistoryPreviewsFromSnapshot(artifactSnapshot.data.snapshot);
        if (hasReusableHomepageHistoryPreviews(artifactPreviews)) {
          return artifactPreviews;
        }
      }

      return readHomepageHistoryPreviews(c.env.DB, now);
    })
    .catch((err) => {
      console.warn('public homepage: preview read failed', err);
      return {
        resolvedIncidentPreview: null,
        maintenanceHistoryPreview: null,
      };
    });
  const statusSnapshot = await readStatusSnapshot(c.env.DB, now);
  if (statusSnapshot) {
    const payload = homepageFromStatusPayload(
      statusSnapshot.data,
      await historyPreviewsPromise,
    );
    const res = c.json(payload);
    applyHomepageCacheHeaders(res, statusSnapshot.age);
    return res;
  }

  try {
    const statusPayload = await computePublicStatusPayload(c.env.DB, now);
    const artifactSnapshot = await artifactSnapshotPromise;
    if (
      artifactSnapshot &&
      shouldPreferRecentHomepageArtifact({ artifact: artifactSnapshot, computed: statusPayload })
    ) {
      const res = c.json(artifactSnapshot.data.snapshot);
      applyHomepageCacheHeaders(res, Math.min(60, artifactSnapshot.age));
      return res;
    }

    const payload = homepageFromStatusPayload(statusPayload, await historyPreviewsPromise);
    const res = c.json(payload);
    applyHomepageCacheHeaders(res, 0);

    c.executionCtx.waitUntil(
      writeStatusSnapshot(c.env.DB, now, statusPayload).catch((err) => {
        console.warn('public snapshot: write failed', err);
      }),
    );

    return res;
  } catch (err) {
    console.warn('public homepage: secondary status compute failed', err);

    const staleHomepage = await readStaleHomepageSnapshot(c.env.DB, now);
    if (staleHomepage) {
      const res = c.json(staleHomepage.data);
      applyHomepageCacheHeaders(res, Math.min(60, staleHomepage.age));
      return res;
    }

    const staleStatus = await readStaleStatusSnapshot(c.env.DB, now, 10 * 60);
    if (staleStatus) {
      const payload = homepageFromStatusPayload(
        toSnapshotPayload(staleStatus.data),
        await historyPreviewsPromise.catch(() => ({
          resolvedIncidentPreview: null,
          maintenanceHistoryPreview: null,
        })),
      );
      const res = c.json(payload);
      applyHomepageCacheHeaders(res, Math.min(60, staleStatus.age));
      return res;
    }

    const staleArtifact = await artifactSnapshotPromise;
    if (staleArtifact) {
      const res = c.json(staleArtifact.data.snapshot);
      applyHomepageCacheHeaders(res, Math.min(60, staleArtifact.age));
      return res;
    }

    throw new AppError(503, 'UNAVAILABLE', 'Homepage unavailable');
  }
});

publicRoutes.get('/homepage-artifact', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await readHomepageSnapshotArtifactJson(c.env.DB, now);
  if (snapshot) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(snapshot.bodyJson);
    applyHomepageCacheHeaders(res, snapshot.age);
    return res;
  }

  const stale = await readStaleHomepageSnapshotArtifactJson(c.env.DB, now);
  if (stale) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(stale.bodyJson);
    applyHomepageCacheHeaders(res, Math.min(60, stale.age));
    return res;
  }

  throw new AppError(503, 'UNAVAILABLE', 'Homepage artifact unavailable');
});

publicRoutes.get('/incidents', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));
  const resolvedOnly =
    z.coerce
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .default(0)
      .parse(c.req.query('resolved_only')) === 1;
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);

  let active: IncidentRow[] = [];
  let remaining = limit;

  if (!resolvedOnly) {
    const { results: activeRows } = await c.env.DB.prepare(
      `
        SELECT id, title, status, impact, message, started_at, resolved_at
        FROM incidents
        WHERE status != 'resolved'
          AND ${incidentVisibilitySql}
        ORDER BY started_at DESC, id DESC
        LIMIT ?1
      `,
    )
      .bind(limit)
      .all<IncidentRow>();

    active = activeRows ?? [];
    remaining = Math.max(0, limit - active.length);
  }

  let resolved: IncidentRow[] = [];
  let next_cursor: number | null = null;

  if (remaining > 0) {
    const baseSql = `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status = 'resolved'
        AND ${incidentVisibilitySql}
    `;

    const resolvedLimitPlusOne = remaining + 1;
    const batchLimit = Math.max(50, resolvedLimitPlusOne);
    let seekCursor = cursor;
    const collected: IncidentRow[] = [];

    while (collected.length < resolvedLimitPlusOne) {
      const { results: resolvedRows } = seekCursor
        ? await c.env.DB.prepare(
            `
              ${baseSql}
                AND id < ?2
              ORDER BY id DESC
              LIMIT ?1
            `,
          )
            .bind(batchLimit, seekCursor)
            .all<IncidentRow>()
        : await c.env.DB.prepare(
            `
              ${baseSql}
              ORDER BY id DESC
              LIMIT ?1
            `,
          )
            .bind(batchLimit)
            .all<IncidentRow>();

      const allResolved = resolvedRows ?? [];
      if (allResolved.length === 0) break;

      collected.push(...allResolved);

      const lastRow = allResolved[allResolved.length - 1];
      if (allResolved.length < batchLimit || !lastRow) break;
      seekCursor = lastRow.id;
    }

    resolved = collected.slice(0, remaining);
    next_cursor = collected.length > remaining ? (resolved[resolved.length - 1]?.id ?? null) : null;
  }

  const combined = [...active, ...resolved];
  const updatesByIncidentId = await listIncidentUpdatesByIncidentId(
    c.env.DB,
    combined.map((r) => r.id),
  );
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    c.env.DB,
    combined.map((r) => r.id),
  );

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(c.env.DB, [...monitorIdsByIncidentId.values()].flat());

  return withVisibilityAwareCaching(
    c.json({
      incidents: combined.flatMap((r) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(r.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );

        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }

        return [incidentRowToApi(r, updatesByIncidentId.get(r.id) ?? [], filteredMonitorIds)];
      }),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicRoutes.get('/maintenance-windows', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const now = Math.floor(Date.now() / 1000);
  const maintenanceVisibilitySql = maintenanceWindowStatusPageVisibilityPredicate(
    includeHiddenMonitors,
  );
  const baseSql = `
    SELECT id, title, message, starts_at, ends_at, created_at
    FROM maintenance_windows
    WHERE ends_at <= ?1
      AND ${maintenanceVisibilitySql}
  `;
  const limitPlusOne = limit + 1;
  const batchLimit = Math.max(50, limitPlusOne);
  let seekCursor = cursor;
  const collected: MaintenanceWindowRow[] = [];

  while (collected.length < limitPlusOne) {
    const { results: windowRows } = seekCursor
      ? await c.env.DB.prepare(
          `
            ${baseSql}
              AND id < ?3
            ORDER BY id DESC
            LIMIT ?2
          `,
        )
          .bind(now, batchLimit, seekCursor)
          .all<MaintenanceWindowRow>()
      : await c.env.DB.prepare(
          `
            ${baseSql}
            ORDER BY id DESC
            LIMIT ?2
          `,
        )
          .bind(now, batchLimit)
          .all<MaintenanceWindowRow>();

    const allWindows = windowRows ?? [];
    if (allWindows.length === 0) break;

    collected.push(...allWindows);

    const lastRow = allWindows[allWindows.length - 1];
    if (allWindows.length < batchLimit || !lastRow) break;
    seekCursor = lastRow.id;
  }

  const windows = collected.slice(0, limit);
  const next_cursor = collected.length > limit ? (windows[windows.length - 1]?.id ?? null) : null;

  const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
    c.env.DB,
    windows.map((w) => w.id),
  );

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(c.env.DB, [...monitorIdsByWindowId.values()].flat());

  return withVisibilityAwareCaching(
    c.json({
      maintenance_windows: windows.flatMap((w) => {
        const originalMonitorIds = monitorIdsByWindowId.get(w.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );

        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }

        return [maintenanceWindowRowToApi(w, filteredMonitorIds)];
      }),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicRoutes.get('/monitors/:id/day-context', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const dayStartAt = z.coerce.number().int().nonnegative().parse(c.req.query('day_start_at'));
  const dayEndAt = dayStartAt + 86400;

  const monitor = await c.env.DB.prepare(
    `
      SELECT id
      FROM monitors
      WHERE id = ?1 AND is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
    `,
  )
    .bind(id)
    .first<{ id: number }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const { results: maintenanceRows } = await c.env.DB.prepare(
    `
      SELECT mw.id, mw.title, mw.message, mw.starts_at, mw.ends_at, mw.created_at
      FROM maintenance_windows mw
      JOIN maintenance_window_monitors mwm ON mwm.maintenance_window_id = mw.id
      WHERE mwm.monitor_id = ?1
        AND mw.starts_at < ?3
        AND mw.ends_at > ?2
      ORDER BY mw.starts_at ASC, mw.id ASC
      LIMIT 50
    `,
  )
    .bind(id, dayStartAt, dayEndAt)
    .all<MaintenanceWindowRow>();

  const maintenance = maintenanceRows ?? [];
  const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
    c.env.DB,
    maintenance.map((w) => w.id),
  );

  const { results: incidentRows } = await c.env.DB.prepare(
    `
      SELECT i.id, i.title, i.status, i.impact, i.message, i.started_at, i.resolved_at
      FROM incidents i
      JOIN incident_monitors im ON im.incident_id = i.id
      WHERE im.monitor_id = ?1
        AND i.started_at < ?3
        AND (i.resolved_at IS NULL OR i.resolved_at > ?2)
      ORDER BY i.started_at ASC, i.id ASC
      LIMIT 50
    `,
  )
    .bind(id, dayStartAt, dayEndAt)
    .all<IncidentRow>();

  const incidents = incidentRows ?? [];
  const updatesByIncidentId = await listIncidentUpdatesByIncidentId(
    c.env.DB,
    incidents.map((r) => r.id),
  );
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    c.env.DB,
    incidents.map((r) => r.id),
  );

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(
        c.env.DB,
        [...monitorIdsByWindowId.values(), ...monitorIdsByIncidentId.values()].flat(),
      );

  return withVisibilityAwareCaching(
    c.json({
      day_start_at: dayStartAt,
      day_end_at: dayEndAt,
      maintenance_windows: maintenance.flatMap((w) => {
        const originalMonitorIds = monitorIdsByWindowId.get(w.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );

        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }

        return [maintenanceWindowRowToApi(w, filteredMonitorIds)];
      }),
      incidents: incidents.flatMap((r) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(r.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );

        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }

        return [incidentRowToApi(r, updatesByIncidentId.get(r.id) ?? [], filteredMonitorIds)];
      }),
    }),
    includeHiddenMonitors,
  );
});

publicRoutes.get('/monitors/:id/latency', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = latencyRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name
      FROM monitors
      WHERE id = ?1 AND is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
    `,
  )
    .bind(id)
    .first<{ id: number; name: string }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = rangeEnd - rangeToSeconds(range);

  const { results } = await c.env.DB.prepare(
    `
      SELECT checked_at, status, latency_ms
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at <= ?3
      ORDER BY checked_at
    `,
  )
    .bind(id, rangeStart, rangeEnd)
    .all<{ checked_at: number; status: string; latency_ms: number | null }>();

  const points = (results ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
    latency_ms: r.latency_ms,
  }));

  const upLatencies = points
    .filter((p) => p.status === 'up' && typeof p.latency_ms === 'number')
    .map((p) => p.latency_ms as number);

  const avg_latency_ms =
    upLatencies.length === 0
      ? null
      : Math.round(upLatencies.reduce((acc, v) => acc + v, 0) / upLatencies.length);

  return withVisibilityAwareCaching(
    c.json({
      monitor: { id: monitor.id, name: monitor.name },
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      avg_latency_ms,
      p95_latency_ms: p95(upLatencies),
      points,
    }),
    includeHiddenMonitors,
  );
});

type OutageRow = { started_at: number; ended_at: number | null };

function resolveUptimeRangeStart(
  rangeStart: number,
  rangeEnd: number,
  monitorCreatedAt: number,
  lastCheckedAt: number | null,
  checks: Array<{ checked_at: number; status: string }>,
): number | null {
  const monitorRangeStart = Math.max(rangeStart, monitorCreatedAt);
  if (rangeEnd <= monitorRangeStart) return null;

  // Start from the first observed probe only for monitors created inside this window.
  if (monitorRangeStart > rangeStart) {
    const firstCheckAt = checks.find(
      (check) => check.checked_at >= monitorRangeStart && check.checked_at < rangeEnd,
    )?.checked_at;
    if (firstCheckAt !== undefined) {
      return firstCheckAt;
    }

    return lastCheckedAt === null ? null : monitorRangeStart;
  }

  return monitorRangeStart;
}

publicRoutes.get('/monitors/:id/uptime', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = uptimeRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT m.id, m.name, m.interval_sec, m.created_at, s.last_checked_at
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.id = ?1 AND m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
    `,
  )
    .bind(id)
    .first<{
      id: number;
      name: string;
      interval_sec: number;
      created_at: number;
      last_checked_at: number | null;
    }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const requestedRangeStart = rangeEnd - rangeToSeconds(range);
  const rangeStart = Math.max(requestedRangeStart, monitor.created_at);

  const checksStart = rangeStart - monitor.interval_sec * 2;
  const { results: checkRows } = await c.env.DB.prepare(
    `
      SELECT checked_at, status
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at < ?3
      ORDER BY checked_at
    `,
  )
    .bind(id, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const checks = (checkRows ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
  }));
  const effectiveRangeStart = resolveUptimeRangeStart(
    rangeStart,
    rangeEnd,
    monitor.created_at,
    monitor.last_checked_at,
    checks,
  );
  const rangeStartAt = effectiveRangeStart ?? rangeStart;
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    return withVisibilityAwareCaching(
      c.json({
        monitor: { id: monitor.id, name: monitor.name },
        range,
        range_start_at: rangeStartAt,
        range_end_at: rangeEnd,
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: 0,
      }),
      includeHiddenMonitors,
    );
  }

  const total_sec = rangeEnd - effectiveRangeStart;
  const { results: outageRows } = await c.env.DB.prepare(
    `
      SELECT started_at, ended_at
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
      ORDER BY started_at
    `,
  )
    .bind(id, rangeEnd, effectiveRangeStart)
    .all<OutageRow>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((r) => {
        const start = Math.max(r.started_at, effectiveRangeStart);
        const end = Math.min(r.ended_at ?? rangeEnd, rangeEnd);
        return { start, end };
      })
      .filter((it) => it.end > it.start),
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksForUnknown =
    effectiveRangeStart > rangeStart
      ? checks.filter((check) => check.checked_at >= effectiveRangeStart)
      : checks;
  const unknownIntervals = buildUnknownIntervals(
    effectiveRangeStart,
    rangeEnd,
    monitor.interval_sec,
    checksForUnknown,
  );

  // Unknown time is treated as "unavailable" per Application.md; exclude overlap with downtime to avoid double counting.
  const unknown_sec = Math.max(
    0,
    sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
  );

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);
  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  return withVisibilityAwareCaching(
    c.json({
      monitor: { id: monitor.id, name: monitor.name },
      range,
      range_start_at: rangeStartAt,
      range_end_at: rangeEnd,
      total_sec,
      downtime_sec,
      unknown_sec,
      uptime_sec,
      uptime_pct,
    }),
    includeHiddenMonitors,
  );
});

async function computePartialUptimeTotals(
  db: D1Database,
  monitorId: number,
  intervalSec: number,
  createdAt: number,
  lastCheckedAt: number | null,
  rangeStart: number,
  rangeEnd: number,
): Promise<{ total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }> {
  if (rangeEnd <= rangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const checksStart = rangeStart - intervalSec * 2;
  const { results: checkRows } = await db
    .prepare(
      `
      SELECT checked_at, status
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at < ?3
      ORDER BY checked_at
    `,
    )
    .bind(monitorId, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const checks = (checkRows ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
  }));
  const effectiveRangeStart = resolveUptimeRangeStart(
    rangeStart,
    rangeEnd,
    createdAt,
    lastCheckedAt,
    checks,
  );
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const total_sec = rangeEnd - effectiveRangeStart;
  const { results: outageRows } = await db
    .prepare(
      `
      SELECT started_at, ended_at
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
      ORDER BY started_at
    `,
    )
    .bind(monitorId, rangeEnd, effectiveRangeStart)
    .all<{ started_at: number; ended_at: number | null }>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((r) => ({
        start: Math.max(r.started_at, effectiveRangeStart),
        end: Math.min(r.ended_at ?? rangeEnd, rangeEnd),
      }))
      .filter((it) => it.end > it.start),
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksForUnknown =
    effectiveRangeStart > rangeStart
      ? checks.filter((check) => check.checked_at >= effectiveRangeStart)
      : checks;
  const unknownIntervals = buildUnknownIntervals(
    effectiveRangeStart,
    rangeEnd,
    intervalSec,
    checksForUnknown,
  );
  const unknown_sec = Math.max(
    0,
    sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
  );

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);

  return { total_sec, downtime_sec, unknown_sec, uptime_sec };
}

publicRoutes.get('/analytics/uptime', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const range = uptimeOverviewRangeSchema.optional().default('30d').parse(c.req.query('range'));

  const now = Math.floor(Date.now() / 1000);
  // Include the current (partial) day so overview matches other uptime calculations.
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeEndFullDays = Math.floor(rangeEnd / 86400) * 86400;
  const rangeStart = rangeEnd - (range === '30d' ? 30 * 86400 : 90 * 86400);

  const { results: monitorRows } = await c.env.DB.prepare(
    `
      SELECT m.id, m.name, m.type, m.interval_sec, m.created_at, s.last_checked_at
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      ORDER BY m.id
    `,
  ).all<{
    id: number;
    name: string;
    type: string;
    interval_sec: number;
    created_at: number;
    last_checked_at: number | null;
  }>();

  const monitors = monitorRows ?? [];

  const { results: sumRows } = await c.env.DB.prepare(
    `
      SELECT
        monitor_id,
        SUM(total_sec) AS total_sec,
        SUM(downtime_sec) AS downtime_sec,
        SUM(unknown_sec) AS unknown_sec,
        SUM(uptime_sec) AS uptime_sec
      FROM monitor_daily_rollups
      WHERE day_start_at >= ?1 AND day_start_at < ?2
      GROUP BY monitor_id
    `,
  )
    .bind(rangeStart, rangeEndFullDays)
    .all<{
      monitor_id: number;
      total_sec: number;
      downtime_sec: number;
      unknown_sec: number;
      uptime_sec: number;
    }>();

  const byMonitorId = new Map<
    number,
    { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }
  >();
  for (const r of sumRows ?? []) {
    byMonitorId.set(r.monitor_id, {
      total_sec: r.total_sec ?? 0,
      downtime_sec: r.downtime_sec ?? 0,
      unknown_sec: r.unknown_sec ?? 0,
      uptime_sec: r.uptime_sec ?? 0,
    });
  }

  let total_sec = 0;
  let downtime_sec = 0;
  let unknown_sec = 0;
  let uptime_sec = 0;

  const partialStart = rangeEndFullDays;
  const partialEnd = rangeEnd;

  const out = await Promise.all(
    monitors.map(async (m) => {
      const rollupTotals = byMonitorId.get(m.id) ?? {
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
      };

      const partialTotals =
        partialEnd > partialStart
          ? await computePartialUptimeTotals(
              c.env.DB,
              m.id,
              m.interval_sec,
              m.created_at,
              m.last_checked_at,
              partialStart,
              partialEnd,
            )
          : { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };

      const totals = {
        total_sec: rollupTotals.total_sec + partialTotals.total_sec,
        downtime_sec: rollupTotals.downtime_sec + partialTotals.downtime_sec,
        unknown_sec: rollupTotals.unknown_sec + partialTotals.unknown_sec,
        uptime_sec: rollupTotals.uptime_sec + partialTotals.uptime_sec,
      };

      total_sec += totals.total_sec;
      downtime_sec += totals.downtime_sec;
      unknown_sec += totals.unknown_sec;
      uptime_sec += totals.uptime_sec;

      const uptime_pct = totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100;

      return {
        id: m.id,
        name: m.name,
        type: m.type,
        total_sec: totals.total_sec,
        downtime_sec: totals.downtime_sec,
        unknown_sec: totals.unknown_sec,
        uptime_sec: totals.uptime_sec,
        uptime_pct,
      };
    }),
  );

  const overall_uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  return withVisibilityAwareCaching(
    c.json({
      generated_at: now,
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      overall: {
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
        uptime_pct: overall_uptime_pct,
      },
      monitors: out,
    }),
    includeHiddenMonitors,
  );
});

publicRoutes.get('/monitors/:id/outages', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = z.enum(['30d']).optional().default('30d').parse(c.req.query('range'));
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(200)
    .parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, created_at
      FROM monitors
      WHERE id = ?1 AND is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
    `,
  )
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  // Include the current (partial) day so outages from today show up on the status page.
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = Math.max(rangeEnd - 30 * 86400, monitor.created_at);

  const sqlBase = `
    SELECT id, started_at, ended_at, initial_error, last_error
    FROM outages
    WHERE monitor_id = ?1
      AND started_at < ?2
      AND (ended_at IS NULL OR ended_at > ?3)
  `;

  const take = limit + 1;
  const { results } = cursor
    ? await c.env.DB.prepare(
        `
            ${sqlBase}
              AND id < ?4
            ORDER BY id DESC
            LIMIT ?5
          `,
      )
        .bind(id, rangeEnd, rangeStart, cursor, take)
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>()
    : await c.env.DB.prepare(
        `
            ${sqlBase}
            ORDER BY id DESC
            LIMIT ?4
          `,
      )
        .bind(id, rangeEnd, rangeStart, take)
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return withVisibilityAwareCaching(
    c.json({
      range: range as '30d',
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      outages: page.map((r) => ({
        id: r.id,
        monitor_id: id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        initial_error: r.initial_error,
        last_error: r.last_error,
      })),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});
publicRoutes.get('/health', async (c) => {
  // Minimal DB touch to verify the Worker can connect to D1.
  const db = getDb(c.env);
  await db.select({ id: monitors.id }).from(monitors).limit(1).all();
  return c.json({ ok: true });
});
