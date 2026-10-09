import { Hono } from 'hono';

import { utcDayStart } from '../analytics/uptime';
import { AppError, handleError, handleNotFound } from '../middleware/errors';
import type { Env } from '../env';
import { hasValidAdminTokenRequest } from '../middleware/auth';
import { cachePublic } from '../middleware/cache-public';
import { Trace, applyTraceToResponse, resolveTraceOptions } from '../observability/trace';
import {
  analyticsOverviewSnapshotSupportsMonitors,
  readPublicAnalyticsOverviewSnapshot,
  refreshPublicAnalyticsOverviewSnapshotIfNeeded,
  totalsFromAnalyticsOverviewEntry,
  toPublicAnalyticsOverviewEntryMap,
} from '../public/analytics-overview';
import {
  materializeMonitorRuntimeTotals,
  readPublicMonitorRuntimeTotalsSnapshot,
  toMonitorRuntimeTotalsEntryMap,
} from '../public/monitor-runtime';
import { monitorVisibilityPredicate } from '../public/visibility';

const ACTIVE_MONITOR_CACHE_TTL_MS = 30_000;

type AnalyticsMonitorRow = {
  id: number;
  name: string;
  type: string;
  created_at: number;
};
type ActiveMonitorCacheEntry = {
  expiresAtMs: number;
  rows: AnalyticsMonitorRow[];
};

function isAuthorizedStatusAdminRequest(c: {
  env: Pick<Env, 'ADMIN_TOKEN'>;
  req: { header(name: string): string | undefined };
}): boolean {
  return hasValidAdminTokenRequest(c);
}

function appendAuthorizationVary(res: Response): Response {
  const vary = res.headers.get('Vary');
  if (!vary) {
    res.headers.set('Vary', 'Authorization');
  } else if (!vary.split(',').some((part) => part.trim().toLowerCase() === 'authorization')) {
    res.headers.set('Vary', `${vary}, Authorization`);
  }

  return res;
}

function applyPrivateNoStore(res: Response): Response {
  appendAuthorizationVary(res);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function withVisibilityAwareCaching(res: Response, includeHiddenMonitors: boolean): Response {
  return includeHiddenMonitors ? applyPrivateNoStore(res) : appendAuthorizationVary(res);
}

function createTrace(c: { env: Env; req: { header(name: string): string | undefined } }): Trace {
  return new Trace(
    resolveTraceOptions({
      header: (name) => c.req.header(name),
      env: c.env as unknown as Record<string, unknown>,
    }),
  );
}

function normalizeAnalyticsUptimeCacheKeyUrl(url: URL): void {
  const range = url.searchParams.get('range');
  if (range !== null && range !== '30d' && range !== '90d') {
    return;
  }

  url.search = '';
  if (range === '90d') {
    url.searchParams.set('range', '90d');
  }
}

function parseAnalyticsUptimeRange(raw: string | undefined): '30d' | '90d' {
  if (raw === undefined || raw === '30d') {
    return '30d';
  }
  if (raw === '90d') {
    return '90d';
  }
  throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid range');
}

const statementCacheByDb = new WeakMap<D1Database, Map<string, D1PreparedStatement>>();
const activeMonitorRowsCacheByDb = new WeakMap<
  D1Database,
  {
    hidden: ActiveMonitorCacheEntry | null;
    visible: ActiveMonitorCacheEntry | null;
  }
>();

function prepareStatement(db: D1Database, sql: string): D1PreparedStatement {
  let statements = statementCacheByDb.get(db);
  if (!statements) {
    statements = new Map<string, D1PreparedStatement>();
    statementCacheByDb.set(db, statements);
  }

  const cached = statements.get(sql);
  if (cached) {
    return cached;
  }

  const statement = db.prepare(sql);
  statements.set(sql, statement);
  return statement;
}

function getActiveMonitorRowsCache(db: D1Database): {
  hidden: ActiveMonitorCacheEntry | null;
  visible: ActiveMonitorCacheEntry | null;
} {
  const cached = activeMonitorRowsCacheByDb.get(db);
  if (cached) {
    return cached;
  }

  const next = {
    hidden: null,
    visible: null,
  };
  activeMonitorRowsCacheByDb.set(db, next);
  return next;
}

async function readActiveMonitorRows(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<AnalyticsMonitorRow[]> {
  const cacheBucket = getActiveMonitorRowsCache(db);
  const cacheKey = includeHiddenMonitors ? 'hidden' : 'visible';
  const cached = cacheBucket[cacheKey];
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.rows;
  }

  const { results } = await prepareStatement(
    db,
    `
      SELECT m.id, m.name, m.type, m.created_at
      FROM monitors m
      WHERE m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      ORDER BY m.id
    `,
  ).all<AnalyticsMonitorRow>();

  const rows = (results ?? []) as AnalyticsMonitorRow[];
  cacheBucket[cacheKey] = {
    expiresAtMs: nowMs + ACTIVE_MONITOR_CACHE_TTL_MS,
    rows,
  };
  return rows;
}

export async function handlePublicAnalyticsUptime(c: {
  env: Env;
  req: {
    query(name: string): string | undefined;
    raw: Request;
    header(name: string): string | undefined;
  };
  executionCtx: ExecutionContext;
  json: (data: unknown) => Response;
}): Promise<Response> {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const range = parseAnalyticsUptimeRange(c.req.query('range'));
  const trace = createTrace(c);
  trace.setLabel('route', 'public/analytics-uptime');
  trace.setLabel('range', range);

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeEndFullDays = utcDayStart(rangeEnd);
  const rangeStart = rangeEnd - (range === '30d' ? 30 * 86400 : 90 * 86400);

  const monitorRowsPromise = trace.timeAsync(
    'active_monitors',
    async () => await readActiveMonitorRows(c.env.DB, includeHiddenMonitors),
  );
  const historySnapshotPromise = trace.timeAsync(
    'history_snapshot',
    async () => await readPublicAnalyticsOverviewSnapshot(c.env.DB, rangeEndFullDays),
  );
  const [monitorRows, historySnapshot] = await Promise.all([
    monitorRowsPromise,
    historySnapshotPromise,
  ]);

  const monitors = monitorRows ?? [];
  if (
    monitors.length > 0 &&
    (!historySnapshot || !analyticsOverviewSnapshotSupportsMonitors(historySnapshot, monitors))
  ) {
    c.executionCtx.waitUntil(
      refreshPublicAnalyticsOverviewSnapshotIfNeeded({
        db: c.env.DB,
        now,
        fullDayEndAt: rangeEndFullDays,
        force: historySnapshot !== null,
      }).catch((err) => {
        console.warn('analytics overview: background refresh failed', err);
      }),
    );

    trace.setLabel('path', 'live-fallback');
    trace.setLabel('refresh', 'queued');
    const { publicRoutes } = await import('./public');
    return publicRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }

  const historyByMonitorId = historySnapshot
    ? toPublicAnalyticsOverviewEntryMap(historySnapshot)
    : null;
  const monitorIds = monitors.map((monitor) => monitor.id);
  const runtimeSnapshot =
    monitorIds.length > 0
      ? await trace.timeAsync(
          'runtime_snapshot',
          async () => await readPublicMonitorRuntimeTotalsSnapshot(c.env.DB, rangeEnd),
        )
      : null;
  const runtimeByMonitorId = runtimeSnapshot
    ? toMonitorRuntimeTotalsEntryMap(runtimeSnapshot)
    : null;
  const missingRuntimeHistoricalEntry =
    monitors.length > 0 &&
    (!runtimeByMonitorId ||
      monitors.some(
        (monitor) => !runtimeByMonitorId.has(monitor.id) && monitor.created_at < rangeEndFullDays,
      ));
  if (monitors.length > 0 && (historySnapshot === null || missingRuntimeHistoricalEntry)) {
    trace.setLabel('path', 'live-fallback');
    const { publicRoutes } = await import('./public');
    return publicRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }

  let total_sec = 0;
  let downtime_sec = 0;
  let unknown_sec = 0;
  let uptime_sec = 0;

  const partialStart = rangeEndFullDays;
  const partialEnd = rangeEnd;
  const output = monitors.map((monitor) => {
    const historicalTotals = totalsFromAnalyticsOverviewEntry(
      historyByMonitorId?.get(monitor.id),
      range,
    );
    const runtimeEntry = runtimeByMonitorId?.get(monitor.id);
    const partialTotals =
      partialEnd > partialStart && runtimeEntry
        ? materializeMonitorRuntimeTotals(runtimeEntry, partialEnd)
        : { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0, uptime_pct: null };

    const totals = {
      total_sec: historicalTotals.total_sec + partialTotals.total_sec,
      downtime_sec: historicalTotals.downtime_sec + partialTotals.downtime_sec,
      unknown_sec: historicalTotals.unknown_sec + partialTotals.unknown_sec,
      uptime_sec: historicalTotals.uptime_sec + partialTotals.uptime_sec,
    };

    total_sec += totals.total_sec;
    downtime_sec += totals.downtime_sec;
    unknown_sec += totals.unknown_sec;
    uptime_sec += totals.uptime_sec;

    return {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      total_sec: totals.total_sec,
      downtime_sec: totals.downtime_sec,
      unknown_sec: totals.unknown_sec,
      uptime_sec: totals.uptime_sec,
      uptime_pct: totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100,
    };
  });

  const res = withVisibilityAwareCaching(
    new Response(
      JSON.stringify({
        generated_at: now,
        range,
        range_start_at: rangeStart,
        range_end_at: rangeEnd,
        overall: {
          total_sec,
          downtime_sec,
          unknown_sec,
          uptime_sec,
          uptime_pct: total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100,
        },
        monitors: output,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    ),
    includeHiddenMonitors,
  );
  trace.setLabel('path', 'snapshot');
  trace.finish('total');
  applyTraceToResponse({ res, trace, prefix: 'w' });
  return res;
}

export function registerPublicUiAnalyticsRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/analytics/uptime', async (c) => await handlePublicAnalyticsUptime(c));
}

export const publicUiAnalyticsRoutes = new Hono<{ Bindings: Env }>();
publicUiAnalyticsRoutes.onError(handleError);
publicUiAnalyticsRoutes.notFound(handleNotFound);

publicUiAnalyticsRoutes.use(
  '*',
  cachePublic({
    cacheName: 'uptimer-public',
    maxAgeSeconds: 30,
    normalizeCacheKeyUrl: normalizeAnalyticsUptimeCacheKeyUrl,
  }),
);

registerPublicUiAnalyticsRoutes(publicUiAnalyticsRoutes);
