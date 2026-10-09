import type { Env } from './env';
import { AppError } from './middleware/errors';
import type { Trace } from './observability/trace';

const CORS_ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_ALLOW_HEADERS = 'Authorization,Content-Type';
const TRACE_TOKEN_HEADER = 'X-Uptimer-Trace-Token';
const API_PATH_MAX_DECODE_PASSES = 32;

function normalizeApiPathname(pathname: string): string {
  const collapsed = pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!collapsed) return '/';
  if (collapsed.length === 1) return collapsed;
  return collapsed.replace(/\/+$/, '') || '/';
}

function decodeApiPathname(pathname: string): string {
  let decoded = pathname;
  const maxPasses = Math.max(
    1,
    Math.min(API_PATH_MAX_DECODE_PASSES, Math.ceil(pathname.length / 3) + 1),
  );
  for (let index = 0; index < maxPasses; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function stripAsciiControlChars(value: string): string {
  let next = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }
    next += value[index];
  }
  return next;
}

function canonicalizeApiPathname(pathname: string): string {
  const normalizedPathname = normalizeApiPathname(
    stripAsciiControlChars(decodeApiPathname(pathname)),
  );
  try {
    return normalizeApiPathname(new URL(normalizedPathname, 'https://uptimer.invalid').pathname);
  } catch {
    return normalizedPathname;
  }
}

function resolveVersionedApiPathname(pathname: string): {
  normalizedPathname: string;
  versionedPathname: string;
} | null {
  const normalizedPathname = canonicalizeApiPathname(pathname);
  if (!(normalizedPathname === '/api' || normalizedPathname.startsWith('/api/'))) {
    return null;
  }

  return {
    normalizedPathname,
    versionedPathname:
      normalizedPathname === '/api/v1' || normalizedPathname.startsWith('/api/v1/')
        ? normalizedPathname
        : `/api/v1${normalizedPathname.slice('/api'.length)}`,
  };
}

function normalizeApiRequestPath(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = canonicalizeApiPathname(url.pathname);
  if (normalizedPathname === url.pathname) {
    return request;
  }

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function appendVaryHeader(headers: Headers, value: string): void {
  const next = value.trim();
  if (!next) return;
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', next);
    return;
  }
  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  if (parts.includes(next.toLowerCase())) return;
  headers.set('Vary', `${existing}, ${next}`);
}

function applyCorsHeaders(
  res: Response,
  origin: string | null,
  allowedMethods = CORS_ALLOW_METHODS,
): Response {
  const out = new Response(res.body, res);
  appendVaryHeader(out.headers, 'Origin');
  if (origin) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', allowedMethods);
    out.headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  }
  return out;
}

function corsPreflight(origin: string | null, allowedMethods = CORS_ALLOW_METHODS): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set('Vary', 'Origin');
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
  }
  res.headers.set('Access-Control-Allow-Methods', allowedMethods);
  res.headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  return res;
}

function isZodErrorLike(err: unknown): err is { message: string } {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  return (
    record['name'] === 'ZodError' &&
    typeof record['message'] === 'string' &&
    Array.isArray(record['issues'])
  );
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function allowedMethodsForApiPath(pathname: string): string {
  return isGetOnlyPublicApiPath(pathname) ? 'GET, OPTIONS' : CORS_ALLOW_METHODS;
}

function methodNotAllowed(allowedMethods: string): Response {
  const res = jsonError(405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed');
  res.headers.set('Allow', allowedMethods);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function readBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function hasAuthorizationHeaderValue(req: Request): boolean {
  const value = req.headers.get('Authorization');
  return typeof value === 'string' && value.trim().length > 0;
}

function hasTraceTokenHeaderValue(req: Request): boolean {
  const value = req.headers.get(TRACE_TOKEN_HEADER);
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidAdminToken(req: Request, env: Pick<Env, 'ADMIN_TOKEN'>): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  return readBearerToken(req.headers.get('authorization')) === expected;
}

function appendAuthorizationVary(res: Response): Response {
  appendVaryHeader(res.headers, 'Authorization');
  return res;
}

function applyPrivateNoStore(res: Response, req?: Request): Response {
  if (!req || hasAuthorizationHeaderValue(req)) {
    appendAuthorizationVary(res);
  }
  if (req && hasTraceTokenHeaderValue(req)) {
    appendVaryHeader(res.headers, TRACE_TOKEN_HEADER);
  }
  res.headers.set('Cache-Control', 'private, no-store');
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
  url.pathname = normalizeApiPathname(url.pathname);
  return new Request(url.toString(), req);
}

function isVersionedPublicApiPath(pathname: string): boolean {
  const normalizedPathname = canonicalHotPublicPathname(pathname);
  return (
    normalizedPathname === '/api/v1/public' || normalizedPathname.startsWith('/api/v1/public/')
  );
}

function shouldBypassPublicSharedCaching(req: Request, env: Pick<Env, 'ADMIN_TOKEN'>): boolean {
  return (
    hasTraceTokenHeaderValue(req) ||
    (hasAuthorizationHeaderValue(req) && !hasValidAdminToken(req, env))
  );
}

function isGetOnlyPublicApiPath(pathname: string): boolean {
  const normalizedPathname = canonicalHotPublicPathname(pathname);
  return (
    normalizedPathname === '/api/v1/public' || normalizedPathname.startsWith('/api/v1/public/')
  );
}

function isPublicUiPath(url: URL): boolean {
  const pathname = canonicalHotPublicPathname(url.pathname);
  if (pathname === '/api/v1/public/status') return true;
  if (pathname === '/api/v1/public/incidents') return true;
  if (pathname === '/api/v1/public/maintenance-windows') return true;
  if (pathname === '/api/v1/public/analytics/uptime') return true;
  if (/^\/api\/v1\/public\/monitors\/\d+\/day-context$/.test(pathname)) return true;
  if (/^\/api\/v1\/public\/monitors\/\d+\/outages$/.test(pathname)) return true;
  if (/^\/api\/v1\/public\/monitors\/\d+\/uptime$/.test(pathname)) return true;
  return (
    /^\/api\/v1\/public\/monitors\/\d+\/latency$/.test(pathname) && url.searchParams.has('format')
  );
}

function canonicalHotPublicPathname(pathname: string): string {
  return canonicalizeApiPathname(pathname);
}

const HOT_PUBLIC_CACHE_NAME = 'uptimer-public-hot-v1';
const HOT_PUBLIC_ORIGIN_CACHE_KEY_PARAM = '__uptimer_origin_cache_key';
const HOT_PUBLIC_STALE_CACHE_KEY_PARAM = '__uptimer_stale_cache_key';
const HOT_PUBLIC_CACHED_AT_HEADER = 'X-Uptimer-Hot-Cached-At';
const HOT_PUBLIC_ORIGINAL_CACHE_CONTROL_HEADER = 'X-Uptimer-Hot-Original-Cache-Control';
const HOT_PUBLIC_STALE_MAX_AGE_SECONDS = 60;
const HOT_PUBLIC_STALE_STORAGE_TTL_SECONDS = 120;
const PUBLIC_STATIC_STALE_MAX_SECONDS = 10 * 60;
const HOT_PUBLIC_CACHE_PATHS = new Set([
  '/api/v1/public/homepage',
  '/api/v1/public/homepage-artifact',
  '/api/v1/public/status',
]);
const hotPublicCacheByStorage = new WeakMap<object, Promise<Cache>>();

function isHotPublicCachePath(pathname: string): boolean {
  return HOT_PUBLIC_CACHE_PATHS.has(canonicalHotPublicPathname(pathname));
}

function openHotPublicCache(): Promise<Cache> | null {
  const storage = globalThis.caches as unknown as
    | (object & { open(name: string): Promise<Cache> })
    | undefined;
  if (!storage?.open) {
    return null;
  }

  const cached = hotPublicCacheByStorage.get(storage);
  if (cached) {
    return cached;
  }

  const opened = storage.open(HOT_PUBLIC_CACHE_NAME).catch((err) => {
    hotPublicCacheByStorage.delete(storage);
    throw err;
  });
  hotPublicCacheByStorage.set(storage, opened);
  return opened;
}

function buildHotPublicCacheKey(
  req: Request,
  origin: string | null,
  variant: 'fresh' | 'stale' = 'fresh',
): Request {
  const url = new URL(req.url);
  if (origin) {
    url.searchParams.set(HOT_PUBLIC_ORIGIN_CACHE_KEY_PARAM, origin);
  }
  if (variant === 'stale') {
    url.searchParams.set(HOT_PUBLIC_STALE_CACHE_KEY_PARAM, '1');
  }
  return new Request(url.toString(), { method: 'GET' });
}

function stripHotPublicCacheInternalHeaders(res: Response): Response {
  if (
    !res.headers.has(HOT_PUBLIC_CACHED_AT_HEADER) &&
    !res.headers.has(HOT_PUBLIC_ORIGINAL_CACHE_CONTROL_HEADER)
  ) {
    return res;
  }
  const out = new Response(res.body, res);
  const originalCacheControl = out.headers.get(HOT_PUBLIC_ORIGINAL_CACHE_CONTROL_HEADER);
  out.headers.delete(HOT_PUBLIC_CACHED_AT_HEADER);
  out.headers.delete(HOT_PUBLIC_ORIGINAL_CACHE_CONTROL_HEADER);
  if (originalCacheControl) {
    out.headers.set('Cache-Control', originalCacheControl);
  }
  return out;
}

function toHotPublicStaleResponse(res: Response): Response | null {
  const cachedAtRaw = res.headers.get(HOT_PUBLIC_CACHED_AT_HEADER);
  const cachedAt = cachedAtRaw ? Number.parseInt(cachedAtRaw, 10) : NaN;
  if (!Number.isFinite(cachedAt)) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - cachedAt > HOT_PUBLIC_STALE_MAX_AGE_SECONDS) {
    return null;
  }

  const out = new Response(res.body, res);
  out.headers.delete(HOT_PUBLIC_CACHED_AT_HEADER);
  out.headers.set(
    'Cache-Control',
    'public, max-age=0, stale-while-revalidate=30, stale-if-error=30',
  );
  return out;
}

async function matchHotPublicCache(req: Request, origin: string | null): Promise<Response | null> {
  const cachePromise = openHotPublicCache();
  if (!cachePromise) {
    return null;
  }

  try {
    const cache = await cachePromise;
    const fresh = await cache.match(buildHotPublicCacheKey(req, origin));
    if (fresh) {
      return stripHotPublicCacheInternalHeaders(fresh);
    }

    const stale = await cache.match(buildHotPublicCacheKey(req, origin, 'stale'));
    return stale ? toHotPublicStaleResponse(stale) : null;
  } catch (err) {
    console.warn('public hot cache: match failed', err);
    return null;
  }
}

function putHotPublicCache(
  ctx: ExecutionContext,
  req: Request,
  origin: string | null,
  res: Response,
): void {
  if (res.status !== 200) {
    return;
  }
  const cacheControl = res.headers.get('Cache-Control') ?? '';
  if (/(?:^|,\s*)(?:private|no-(?:store|cache))(?:\s*(?:=|,|$))/i.test(cacheControl)) {
    return;
  }

  const cachePromise = openHotPublicCache();
  if (!cachePromise) {
    return;
  }

  const freshCacheKey = buildHotPublicCacheKey(req, origin);
  const staleCacheKey = buildHotPublicCacheKey(req, origin, 'stale');
  const freshResponse = new Response(res.clone().body, res);
  freshResponse.headers.set(HOT_PUBLIC_ORIGINAL_CACHE_CONTROL_HEADER, cacheControl);
  freshResponse.headers.set('Cache-Control', `public, max-age=${HOT_PUBLIC_STALE_MAX_AGE_SECONDS}`);
  const staleResponse = new Response(res.clone().body, res);
  staleResponse.headers.set(HOT_PUBLIC_CACHED_AT_HEADER, String(Math.floor(Date.now() / 1000)));
  staleResponse.headers.set(
    'Cache-Control',
    `public, max-age=${HOT_PUBLIC_STALE_STORAGE_TTL_SECONDS}`,
  );

  ctx.waitUntil(
    cachePromise
      .then(async (cache) => {
        await Promise.all([
          cache.put(freshCacheKey, freshResponse),
          cache.put(staleCacheKey, staleResponse),
        ]);
      })
      .catch((err) => {
        console.warn('public hot cache: put failed', err);
      }),
  );
}

function normalizeTruthyHeader(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

async function resolveTrace(req: Request, env: Env): Promise<Trace | null> {
  if (!normalizeTruthyHeader(req.headers.get('X-Uptimer-Trace'))) return null;
  const mod = await import('./observability/trace');
  const trace = new mod.Trace(
    mod.resolveTraceOptions({
      header: (name) => req.headers.get(name) ?? undefined,
      env: env as unknown as Record<string, unknown>,
    }),
  );
  return trace as Trace;
}

async function applyTrace(res: Response, trace: Trace | null, prefix: string): Promise<void> {
  if (!trace) return;
  const mod = await import('./observability/trace');
  mod.applyTraceToResponse({ res, trace, prefix });
}

async function handlePublicHomepageArtifact(req: Request, env: Env): Promise<Response> {
  const {
    applyHomepageCacheHeaders,
    readHomepageSnapshotArtifactJson,
    readStaleHomepageSnapshotArtifactJson,
  } = await import('./snapshots/public-homepage-read');
  const now = Math.floor(Date.now() / 1000);
  const trace = await resolveTrace(req, env);
  if (trace) {
    trace.setLabel('route', 'public/homepage-artifact');
  }

  const snapshot = trace
    ? await trace.timeAsync('homepage_artifact_read', () =>
        readHomepageSnapshotArtifactJson(env.DB, now),
      )
    : await readHomepageSnapshotArtifactJson(env.DB, now);
  if (snapshot) {
    const res = new Response(snapshot.bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    applyHomepageCacheHeaders(res, snapshot.age);
    if (trace) {
      trace.setLabel('path', 'snapshot');
      trace.setLabel('age', snapshot.age);
      trace.setLabel('bytes', snapshot.bodyJson.length);
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  const stale = trace
    ? await trace.timeAsync('homepage_artifact_stale_read', () =>
        readStaleHomepageSnapshotArtifactJson(env.DB, now),
      )
    : await readStaleHomepageSnapshotArtifactJson(env.DB, now);
  if (stale) {
    const res = new Response(stale.bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    applyHomepageCacheHeaders(res, Math.min(60, stale.age));
    if (trace) {
      trace.setLabel('path', 'stale');
      trace.setLabel('age', stale.age);
      trace.setLabel('bytes', stale.bodyJson.length);
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  throw new AppError(503, 'UNAVAILABLE', 'Homepage artifact unavailable');
}

async function handlePublicHomepage(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { applyHomepageCacheHeaders, readHomepageSnapshotJson, readHomepageSnapshotJsonAnyAge } =
    await import('./snapshots/public-homepage-read');
  const now = Math.floor(Date.now() / 1000);
  const trace = await resolveTrace(req, env);
  if (trace) {
    trace.setLabel('route', 'public/homepage');
  }

  const snapshot = trace
    ? await trace.timeAsync('homepage_snapshot_read', () => readHomepageSnapshotJson(env.DB, now))
    : await readHomepageSnapshotJson(env.DB, now);
  if (snapshot) {
    const res = new Response(snapshot.bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    applyHomepageCacheHeaders(res, Math.min(60, snapshot.age));
    if (trace) {
      trace.setLabel('path', 'snapshot');
      trace.setLabel('age', snapshot.age);
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  const stale = trace
    ? await trace.timeAsync('homepage_snapshot_stale_read', () =>
        readHomepageSnapshotJsonAnyAge(env.DB, now, PUBLIC_STATIC_STALE_MAX_SECONDS),
      )
    : await readHomepageSnapshotJsonAnyAge(env.DB, now, PUBLIC_STATIC_STALE_MAX_SECONDS);
  if (stale) {
    const res = new Response(stale.bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    applyHomepageCacheHeaders(res, Math.min(60, stale.age));
    if (trace) {
      trace.setLabel('path', 'stale_snapshot');
      trace.setLabel('age', stale.age);
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  const { publicRoutes } = await import('./routes/public');
  return publicRoutes.fetch(rewritePublicRequest(req), env, ctx);
}

async function handlePublicStatus(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { applyStatusCacheHeaders, readStaleStatusSnapshotJson } =
    await import('./snapshots/public-status-read');
  const now = Math.floor(Date.now() / 1000);
  const includeHiddenMonitors = hasValidAdminToken(req, env);
  const hasAuthorizationHeader = hasAuthorizationHeaderValue(req);
  const hasTraceTokenHeader = hasTraceTokenHeaderValue(req);
  const shouldBypassSharedCaching =
    hasTraceTokenHeader || (hasAuthorizationHeader && !includeHiddenMonitors);
  const trace = await resolveTrace(req, env);
  if (trace) {
    trace.setLabel('route', 'public/status');
    trace.setLabel('hidden', includeHiddenMonitors);
    trace.setLabel('auth_present', hasAuthorizationHeader);
    trace.setLabel('trace_token_present', hasTraceTokenHeader);
  }

  if (includeHiddenMonitors) {
    const { computePublicStatusPayload } = await import('./public/status');
    const payload = trace
      ? await trace.timeAsync('status_compute', () =>
          computePublicStatusPayload(env.DB, now, { includeHiddenMonitors: true }),
        )
      : await computePublicStatusPayload(env.DB, now, { includeHiddenMonitors: true });

    const res = applyPrivateNoStore(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      req,
    );
    if (trace) {
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  const snapshot = trace
    ? await trace.timeAsync('status_snapshot_read', () =>
        readStaleStatusSnapshotJson(env.DB, now, PUBLIC_STATIC_STALE_MAX_SECONDS),
      )
    : await readStaleStatusSnapshotJson(env.DB, now, PUBLIC_STATIC_STALE_MAX_SECONDS);
  if (snapshot) {
    const res = shouldBypassSharedCaching
      ? applyPrivateNoStore(
          new Response(snapshot.bodyJson, {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }),
          req,
        )
      : appendAuthorizationVary(
          new Response(snapshot.bodyJson, {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }),
        );
    if (!shouldBypassSharedCaching) {
      applyStatusCacheHeaders(res, Math.min(60, snapshot.age));
    }
    if (trace) {
      const snapshotPath = snapshot.age > 60 ? 'stale_snapshot' : 'snapshot';
      trace.setLabel('path', shouldBypassSharedCaching ? `${snapshotPath}_private` : snapshotPath);
      trace.setLabel('age', snapshot.age);
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  }

  try {
    const [{ computePublicStatusPayload }, { writeStatusSnapshot }] = await Promise.all([
      import('./public/status'),
      import('./snapshots/public-status'),
    ]);
    const payload = trace
      ? await trace.timeAsync('status_compute', () => computePublicStatusPayload(env.DB, now))
      : await computePublicStatusPayload(env.DB, now);

    const res = shouldBypassSharedCaching
      ? applyPrivateNoStore(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }),
          req,
        )
      : appendAuthorizationVary(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }),
        );
    if (!shouldBypassSharedCaching) {
      applyStatusCacheHeaders(res, 0);
    }

    ctx.waitUntil(
      writeStatusSnapshot(env.DB, now, payload).catch((err) => {
        console.warn('public snapshot: write failed', err);
      }),
    );

    if (trace) {
      trace.setLabel('path', shouldBypassSharedCaching ? 'compute_private' : 'compute');
      trace.finish('total');
      await applyTrace(res, trace, 'w');
    }
    return res;
  } catch (err) {
    console.warn('public status: compute failed', err);

    const stale = trace
      ? await trace.timeAsync('status_snapshot_stale_read', () =>
          readStaleStatusSnapshotJson(env.DB, now, 10 * 60),
        )
      : await readStaleStatusSnapshotJson(env.DB, now, 10 * 60);
    if (stale) {
      const res = shouldBypassSharedCaching
        ? applyPrivateNoStore(
            new Response(stale.bodyJson, {
              status: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }),
            req,
          )
        : appendAuthorizationVary(
            new Response(stale.bodyJson, {
              status: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }),
          );
      if (!shouldBypassSharedCaching) {
        applyStatusCacheHeaders(res, Math.min(60, stale.age));
      }
      if (trace) {
        trace.setLabel('path', shouldBypassSharedCaching ? 'stale_private' : 'stale');
        trace.setLabel('age', stale.age);
        trace.finish('total');
        await applyTrace(res, trace, 'w');
      }
      return res;
    }

    throw err;
  }
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const normalizedRequest = normalizeApiRequestPath(request);
  const url = new URL(normalizedRequest.url);
  const origin = normalizedRequest.headers.get('Origin');
  const hotPathname = canonicalHotPublicPathname(url.pathname);
  const resolvedApiPath = resolveVersionedApiPathname(originalUrl.pathname);
  const fastMethodPathname = resolvedApiPath?.versionedPathname ?? url.pathname;
  const fastGetOnlyPath = isGetOnlyPublicApiPath(fastMethodPathname);
  const corsAllowedMethods = allowedMethodsForApiPath(fastMethodPathname);
  const bypassPublicSharedCache = shouldBypassPublicSharedCaching(normalizedRequest, env);
  const shouldPrivatizePublicError =
    bypassPublicSharedCache && isVersionedPublicApiPath(fastMethodPathname);
  const canUseHotPublicCache =
    normalizedRequest.method === 'GET' &&
    !bypassPublicSharedCache &&
    isHotPublicCachePath(hotPathname);

  if (canUseHotPublicCache) {
    const cached = await matchHotPublicCache(normalizedRequest, origin);
    if (cached) {
      return cached;
    }
  }

  if (url.pathname === '/') {
    return new Response('ok');
  }

  if (resolvedApiPath) {
    if (normalizedRequest.method === 'OPTIONS') {
      const res = corsPreflight(origin, corsAllowedMethods);
      return shouldPrivatizePublicError ? applyPrivateNoStore(res, normalizedRequest) : res;
    }

    if (fastGetOnlyPath && normalizedRequest.method !== 'GET') {
      const res = applyCorsHeaders(methodNotAllowed('GET, OPTIONS'), origin, 'GET, OPTIONS');
      return shouldPrivatizePublicError ? applyPrivateNoStore(res, normalizedRequest) : res;
    }

    // Redirect legacy `/api/*` paths to the versioned API after normalizing repeated slashes.
    if (resolvedApiPath.versionedPathname !== resolvedApiPath.normalizedPathname) {
      const next = new URL(normalizedRequest.url);
      next.pathname = resolvedApiPath.versionedPathname;
      const res = Response.redirect(next.toString(), 308);
      const response = applyCorsHeaders(res, origin, corsAllowedMethods);
      return shouldPrivatizePublicError
        ? applyPrivateNoStore(response, normalizedRequest)
        : response;
    }
  }

  try {
    if (hotPathname === '/api/v1/public/homepage-artifact') {
      const routeRes = await handlePublicHomepageArtifact(normalizedRequest, env);
      const res = bypassPublicSharedCache
        ? applyPrivateNoStore(routeRes, normalizedRequest)
        : routeRes;
      const response = applyCorsHeaders(res, origin, 'GET, OPTIONS');
      if (canUseHotPublicCache) {
        putHotPublicCache(ctx, normalizedRequest, origin, response);
      }
      return response;
    }
    if (hotPathname === '/api/v1/public/homepage') {
      const routeRes = await handlePublicHomepage(normalizedRequest, env, ctx);
      const res = bypassPublicSharedCache
        ? applyPrivateNoStore(routeRes, normalizedRequest)
        : routeRes;
      const response = applyCorsHeaders(res, origin, 'GET, OPTIONS');
      if (canUseHotPublicCache) {
        putHotPublicCache(ctx, normalizedRequest, origin, response);
      }
      return response;
    }
    if (hotPathname === '/api/v1/public/status') {
      const res = await handlePublicStatus(normalizedRequest, env, ctx);
      const response = applyCorsHeaders(res, origin, 'GET, OPTIONS');
      if (canUseHotPublicCache) {
        putHotPublicCache(ctx, normalizedRequest, origin, response);
      }
      return response;
    }
    if (hotPathname === '/api/v1/public/analytics/uptime') {
      const { publicUiAnalyticsRoutes } = await import('./routes/public-ui-analytics');
      const routeRes = await publicUiAnalyticsRoutes.fetch(
        rewritePublicRequest(normalizedRequest),
        env,
        ctx,
      );
      const res = shouldBypassPublicSharedCaching(normalizedRequest, env)
        ? applyPrivateNoStore(routeRes, normalizedRequest)
        : routeRes;
      return applyCorsHeaders(res, origin, 'GET, OPTIONS');
    }
    if (normalizedRequest.method === 'GET' && isPublicUiPath(url)) {
      const { publicUiRoutes } = await import('./routes/public-ui');
      const routeRes = await publicUiRoutes.fetch(
        rewritePublicRequest(normalizedRequest),
        env,
        ctx,
      );
      const res = shouldBypassPublicSharedCaching(normalizedRequest, env)
        ? applyPrivateNoStore(routeRes, normalizedRequest)
        : routeRes;
      return applyCorsHeaders(res, origin, 'GET, OPTIONS');
    }
  } catch (err) {
    if (err instanceof AppError) {
      const res = jsonError(err.status, err.code, err.message);
      return applyCorsHeaders(
        shouldPrivatizePublicError ? applyPrivateNoStore(res, normalizedRequest) : res,
        origin,
        corsAllowedMethods,
      );
    }
    if (isZodErrorLike(err)) {
      const res = jsonError(400, 'INVALID_ARGUMENT', err.message);
      return applyCorsHeaders(
        shouldPrivatizePublicError ? applyPrivateNoStore(res, normalizedRequest) : res,
        origin,
        corsAllowedMethods,
      );
    }
    console.error(err);
    const res = jsonError(500, 'INTERNAL', 'Internal Server Error');
    return applyCorsHeaders(
      shouldPrivatizePublicError ? applyPrivateNoStore(res, normalizedRequest) : res,
      origin,
      corsAllowedMethods,
    );
  }

  // Everything else stays behind a lazy import to keep cold-start CPU focused on the hot paths.
  const { fetch } = await import('./hono-app');
  const res = await fetch(normalizedRequest, env, ctx);
  if (bypassPublicSharedCache && isVersionedPublicApiPath(url.pathname)) {
    return applyPrivateNoStore(res, normalizedRequest);
  }
  return res;
}
