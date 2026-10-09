import type { MiddlewareHandler } from 'hono';

import {
  Trace,
  TRACE_HEADER,
  TRACE_ID_HEADER,
  applyTraceToResponse,
  resolveTraceOptions,
} from '../observability/trace';

function hasAuthorizationHeader(req: { header?(name: string): string | undefined }): boolean {
  const value = req.header?.('Authorization');
  return typeof value === 'string' && value.trim().length > 0;
}

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

function buildCacheKey(
  url: string,
  origin: string | undefined,
  normalizeCacheKeyUrl?: (url: URL) => void,
): Request {
  const cacheUrl = new URL(url);
  normalizeCacheKeyUrl?.(cacheUrl);
  if (origin) {
    cacheUrl.searchParams.set('__uptimer_origin_cache_key', origin);
  }
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

const openedCachesByStorage = new WeakMap<object, Map<string, Promise<Cache>>>();

function openNamedCache(name: string): Promise<Cache> {
  const storage = globalThis.caches as unknown as object & { open(name: string): Promise<Cache> };
  let byName = openedCachesByStorage.get(storage);
  if (!byName) {
    byName = new Map<string, Promise<Cache>>();
    openedCachesByStorage.set(storage, byName);
  }

  const cached = byName.get(name);
  if (cached) {
    return cached;
  }

  const opened = storage.open(name).catch((error) => {
    byName?.delete(name);
    throw error;
  });
  byName.set(name, opened);
  return opened;
}

// Cache public (unauthenticated) GET responses at the edge.
// This reduces D1 read pressure and greatly improves TTFB on slow networks.
//
// IMPORTANT: Authorization-bearing requests bypass the shared cache entirely because
// public endpoints can return admin-only payloads when a valid bearer token is present.
// If a handler already set Cache-Control, we respect it (do not override).
// This allows endpoints like `/public/status` to precisely control freshness (<= 60s).
export function cachePublic(opts: {
  cacheName: string;
  maxAgeSeconds: number;
  skipPathnames?: readonly string[];
  normalizeCacheKeyUrl?: (url: URL) => void;
}): MiddlewareHandler {
  return async (c, next) => {
    const traceOptions =
      c.req.header(TRACE_HEADER) !== undefined
        ? resolveTraceOptions({
            header: (name) => c.req.header(name),
            env: c.env as unknown as Record<string, unknown>,
          })
        : { enabled: false, id: '', mode: null };
    const trace = traceOptions.enabled ? new Trace(traceOptions) : null;

    if (c.req.method !== 'GET' || hasAuthorizationHeader(c.req)) {
      await next();
      return;
    }

    const skipPathnames = opts.skipPathnames ?? [];
    if (skipPathnames.length > 0) {
      const pathname = new URL(c.req.url).pathname;
      if (skipPathnames.includes(pathname)) {
        await next();
        return;
      }
    }

    const cache = await openNamedCache(opts.cacheName);
    const cacheKey = buildCacheKey(c.req.url, c.req.header('Origin'), opts.normalizeCacheKeyUrl);

    const bypassCache = trace?.mode === 'bypass-cache';
    if (!bypassCache) {
      const matchT0 = trace ? performance.now() : 0;
      const cached = await cache.match(cacheKey);
      if (trace) {
        trace.addSpan('cache_match', performance.now() - matchT0);
      }
      if (cached) {
        if (trace) {
          trace.setLabel('edge_cache', 'hit');
          trace.finish('total');
          const res = new Response(cached.body, cached);
          applyTraceToResponse({ res, trace, prefix: 'edge' });
          // Avoid caching traced responses in browser/edge layers.
          res.headers.set('Cache-Control', 'private, no-store');
          appendVaryHeader(res, TRACE_HEADER);
          res.headers.set(TRACE_ID_HEADER, trace.id);
          return res;
        }
        return cached;
      }
      if (trace) {
        trace.setLabel('edge_cache', 'miss');
      }
    } else if (trace) {
      trace.setLabel('edge_cache', 'bypass');
    }

    await next();

    if (c.res.status !== 200) return;

    // Respect explicit no-store/no-cache/private responses.
    const cacheControl = c.res.headers.get('Cache-Control');
    if (
      cacheControl &&
      /(?:^|,\s*)(?:private|no-(?:store|cache))(?:\s*(?:=|,|$))/i.test(cacheControl)
    ) {
      return;
    }

    // If the handler already set Cache-Control, keep it.
    if (!cacheControl) {
      c.res.headers.set('Cache-Control', `public, max-age=${opts.maxAgeSeconds}`);
    }

    if (trace) {
      trace.finish('total');
      applyTraceToResponse({ res: c.res, trace, prefix: 'edge' });
      c.res.headers.set('Cache-Control', 'private, no-store');
      appendVaryHeader(c.res, TRACE_HEADER);
      return;
    }

    // Put into Cloudflare's cache without blocking the response.
    c.executionCtx.waitUntil(cache.put(cacheKey, c.res.clone()));
  };
}
