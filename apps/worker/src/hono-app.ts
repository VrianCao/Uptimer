import { Hono } from 'hono';

import type { Env } from './env';
import { handleError, handleNotFound } from './middleware/errors';
import { publicHotRoutes } from './routes/public-hot';

const app = new Hono<{ Bindings: Env }>();
const CORS_ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_GET_ONLY_METHODS = 'GET, OPTIONS';

function normalizeApiPathname(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  if (!collapsed) return '/';
  if (collapsed.length === 1) return collapsed;
  return collapsed.replace(/\/+$/, '') || '/';
}

function isGetOnlyPublicApiPath(pathname: string): boolean {
  const normalizedPathname = normalizeApiPathname(pathname);
  return (
    normalizedPathname === '/api/v1/public' || normalizedPathname.startsWith('/api/v1/public/')
  );
}

function allowedMethodsForApiPath(pathname: string): string {
  return isGetOnlyPublicApiPath(pathname) ? CORS_GET_ONLY_METHODS : CORS_ALLOW_METHODS;
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

function applyCorsHeaders(res: Response, origin: string | null): Response {
  const out = new Response(res.body, res);
  appendVaryHeader(out, 'Origin');
  if (origin) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  }
  return out;
}

function rewriteAdminRequest(req: Request): Request {
  const url = new URL(req.url);
  const prefix = '/api/v1/admin';
  if (url.pathname === prefix) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  }
  return new Request(url.toString(), req);
}

// Minimal CORS support so Pages (or any web UI) can call the API when hosted on a different origin
// (e.g. Pages on *.pages.dev and API on *.workers.dev). We reflect the Origin to keep it simple and
// avoid hardcoding a single hostname in the Worker config.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  const pathname = new URL(c.req.url).pathname;
  const allowedMethods = allowedMethodsForApiPath(pathname);
  c.header('Vary', 'Origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', allowedMethods);
    c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

// Redirect legacy `/api/*` paths to the versioned API.
// This is useful when Pages (dev/prod) proxies `/api` to this Worker but the
// frontend calls `/api/v1/...`.
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/v1' || path.startsWith('/api/v1/')) {
    await next();
    return;
  }

  const url = new URL(c.req.url);
  url.pathname = `/api/v1${path.slice('/api'.length)}`;
  return c.redirect(url.toString(), 308);
});

app.onError(handleError);
app.notFound(handleNotFound);

app.get('/', (c) => c.text('ok'));

app.route('/api/v1/public', publicHotRoutes);

// Admin endpoints are rarely hit compared to the public status page. Lazily load the
// admin router so cold-start CPU stays focused on the homepage hot path.
app.all('/api/v1/admin', async (c) => {
  const { adminRoutes } = await import('./routes/admin');
  const res = await adminRoutes.fetch(rewriteAdminRequest(c.req.raw), c.env, c.executionCtx);
  return applyCorsHeaders(res, c.req.header('Origin') ?? null);
});
app.all('/api/v1/admin/*', async (c) => {
  const { adminRoutes } = await import('./routes/admin');
  const res = await adminRoutes.fetch(rewriteAdminRequest(c.req.raw), c.env, c.executionCtx);
  return applyCorsHeaders(res, c.req.header('Origin') ?? null);
});

export const fetch = app.fetch;
