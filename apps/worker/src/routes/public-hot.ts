import { Hono } from 'hono';

import type { Env } from '../env';
import { hasValidAdminTokenRequest } from '../middleware/auth';
import { AppError, handleError, handleNotFound } from '../middleware/errors';
import { Trace, applyTraceToResponse, resolveTraceOptions } from '../observability/trace';

function appendVaryHeader(res: Response, value: string): void {
  const next = value.trim();
  if (!next) return;
  const existing = res.headers.get('Vary');
  if (!existing) {
    res.headers.set('Vary', next);
    return;
  }
  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  if (parts.includes(next.toLowerCase())) return;
  res.headers.set('Vary', `${existing}, ${next}`);
}

function applyCorsHeaders(
  res: Response,
  origin: string | null,
  allowedMethods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
): Response {
  const out = new Response(res.body, res);
  appendVaryHeader(out, 'Origin');
  if (origin) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', allowedMethods);
    out.headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  }
  return out;
}

function applyPrivateNoStore(res: Response): Response {
  appendAuthorizationVary(res);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function hasAuthorizationHeaderValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
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

function rewritePublicRequest(req: Request): Request {
  const url = new URL(req.url);
  const prefix = '/api/v1/public';
  if (url.pathname === prefix) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  return new Request(url.toString(), req);
}

export const publicHotRoutes = new Hono<{ Bindings: Env }>();
publicHotRoutes.onError(handleError);
publicHotRoutes.notFound(handleNotFound);

publicHotRoutes.get('/homepage', async (c) => {
  const { applyHomepageCacheHeaders, readHomepageSnapshotJson } =
    await import('../snapshots/public-homepage-read');
  const now = Math.floor(Date.now() / 1000);
  const trace = new Trace(
    resolveTraceOptions({
      header: (name) => c.req.header(name),
      env: c.env as unknown as Record<string, unknown>,
    }),
  );
  trace.setLabel('route', 'public/homepage');

  const snapshot = await trace.timeAsync('homepage_snapshot_read', () =>
    readHomepageSnapshotJson(c.env.DB, now),
  );
  if (snapshot) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(snapshot.bodyJson);
    applyHomepageCacheHeaders(res, Math.min(60, snapshot.age));
    trace.setLabel('path', 'snapshot');
    trace.setLabel('age', snapshot.age);
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  const { publicRoutes } = await import('./public');
  const res = await publicRoutes.fetch(rewritePublicRequest(c.req.raw), c.env, c.executionCtx);
  return applyCorsHeaders(res, c.req.header('Origin') ?? null, 'GET, OPTIONS');
});

publicHotRoutes.get('/homepage-artifact', async (c) => {
  const {
    applyHomepageCacheHeaders,
    readHomepageSnapshotArtifactJson,
    readStaleHomepageSnapshotArtifactJson,
  } = await import('../snapshots/public-homepage-read');
  const now = Math.floor(Date.now() / 1000);
  const trace = new Trace(
    resolveTraceOptions({
      header: (name) => c.req.header(name),
      env: c.env as unknown as Record<string, unknown>,
    }),
  );
  trace.setLabel('route', 'public/homepage-artifact');

  const snapshot = await trace.timeAsync('homepage_artifact_read', () =>
    readHomepageSnapshotArtifactJson(c.env.DB, now),
  );
  if (snapshot) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(snapshot.bodyJson);
    applyHomepageCacheHeaders(res, snapshot.age);
    trace.setLabel('path', 'snapshot');
    trace.setLabel('age', snapshot.age);
    trace.setLabel('bytes', snapshot.bodyJson.length);
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  const stale = await trace.timeAsync('homepage_artifact_stale_read', () =>
    readStaleHomepageSnapshotArtifactJson(c.env.DB, now),
  );
  if (stale) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = c.body(stale.bodyJson);
    applyHomepageCacheHeaders(res, Math.min(60, stale.age));
    trace.setLabel('path', 'stale');
    trace.setLabel('age', stale.age);
    trace.setLabel('bytes', stale.bodyJson.length);
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  throw new AppError(503, 'UNAVAILABLE', 'Homepage artifact unavailable');
});

publicHotRoutes.get('/status', async (c) => {
  const { applyStatusCacheHeaders, readStatusSnapshotJson, readStaleStatusSnapshotJson } =
    await import('../snapshots/public-status-read');
  const now = Math.floor(Date.now() / 1000);
  const includeHiddenMonitors = hasValidAdminTokenRequest(c);
  const hasAuthorizationHeader = hasAuthorizationHeaderValue(c.req.header('Authorization'));
  const shouldBypassSharedCaching = hasAuthorizationHeader && !includeHiddenMonitors;
  const trace = new Trace(
    resolveTraceOptions({
      header: (name) => c.req.header(name),
      env: c.env as unknown as Record<string, unknown>,
    }),
  );
  trace.setLabel('route', 'public/status');
  trace.setLabel('hidden', includeHiddenMonitors);
  trace.setLabel('auth_present', hasAuthorizationHeader);

  if (includeHiddenMonitors) {
    const { computePublicStatusPayload } = await import('../public/status');
    const payload = await trace.timeAsync('status_compute', () =>
      computePublicStatusPayload(c.env.DB, now, { includeHiddenMonitors: true }),
    );
    const res = applyPrivateNoStore(c.json(payload));
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  const snapshot = await trace.timeAsync('status_snapshot_read', () =>
    readStatusSnapshotJson(c.env.DB, now),
  );
  if (snapshot) {
    c.header('Content-Type', 'application/json; charset=utf-8');
    const res = shouldBypassSharedCaching
      ? applyPrivateNoStore(c.body(snapshot.bodyJson))
      : appendAuthorizationVary(c.body(snapshot.bodyJson));
    if (!shouldBypassSharedCaching) {
      applyStatusCacheHeaders(res, snapshot.age);
    }
    trace.setLabel('path', shouldBypassSharedCaching ? 'snapshot_private' : 'snapshot');
    trace.setLabel('age', snapshot.age);
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  }

  try {
    const [{ computePublicStatusPayload }, { writeStatusSnapshot }] = await Promise.all([
      import('../public/status'),
      import('../snapshots/public-status'),
    ]);

    const payload = await trace.timeAsync('status_compute', () =>
      computePublicStatusPayload(c.env.DB, now),
    );
    const res = shouldBypassSharedCaching
      ? applyPrivateNoStore(c.json(payload))
      : appendAuthorizationVary(c.json(payload));
    if (!shouldBypassSharedCaching) {
      applyStatusCacheHeaders(res, 0);
    }

    c.executionCtx.waitUntil(
      writeStatusSnapshot(c.env.DB, now, payload).catch((err) => {
        console.warn('public snapshot: write failed', err);
      }),
    );

    trace.setLabel('path', shouldBypassSharedCaching ? 'compute_private' : 'compute');
    trace.finish('total');
    applyTraceToResponse({ res, trace, prefix: 'w' });
    return res;
  } catch (err) {
    console.warn('public status: compute failed', err);

    // Last-resort fallback: serve a bounded stale snapshot instead of failing entirely.
    const stale = await trace.timeAsync('status_snapshot_stale_read', () =>
      readStaleStatusSnapshotJson(c.env.DB, now, 10 * 60),
    );
    if (stale) {
      c.header('Content-Type', 'application/json; charset=utf-8');
      const res = shouldBypassSharedCaching
        ? applyPrivateNoStore(c.body(stale.bodyJson))
        : appendAuthorizationVary(c.body(stale.bodyJson));
      if (!shouldBypassSharedCaching) {
        applyStatusCacheHeaders(res, Math.min(60, stale.age));
      }
      trace.setLabel('path', shouldBypassSharedCaching ? 'stale_private' : 'stale');
      trace.setLabel('age', stale.age);
      trace.finish('total');
      applyTraceToResponse({ res, trace, prefix: 'w' });
      return res;
    }

    throw err;
  }
});

// Everything else stays behind a lazy import, keeping cold-start CPU focused on the
// homepage/status hot paths.
publicHotRoutes.all('*', async (c) => {
  const { publicRoutes } = await import('./public');
  const res = await publicRoutes.fetch(rewritePublicRequest(c.req.raw), c.env, c.executionCtx);
  return applyCorsHeaders(res, c.req.header('Origin') ?? null, 'GET, OPTIONS');
});
