const SNAPSHOT_MAX_AGE_SECONDS = 60;
const PREFERRED_MAX_AGE_SECONDS = 30;
const FALLBACK_HTML_MAX_AGE_SECONDS = 600;
const HOMEPAGE_CACHE_GENERATED_AT_HEADER = 'X-Uptimer-Generated-At';
const TRACE_HEADER = 'X-Uptimer-Trace';
const TRACE_ID_HEADER = 'X-Uptimer-Trace-Id';
const TRACE_TOKEN_HEADER = 'X-Uptimer-Trace-Token';
const TRACE_MODE_HEADER = 'X-Uptimer-Trace-Mode';
const API_PREFIX = '/api';
const API_VERSION_PREFIX = '/api/v1';
const CORS_ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_ALLOW_HEADERS = 'Authorization,Content-Type';
const HOMEPAGE_FUTURE_TOLERANCE_SECONDS = 60;
const API_PATH_MAX_DECODE_PASSES = 32;

function normalizeApiPathname(pathname) {
  const collapsed = String(pathname || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (!collapsed) return '/';
  if (collapsed.length === 1) return collapsed;
  return collapsed.replace(/\/+$/, '') || '/';
}

function isHexDigit(char) {
  return typeof char === 'string' && /^[0-9a-f]$/i.test(char);
}

function hasInvalidPercentEncoding(pathname) {
  const value = String(pathname || '');
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (!isHexDigit(value[index + 1]) || !isHexDigit(value[index + 2])) {
      return true;
    }
    index += 2;
  }
  return false;
}

function decodeApiPathname(pathname) {
  let decoded = String(pathname || '');
  const maxPasses = Math.max(
    1,
    Math.min(API_PATH_MAX_DECODE_PASSES, Math.ceil(decoded.length / 3) + 1),
  );
  for (let index = 0; index < maxPasses; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function canonicalizeApiPathname(pathname) {
  const normalizedPathname = normalizeApiPathname(
    decodeApiPathname(pathname).replace(/[\u0000-\u001f\u007f]+/g, ''),
  );
  try {
    return normalizeApiPathname(new URL(normalizedPathname, 'https://uptimer.invalid').pathname);
  } catch {
    return normalizedPathname;
  }
}

function resolveApiRequestPath(pathname) {
  const normalizedRawPathname = normalizeApiPathname(pathname).replace(
    /[\u0000-\u001f\u007f]+/g,
    '',
  );
  if (normalizedRawPathname !== API_PREFIX && !normalizedRawPathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  if (hasInvalidPercentEncoding(normalizedRawPathname)) {
    return {
      normalizedPathname: normalizedRawPathname,
      canonicalPathname: normalizedRawPathname,
      needsVersionRedirect: false,
      invalidEncoding: true,
    };
  }

  const normalizedPathname = canonicalizeApiPathname(pathname);

  const needsVersionRedirect =
    normalizedPathname !== API_VERSION_PREFIX &&
    !normalizedPathname.startsWith(`${API_VERSION_PREFIX}/`);
  const canonicalPathname = needsVersionRedirect
    ? `${API_VERSION_PREFIX}${normalizedPathname.slice(API_PREFIX.length)}`
    : normalizedPathname;

  return {
    normalizedPathname,
    canonicalPathname,
    needsVersionRedirect,
  };
}

function isApiRequest(url) {
  return resolveApiRequestPath(url.pathname) !== null;
}

function hasNonEmptyHeader(request, name) {
  const value = request.headers.get(name);
  return typeof value === 'string' && value.trim().length > 0;
}

function isInternalApiPath(pathname) {
  const canonicalPathname = normalizeApiPathname(pathname);
  return (
    canonicalPathname === '/api/v1/internal' || canonicalPathname.startsWith('/api/v1/internal/')
  );
}

function isGetOnlyPublicApiPath(pathname) {
  const canonicalPathname = normalizeApiPathname(pathname);
  return canonicalPathname === '/api/v1/public' || canonicalPathname.startsWith('/api/v1/public/');
}

function isAllowedApiOriginUrl(url) {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLocalApiHost(url.hostname);
}

function resolveApiOriginUrl(env) {
  const apiOrigin =
    typeof env?.UPTIMER_API_ORIGIN === 'string' ? env.UPTIMER_API_ORIGIN.trim() : '';
  if (!apiOrigin) return null;

  try {
    const url = new URL(apiOrigin);
    if (!isAllowedApiOriginUrl(url)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = '/';
    return url;
  } catch {
    return null;
  }
}

function resolveApiOrigin(env) {
  const url = resolveApiOriginUrl(env);
  return url ? url.toString() : null;
}

function resolveSensitiveApiOriginUrl(env) {
  const sensitiveOrigin =
    typeof env?.UPTIMER_API_SENSITIVE_ORIGIN === 'string'
      ? env.UPTIMER_API_SENSITIVE_ORIGIN.trim()
      : '';
  if (!sensitiveOrigin) return null;
  try {
    const url = new URL(sensitiveOrigin);
    if (!isAllowedApiOriginUrl(url)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = '/';
    return url;
  } catch {
    return null;
  }
}

function buildApiProxyUrl(url, env, apiOriginOverride, apiPathname) {
  const apiOrigin = apiOriginOverride || resolveApiOriginUrl(env);
  const apiPath =
    typeof apiPathname === 'string'
      ? apiPathname
      : resolveApiRequestPath(url.pathname)?.canonicalPathname;
  if (!apiOrigin || !apiPath) return null;
  return new URL(`${apiPath}${url.search}`, apiOrigin);
}

function isLocalApiHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

function canForwardSensitiveHeaders(upstreamUrl, requestUrl, trustedSensitiveOriginUrl = null) {
  if (trustedSensitiveOriginUrl) {
    return upstreamUrl.origin === trustedSensitiveOriginUrl.origin;
  }
  if (upstreamUrl.origin === requestUrl.origin) return true;
  if (isLocalApiHost(upstreamUrl.hostname)) return true;
  return false;
}

function hasSensitiveProxyHeaders(request) {
  return (
    hasNonEmptyHeader(request, 'Authorization') || hasNonEmptyHeader(request, TRACE_TOKEN_HEADER)
  );
}

function normalizeHeaderName(name) {
  return String(name).trim().toLowerCase();
}

function appendVaryHeader(headers, value) {
  const next = String(value || '').trim();
  if (!next) return;
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', next);
    return;
  }
  const normalized = next.toLowerCase();
  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  if (parts.includes(normalized)) return;
  headers.set('Vary', `${existing}, ${next}`);
}

function parseConnectionHeaderTokens(value) {
  const tokens = new Set();
  if (typeof value !== 'string') return tokens;
  for (const part of value.split(',')) {
    const normalized = normalizeHeaderName(part);
    if (!normalized) continue;
    tokens.add(normalized);
  }
  return tokens;
}

function shouldStripProxyHeader(name) {
  const normalized = normalizeHeaderName(name);
  if (!normalized) return false;
  if (normalized === 'host') return true;
  if (normalized.startsWith('cf-')) return true;
  if (normalized === 'cookie' || normalized === 'cookie2') return true;
  if (normalized === 'proxy-authorization') return true;
  if (normalized === 'connection' || normalized === 'keep-alive') return true;
  if (normalized === 'te' || normalized === 'trailer') return true;
  if (normalized === 'transfer-encoding' || normalized === 'upgrade') return true;
  if (normalized === 'proxy-connection') return true;
  if (normalized === 'forwarded' || normalized === 'x-forwarded-for') return true;
  if (normalized === 'x-real-ip' || normalized === 'true-client-ip') return true;
  if (normalized === 'cf-connecting-ip') return true;
  if (normalized.startsWith('x-forwarded-')) return true;
  return false;
}

function shouldStripProxyResponseHeader(name) {
  const normalized = normalizeHeaderName(name);
  if (!normalized) return false;
  if (normalized === 'connection' || normalized === 'keep-alive') return true;
  if (normalized === 'proxy-connection') return true;
  if (normalized === 'proxy-authenticate' || normalized === 'proxy-authorization') return true;
  if (normalized === 'te' || normalized === 'trailer') return true;
  if (normalized === 'transfer-encoding' || normalized === 'upgrade') return true;
  return false;
}

function buildApiProxyRequest(request, upstreamUrl) {
  const connectionTokens = parseConnectionHeaderTokens(request.headers.get('Connection'));
  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    const normalized = normalizeHeaderName(name);
    if (connectionTokens.has(normalized)) continue;
    if (shouldStripProxyHeader(name)) continue;
    headers.set(name, value);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    duplex: hasBody ? 'half' : undefined,
  });
}

function sanitizeApiProxyResponse(upstreamResponse) {
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return new Response(
      JSON.stringify({
        error: {
          code: 'UPSTREAM_REDIRECT_BLOCKED',
          message: 'Upstream redirects are not allowed through the Pages API proxy',
        },
      }),
      {
        status: 502,
        headers,
      },
    );
  }

  const headers = new Headers(upstreamResponse.headers);
  const connectionTokens = parseConnectionHeaderTokens(headers.get('Connection'));
  for (const token of connectionTokens) {
    headers.delete(token);
  }
  for (const name of Array.from(headers.keys())) {
    if (shouldStripProxyResponseHeader(name)) {
      headers.delete(name);
    }
  }
  headers.delete('Set-Cookie');
  headers.delete('Set-Cookie2');
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function applySensitiveProxyResponsePolicy(res, request) {
  if (!hasSensitiveProxyHeaders(request)) {
    return res;
  }

  if (hasNonEmptyHeader(request, 'Authorization')) {
    appendVaryHeader(res.headers, 'Authorization');
  }
  if (hasNonEmptyHeader(request, TRACE_TOKEN_HEADER)) {
    appendVaryHeader(res.headers, TRACE_TOKEN_HEADER);
  }
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function applyApiCorsHeaders(res, request, canonicalPathname) {
  const out = new Response(res.body, res);
  const origin = request.headers.get('Origin');
  appendVaryHeader(out.headers, 'Origin');
  if (origin) {
    out.headers.set('Access-Control-Allow-Origin', origin);
  }
  out.headers.set(
    'Access-Control-Allow-Methods',
    isGetOnlyPublicApiPath(canonicalPathname) ? 'GET, OPTIONS' : CORS_ALLOW_METHODS,
  );
  out.headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  return out;
}

function buildApiPreflightResponse(request, canonicalPathname) {
  return applyApiCorsHeaders(new Response(null, { status: 204 }), request, canonicalPathname);
}

function buildApiMethodNotAllowedResponse(request, canonicalPathname) {
  const allowedMethods = isGetOnlyPublicApiPath(canonicalPathname)
    ? 'GET, OPTIONS'
    : CORS_ALLOW_METHODS;
  const res = jsonError(405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed');
  res.headers.set('Allow', allowedMethods);
  res.headers.set('Cache-Control', 'no-store');
  return applyApiCorsHeaders(res, request, canonicalPathname);
}

function acceptsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function normalizeTruthyHeader(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveTraceContext(request, env) {
  const enabled = normalizeTruthyHeader(request.headers.get(TRACE_HEADER));
  if (!enabled) return null;

  const tokenEnv =
    typeof env?.UPTIMER_TRACE_TOKEN === 'string' ? env.UPTIMER_TRACE_TOKEN.trim() : '';
  const fallbackEnvToken = typeof env?.TRACE_TOKEN === 'string' ? env.TRACE_TOKEN.trim() : '';
  const expectedToken = tokenEnv || fallbackEnvToken;
  if (!expectedToken) return null;
  const providedToken = request.headers.get(TRACE_TOKEN_HEADER) || '';
  if (providedToken !== expectedToken) return null;

  const id = request.headers.get(TRACE_ID_HEADER) || crypto.randomUUID();
  const modeRaw = request.headers.get(TRACE_MODE_HEADER) || '';
  const mode = modeRaw.trim().length > 0 ? modeRaw.trim() : null;

  const spans = [];
  const labels = new Map();
  const t0 = performance.now();
  let finished = false;

  function setLabel(key, value) {
    if (!key) return;
    if (value === null || value === undefined) return;
    const str = typeof value === 'string' ? value : String(value);
    if (!str) return;
    labels.set(String(key), str.replace(/[;\r\n]/g, '_'));
  }

  function addSpan(name, durMs) {
    if (!name) return;
    spans.push({ name: String(name), durMs: Number.isFinite(durMs) ? Math.max(0, durMs) : 0 });
  }

  function time(name, fn) {
    const tStart = performance.now();
    const out = fn();
    const tEnd = performance.now();
    addSpan(name, tEnd - tStart);
    return out;
  }

  async function timeAsync(name, fn) {
    const tStart = performance.now();
    try {
      return await fn();
    } finally {
      const tEnd = performance.now();
      addSpan(name, tEnd - tStart);
    }
  }

  function finish(name = 'total') {
    if (finished) return;
    finished = true;
    addSpan(name, performance.now() - t0);
  }

  function toServerTiming(prefix = 'p') {
    const p = prefix && String(prefix).trim().length > 0 ? `${String(prefix).trim()}_` : '';
    return spans
      .map(
        (span) =>
          `${(p + span.name).replace(/[^a-zA-Z0-9_.-]/g, '_')};dur=${span.durMs.toFixed(2)}`,
      )
      .join(', ');
  }

  function toInfoHeader(prefix = 'p') {
    const p = prefix && String(prefix).trim().length > 0 ? `${String(prefix).trim()}_` : '';
    const parts = [];
    for (const [key, value] of labels.entries()) {
      parts.push(`${(p + key).replace(/[^a-zA-Z0-9_.-]/g, '_')}=${value}`);
    }
    if (mode) {
      parts.push(`${p}mode=${mode.replace(/[;\r\n]/g, '_')}`);
    }
    return parts.join(';');
  }

  return {
    id,
    mode,
    token: providedToken,
    spans,
    labels,
    apiServerTiming: null,
    apiInfo: null,
    setLabel,
    addSpan,
    time,
    timeAsync,
    finish,
    toServerTiming,
    toInfoHeader,
  };
}

function appendServerTiming(headers, value) {
  if (!value) return;
  const existing = headers.get('Server-Timing');
  if (existing) {
    headers.set('Server-Timing', `${existing}, ${value}`);
  } else {
    headers.set('Server-Timing', value);
  }
}

function prefixServerTiming(value, prefix) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const p = prefix && String(prefix).trim().length > 0 ? `${String(prefix).trim()}_` : '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(';');
      if (idx <= 0) return `${p}${part}`;
      const name = part.slice(0, idx).trim();
      return `${p}${name}${part.slice(idx)}`;
    })
    .join(', ');
}

function mergeTraceInfo(targetLabels, rawInfo, prefix) {
  const raw = typeof rawInfo === 'string' ? rawInfo.trim() : '';
  if (!raw) return;
  const p = prefix && String(prefix).trim().length > 0 ? `${String(prefix).trim()}_` : '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value) continue;
    targetLabels.set(`${p}${key}`.replace(/[^a-zA-Z0-9_.-]/g, '_'), value.replace(/[;\r\n]/g, '_'));
  }
}

function finalizeTraceResponse(res, trace) {
  if (!trace) return res;

  // Fold API trace info into page labels before rendering headers.
  mergeTraceInfo(trace.labels, trace.apiInfo, 'api');

  trace.finish('total');

  const out = new Response(res.body, res);
  out.headers.set(TRACE_ID_HEADER, trace.id);

  const info = trace.toInfoHeader('p');
  if (info) {
    const existing = out.headers.get(TRACE_HEADER);
    out.headers.set(TRACE_HEADER, existing ? `${existing};${info}` : info);
  }

  appendServerTiming(out.headers, trace.toServerTiming('p'));
  appendServerTiming(out.headers, prefixServerTiming(trace.apiServerTiming, 'api'));

  return out;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function sanitizeInlineJsonText(jsonText) {
  if (typeof jsonText !== 'string') return null;
  const trimmed = jsonText.trim();
  if (!trimmed) return null;
  try {
    return safeJsonForInlineScript(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function sanitizeHtmlResponseHeaders(headers) {
  const next = new Headers(headers);
  next.delete('Set-Cookie');
  next.delete('Set-Cookie2');
  return next;
}

function buildSanitizedHtmlResponse(response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizeHtmlResponseHeaders(response.headers),
  });
}

function normalizeHomepageGeneratedAt(value, now) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const generatedAt = Math.trunc(value);
  if (generatedAt > now + HOMEPAGE_FUTURE_TOLERANCE_SECONDS) {
    return null;
  }
  return generatedAt;
}

function computeHomepageAge(now, generatedAt) {
  const normalizedGeneratedAt = normalizeHomepageGeneratedAt(generatedAt, now);
  if (normalizedGeneratedAt === null) return null;
  return Math.max(0, now - normalizedGeneratedAt);
}

function sanitizeHomepagePreloadHtml(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/<\s*script\b/i.test(trimmed)) return null;
  if (/\bon[a-z]+\s*=/i.test(trimmed)) return null;
  if (/\bjavascript\s*:/i.test(trimmed)) return null;
  if (/<\s*(iframe|object|embed|foreignobject|link|meta|style)\b/i.test(trimmed)) return null;
  return trimmed;
}

function readGeneratedAtHeader(res) {
  const raw = res.headers.get(HOMEPAGE_CACHE_GENERATED_AT_HEADER);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSnapshotText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeHomepageArtifactPayload(data, now) {
  if (!data || typeof data !== 'object') return null;
  const preloadHtml = sanitizeHomepagePreloadHtml(data.preload_html);
  if (!preloadHtml) return null;
  const generatedAt =
    data.generated_at === undefined ? null : normalizeHomepageGeneratedAt(data.generated_at, now);
  if (data.generated_at !== undefined && generatedAt === null) return null;

  let snapshotInlineJson = null;
  if (typeof data.snapshot_json === 'string') {
    snapshotInlineJson = sanitizeInlineJsonText(data.snapshot_json);
  } else if (data.snapshot && typeof data.snapshot === 'object') {
    snapshotInlineJson = safeJsonForInlineScript(data.snapshot);
  }

  if (!snapshotInlineJson) return null;

  return {
    generated_at: generatedAt,
    preload_html: preloadHtml,
    meta_title: typeof data.meta_title === 'string' ? data.meta_title : '',
    meta_description: typeof data.meta_description === 'string' ? data.meta_description : '',
    snapshot_inline_json: snapshotInlineJson,
  };
}

const HOMEPAGE_PRELOAD_STYLE_TAG = `<style id="uptimer-preload-style">
#uptimer-preload{min-height:100vh;background:#f8fafc;color:#0f172a;font:400 14px/1.45 ui-sans-serif,system-ui,sans-serif}
#uptimer-preload *{box-sizing:border-box}
#uptimer-preload .uw{max-width:80rem;margin:0 auto;padding:0 16px}
#uptimer-preload .uh{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.95);backdrop-filter:blur(12px);border-bottom:1px solid rgba(226,232,240,.8)}
#uptimer-preload .uhw{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0}
#uptimer-preload .ut{min-width:0}
#uptimer-preload .un{font-size:20px;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#uptimer-preload .ud{margin-top:4px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#uptimer-preload .sb{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;border:1px solid transparent}
#uptimer-preload .sb-up{background:#ecfdf5;color:#047857;border-color:#a7f3d0}
#uptimer-preload .sb-down{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
#uptimer-preload .sb-maintenance{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
#uptimer-preload .sb-paused{background:#fffbeb;color:#b45309;border-color:#fde68a}
#uptimer-preload .sb-unknown{background:#f8fafc;color:#475569;border-color:#cbd5e1}
#uptimer-preload .um{padding:24px 0 40px}
#uptimer-preload .bn{margin:0 0 24px;border:1px solid #e2e8f0;border-radius:18px;padding:20px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.04)}
#uptimer-preload .bt{color:#475569}
#uptimer-preload .bu{margin-top:4px;font-size:12px;color:#94a3b8}
#uptimer-preload .sec{margin-top:24px}
#uptimer-preload .sh{margin:0 0 12px;font-size:16px;font-weight:700}
#uptimer-preload .st{display:grid;gap:12px}
#uptimer-preload .sg{margin-top:20px}
#uptimer-preload .sgh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
#uptimer-preload .sgt{font-size:13px;font-weight:700;color:#475569}
#uptimer-preload .sgc{font-size:12px;color:#94a3b8}
#uptimer-preload .grid{display:grid;gap:12px}
#uptimer-preload .card{border:1px solid rgba(226,232,240,.9);border-radius:16px;padding:14px;background:#fff}
#uptimer-preload .row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
#uptimer-preload .lhs{min-width:0;display:flex;align-items:flex-start;gap:10px}
#uptimer-preload .dot{display:block;width:10px;height:10px;border-radius:999px;margin-top:5px}
#uptimer-preload .dot-up{background:#10b981}
#uptimer-preload .dot-down{background:#ef4444}
#uptimer-preload .dot-maintenance{background:#3b82f6}
#uptimer-preload .dot-paused{background:#f59e0b}
#uptimer-preload .dot-unknown{background:#94a3b8}
#uptimer-preload .mn{font-size:15px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#uptimer-preload .mt{margin-top:3px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em}
#uptimer-preload .rhs{display:flex;align-items:center;gap:8px;white-space:nowrap}
#uptimer-preload .up{font-size:12px;color:#94a3b8}
#uptimer-preload .lbl{margin:12px 0 6px;font-size:11px;color:#94a3b8}
#uptimer-preload .strip{height:20px;border-radius:8px;background:#e2e8f0;overflow:hidden}
#uptimer-preload .usv{display:block;width:100%;height:100%}
#uptimer-preload .ft{margin-top:12px;font-size:11px;color:#94a3b8}
#uptimer-preload .ih{padding-top:24px;border-top:1px solid #e2e8f0}
@media (min-width:640px){#uptimer-preload .grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
html.dark #uptimer-preload{background:#0f172a;color:#f8fafc}
html.dark #uptimer-preload .uh{background:rgba(15,23,42,.95);border-bottom-color:rgba(51,65,85,.9)}
html.dark #uptimer-preload .ud,html.dark #uptimer-preload .sgt{color:#cbd5e1}
html.dark #uptimer-preload .bn,html.dark #uptimer-preload .card{background:#1e293b;border-color:rgba(51,65,85,.95);box-shadow:none}
html.dark #uptimer-preload .bt{color:#cbd5e1}
html.dark #uptimer-preload .bu,html.dark #uptimer-preload .sgc,html.dark #uptimer-preload .up,html.dark #uptimer-preload .lbl,html.dark #uptimer-preload .ft{color:#94a3b8}
html.dark #uptimer-preload .mt{color:#94a3b8}
html.dark #uptimer-preload .strip{background:#334155}
html.dark #uptimer-preload .ih{border-top-color:#334155}
</style>`;

function computeCacheControl(ageSeconds) {
  const remaining = Math.max(0, SNAPSHOT_MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(PREFERRED_MAX_AGE_SECONDS, remaining);
  const stale = Math.max(0, remaining - maxAge);
  return `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`;
}

function canServeCachedHomepageFallback(ageSeconds) {
  return ageSeconds <= FALLBACK_HTML_MAX_AGE_SECONDS;
}

function buildHomepageCacheHit(cached, ageSeconds) {
  // In the Cloudflare runtime, cached/fetched Responses can have immutable headers.
  // Always rebuild before mutating.
  const hit = buildSanitizedHtmlResponse(cached);
  hit.headers.set('Cache-Control', computeCacheControl(ageSeconds));
  hit.headers.delete(HOMEPAGE_CACHE_GENERATED_AT_HEADER);
  return hit;
}

function upsertHeadTag(html, pattern, tag) {
  if (pattern.test(html)) {
    return html.replace(pattern, tag);
  }
  return html.replace('</head>', `  ${tag}\n</head>`);
}

function injectStatusMetaTags(html, artifact, url) {
  const siteTitle = normalizeSnapshotText(artifact?.meta_title, 'Uptimer');
  const siteDescription = normalizeSnapshotText(
    artifact?.meta_description,
    'Real-time status and incident updates.',
  )
    .replace(/\s+/g, ' ')
    .trim();
  const pageUrl = new URL('/', url).toString();

  const escapedTitle = escapeHtml(siteTitle);
  const escapedDescription = escapeHtml(siteDescription);
  const escapedUrl = escapeHtml(pageUrl);

  let injected = html;
  injected = upsertHeadTag(injected, /<title>[^<]*<\/title>/i, `<title>${escapedTitle}</title>`);
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapedDescription}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+property=["']og:type["'][^>]*>/i,
    '<meta property="og:type" content="website" />',
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+property=["']og:title["'][^>]*>/i,
    `<meta property="og:title" content="${escapedTitle}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+property=["']og:description["'][^>]*>/i,
    `<meta property="og:description" content="${escapedDescription}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+property=["']og:site_name["'][^>]*>/i,
    `<meta property="og:site_name" content="${escapedTitle}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+property=["']og:url["'][^>]*>/i,
    `<meta property="og:url" content="${escapedUrl}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+name=["']twitter:card["'][^>]*>/i,
    '<meta name="twitter:card" content="summary" />',
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+name=["']twitter:title["'][^>]*>/i,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
  );
  injected = upsertHeadTag(
    injected,
    /<meta[^>]+name=["']twitter:description["'][^>]*>/i,
    `<meta name="twitter:description" content="${escapedDescription}" />`,
  );

  return injected;
}

function buildMinimalIndexHtml(title = 'Uptimer') {
  const escapedTitle = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapedTitle}</title></head><body><div id="root"></div></body></html>`;
}

async function fetchIndexHtml(env, url) {
  const indexUrl = new URL('/index.html', url);

  // Do not pass the original navigation request as init. In Pages runtime the
  // navigation request can carry redirect mode = manual; if we forward that
  // into `env.ASSETS.fetch`, we might accidentally return a redirect response
  // (and cache it), causing ERR_TOO_MANY_REDIRECTS.
  const req = new Request(indexUrl.toString(), {
    method: 'GET',
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });

  return env.ASSETS.fetch(req);
}

async function fetchPublicHomepageArtifact(env, trace, now) {
  const apiOrigin = resolveApiOrigin(env);
  if (!apiOrigin) return null;

  const statusUrl = new URL('/api/v1/public/homepage-artifact', apiOrigin);

  // Keep HTML fast: if the API is slow, fall back to a static HTML shell.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 800);

  try {
    const headers = { Accept: 'application/json' };
    if (trace) {
      headers[TRACE_HEADER] = '1';
      headers[TRACE_ID_HEADER] = trace.id;
      if (trace.token) headers[TRACE_TOKEN_HEADER] = trace.token;
      if (trace.mode) headers[TRACE_MODE_HEADER] = trace.mode;
    }

    const resp = trace
      ? await trace.timeAsync('api_fetch', () =>
          fetch(statusUrl.toString(), { headers, signal: controller.signal }),
        )
      : await fetch(statusUrl.toString(), { headers, signal: controller.signal });

    if (trace) {
      trace.setLabel('api_status', resp.status);
      const serverTiming = resp.headers.get('Server-Timing');
      if (serverTiming) trace.apiServerTiming = serverTiming;
      const apiInfo = resp.headers.get(TRACE_HEADER);
      if (apiInfo) trace.apiInfo = apiInfo;
    }

    if (!resp.ok) return null;

    const data = trace ? await trace.timeAsync('api_json', () => resp.json()) : await resp.json();
    return normalizeHomepageArtifactPayload(data, now);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function proxyApiRequest(request, env, trace, apiPathname) {
  const url = new URL(request.url);
  const resolvedPath = apiPathname || resolveApiRequestPath(url.pathname)?.canonicalPathname;
  if (!resolvedPath) {
    if (trace) {
      trace.setLabel('route', 'pages/api-proxy');
      trace.setLabel('path', 'invalid-api-path');
    }
    return finalizeTraceResponse(
      applyApiCorsHeaders(jsonError(404, 'NOT_FOUND', 'Not Found'), request, '/api/v1'),
      trace,
    );
  }

  if (isInternalApiPath(resolvedPath)) {
    if (trace) {
      trace.setLabel('route', 'pages/api-proxy');
      trace.setLabel('path', 'internal-blocked');
    }
    return finalizeTraceResponse(
      applyApiCorsHeaders(jsonError(404, 'NOT_FOUND', 'Not Found'), request, resolvedPath),
      trace,
    );
  }

  const hasSensitiveHeaders = hasSensitiveProxyHeaders(request);
  const sensitiveApiOrigin = hasSensitiveHeaders ? resolveSensitiveApiOriginUrl(env) : null;
  const upstreamUrl = buildApiProxyUrl(url, env, sensitiveApiOrigin, resolvedPath);

  if (!upstreamUrl) {
    if (trace) {
      trace.setLabel('route', 'pages/api-proxy');
      trace.setLabel('path', 'missing_origin');
    }
    return finalizeTraceResponse(
      applyApiCorsHeaders(
        applySensitiveProxyResponsePolicy(
          jsonError(
            503,
            'API_ORIGIN_NOT_CONFIGURED',
            'Pages API proxy is not configured. Set UPTIMER_API_ORIGIN.',
          ),
          request,
        ),
        request,
        resolvedPath,
      ),
      trace,
    );
  }

  if (trace) {
    trace.setLabel('route', 'pages/api-proxy');
    trace.setLabel('path', resolvedPath);
  }

  if (hasSensitiveHeaders && !canForwardSensitiveHeaders(upstreamUrl, url, sensitiveApiOrigin)) {
    if (trace) {
      trace.setLabel(
        'auth_forward',
        hasNonEmptyHeader(request, 'Authorization') ? 'blocked' : 'none',
      );
      trace.setLabel(
        'trace_token_forward',
        hasNonEmptyHeader(request, TRACE_TOKEN_HEADER) ? 'blocked' : 'none',
      );
      trace.setLabel('api_host', upstreamUrl.hostname);
    }
    return finalizeTraceResponse(
      applyApiCorsHeaders(
        applySensitiveProxyResponsePolicy(
          jsonError(
            503,
            'API_ORIGIN_UNTRUSTED_FOR_SENSITIVE_HEADERS',
            'Refusing to forward sensitive headers without a trusted API origin. Set UPTIMER_API_SENSITIVE_ORIGIN or use a same-origin/local API.',
          ),
          request,
        ),
        request,
        resolvedPath,
      ),
      trace,
    );
  }

  if (trace) {
    trace.setLabel(
      'auth_forward',
      hasNonEmptyHeader(request, 'Authorization') ? 'allowed' : 'none',
    );
    trace.setLabel(
      'trace_token_forward',
      hasNonEmptyHeader(request, TRACE_TOKEN_HEADER) ? 'allowed' : 'none',
    );
    trace.setLabel('api_host', upstreamUrl.hostname);
  }

  const upstreamRequest = buildApiProxyRequest(request, upstreamUrl);
  const upstreamResponse = trace
    ? await trace.timeAsync('api_proxy_fetch', () => fetch(upstreamRequest))
    : await fetch(upstreamRequest);

  if (trace) {
    trace.setLabel('api_status', upstreamResponse.status);
  }

  const sanitizedResponse = sanitizeApiProxyResponse(upstreamResponse);
  const response =
    upstreamResponse.status >= 300 && upstreamResponse.status < 400
      ? applyApiCorsHeaders(
          applySensitiveProxyResponsePolicy(sanitizedResponse, request),
          request,
          resolvedPath,
        )
      : applySensitiveProxyResponsePolicy(sanitizedResponse, request);

  return finalizeTraceResponse(response, trace);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const trace = resolveTraceContext(request, env);
    const resolvedApiPath = resolveApiRequestPath(url.pathname);

    try {
      try {
        ctx.passThroughOnException?.();
      } catch {
        // ignore
      }

      if (resolvedApiPath) {
        if (resolvedApiPath.invalidEncoding) {
          return finalizeTraceResponse(
            applyApiCorsHeaders(
              applySensitiveProxyResponsePolicy(jsonError(404, 'NOT_FOUND', 'Not Found'), request),
              request,
              resolvedApiPath.canonicalPathname,
            ),
            trace,
          );
        }
        if (isInternalApiPath(resolvedApiPath.canonicalPathname)) {
          return finalizeTraceResponse(
            applyApiCorsHeaders(
              applySensitiveProxyResponsePolicy(jsonError(404, 'NOT_FOUND', 'Not Found'), request),
              request,
              resolvedApiPath.canonicalPathname,
            ),
            trace,
          );
        }
        if (request.method === 'OPTIONS') {
          return finalizeTraceResponse(
            applySensitiveProxyResponsePolicy(
              buildApiPreflightResponse(request, resolvedApiPath.canonicalPathname),
              request,
            ),
            trace,
          );
        }
        if (request.method !== 'GET' && isGetOnlyPublicApiPath(resolvedApiPath.canonicalPathname)) {
          return finalizeTraceResponse(
            applySensitiveProxyResponsePolicy(
              buildApiMethodNotAllowedResponse(request, resolvedApiPath.canonicalPathname),
              request,
            ),
            trace,
          );
        }
        if (resolvedApiPath.needsVersionRedirect) {
          const next = new URL(request.url);
          next.pathname = resolvedApiPath.canonicalPathname;
          return finalizeTraceResponse(
            applySensitiveProxyResponsePolicy(
              applyApiCorsHeaders(
                Response.redirect(next.toString(), 308),
                request,
                resolvedApiPath.canonicalPathname,
              ),
              request,
            ),
            trace,
          );
        }
        return await proxyApiRequest(request, env, trace, resolvedApiPath.canonicalPathname);
      }

      // HTML requests: serve SPA entry for client-side routes.
      const wantsHtml = request.method === 'GET' && acceptsHtml(request);

      // Special-case the status page for HTML injection.
      const isStatusPage = url.pathname === '/' || url.pathname === '/index.html';
      if (wantsHtml && isStatusPage) {
        if (trace) {
          trace.setLabel('route', 'pages/homepage');
        }

        const cacheKey = new Request(url.origin + '/', { method: 'GET' });
        let cached = null;
        if (trace && trace.mode === 'bypass-cache') {
          trace.setLabel('cache', 'bypass');
          cached = null;
        } else {
          try {
            cached = trace
              ? await trace.timeAsync('cache_match', () => caches.default.match(cacheKey))
              : await caches.default.match(cacheKey);
          } catch {
            cached = null;
          }
        }

        const now = Math.floor(Date.now() / 1000);
        if (cached) {
          const cachedGeneratedAt = readGeneratedAtHeader(cached);
          if (cachedGeneratedAt === null) {
            if (trace) {
              trace.setLabel('path', 'cache_hit_raw');
            }
            return finalizeTraceResponse(buildSanitizedHtmlResponse(cached), trace);
          }

          const cachedAge = computeHomepageAge(now, cachedGeneratedAt);
          if (cachedAge !== null && cachedAge <= SNAPSHOT_MAX_AGE_SECONDS) {
            const hit = trace
              ? trace.time('cache_hit_build', () => buildHomepageCacheHit(cached, cachedAge))
              : buildHomepageCacheHit(cached, cachedAge);
            if (trace) {
              trace.setLabel('path', 'cache_hit');
              trace.setLabel('age', cachedAge);
            }
            return finalizeTraceResponse(hit, trace);
          } else if (trace && cachedAge === null) {
            trace.setLabel('cache_invalid_future', cachedGeneratedAt);
          }
        }

        const base = trace
          ? await trace.timeAsync('index_fetch', () => fetchIndexHtml(env, url))
          : await fetchIndexHtml(env, url);
        const html = trace
          ? await trace.timeAsync('index_text', () => base.text())
          : await base.text();

        const artifact = await fetchPublicHomepageArtifact(env, trace, now);
        if (!artifact) {
          if (cached) {
            const cachedGeneratedAt = readGeneratedAtHeader(cached);
            if (cachedGeneratedAt === null) {
              if (trace) trace.setLabel('path', 'api_fail_cache_raw');
              return finalizeTraceResponse(buildSanitizedHtmlResponse(cached), trace);
            }
            const cachedAge = computeHomepageAge(now, cachedGeneratedAt);
            if (cachedAge !== null && canServeCachedHomepageFallback(cachedAge)) {
              const hit = trace
                ? trace.time('cache_hit_build', () => buildHomepageCacheHit(cached, cachedAge))
                : buildHomepageCacheHit(cached, cachedAge);
              if (trace) {
                trace.setLabel('path', 'api_fail_cache_hit');
                trace.setLabel('age', cachedAge);
              }
              return finalizeTraceResponse(hit, trace);
            }
            if (trace && cachedAge === null) {
              trace.setLabel('cache_invalid_future', cachedGeneratedAt);
            }
            if (trace && cachedAge !== null) {
              trace.setLabel('cache_stale_skip', cachedAge);
            }
          }
          const headers = new Headers(base.headers);
          headers.set('Content-Type', 'text/html; charset=utf-8');
          headers.append('Vary', 'Accept');
          headers.delete('Location');

          if (trace) {
            trace.setLabel('path', 'api_fail_index');
            trace.setLabel('html_chars', html.length);
          }
          return finalizeTraceResponse(
            new Response(html, { status: 200, headers: sanitizeHtmlResponseHeaders(headers) }),
            trace,
          );
        }

        const generatedAt = typeof artifact.generated_at === 'number' ? artifact.generated_at : now;
        const age = computeHomepageAge(now, generatedAt) ?? 0;

        const snapshotInlineJson = artifact.snapshot_inline_json;

        let injected = trace
          ? trace.time('inject_root', () =>
              html.replace(
                '<div id="root"></div>',
                `${artifact.preload_html}<div id="root"></div>`,
              ),
            )
          : html.replace('<div id="root"></div>', `${artifact.preload_html}<div id="root"></div>`);

        injected = trace
          ? trace.time('inject_meta', () => injectStatusMetaTags(injected, artifact, url))
          : injectStatusMetaTags(injected, artifact, url);

        injected = trace
          ? trace.time('inject_bootstrap', () =>
              injected.replace(
                '</head>',
                `  ${HOMEPAGE_PRELOAD_STYLE_TAG}\n  <script>globalThis.__UPTIMER_INITIAL_HOMEPAGE__=${snapshotInlineJson};</script>\n</head>`,
              ),
            )
          : injected.replace(
              '</head>',
              `  ${HOMEPAGE_PRELOAD_STYLE_TAG}\n  <script>globalThis.__UPTIMER_INITIAL_HOMEPAGE__=${snapshotInlineJson};</script>\n</head>`,
            );

        const headers = sanitizeHtmlResponseHeaders(base.headers);
        headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.set('Cache-Control', computeCacheControl(age));
        headers.append('Vary', 'Accept');
        headers.delete('Location');

        const resp = trace
          ? trace.time('resp_build', () => new Response(injected, { status: 200, headers }))
          : new Response(injected, { status: 200, headers });

        const cacheHeaders = new Headers(headers);
        cacheHeaders.set('Cache-Control', `public, max-age=${FALLBACK_HTML_MAX_AGE_SECONDS}`);
        cacheHeaders.set(HOMEPAGE_CACHE_GENERATED_AT_HEADER, `${generatedAt}`);
        cacheHeaders.delete('Set-Cookie');
        const cacheResp = trace
          ? trace.time(
              'cache_resp_build',
              () => new Response(injected, { status: 200, headers: cacheHeaders }),
            )
          : new Response(injected, { status: 200, headers: cacheHeaders });

        try {
          if (!trace || trace.mode !== 'bypass-cache') {
            ctx.waitUntil(caches.default.put(cacheKey, cacheResp).catch(() => undefined));
          } else if (trace) {
            trace.setLabel('cache_put', 'skip');
          }
        } catch {
          // Ignore cache write failures. The injected HTML response is still usable and
          // the worker should never throw a 1101 just because the cache rejected a put.
        }
        if (trace) {
          trace.setLabel('path', 'inject');
          trace.setLabel('age', age);
          trace.setLabel('html_chars', injected.length);
          trace.setLabel('payload_chars', snapshotInlineJson.length);
        }
        return finalizeTraceResponse(resp, trace);
      }

      // Default: serve static assets.
      const assetResp = await env.ASSETS.fetch(request);

      // SPA fallback for client-side routes.
      if (wantsHtml && assetResp.status === 404) {
        const indexResp = await fetchIndexHtml(env, url);
        const html = await indexResp.text();

        const headers = sanitizeHtmlResponseHeaders(indexResp.headers);
        headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.append('Vary', 'Accept');
        headers.delete('Location');

        return new Response(html, { status: 200, headers });
      }

      return assetResp;
    } catch (err) {
      try {
        console.error('pages worker: unhandled error', err);
      } catch {
        // ignore
      }

      if (resolvedApiPath) {
        return finalizeTraceResponse(
          applySensitiveProxyResponsePolicy(
            applyApiCorsHeaders(
              jsonError(500, 'INTERNAL', 'Internal Server Error'),
              request,
              resolvedApiPath.canonicalPathname,
            ),
            request,
          ),
          trace,
        );
      }

      // Best-effort fallback for HTML navigation so we never surface a 1101.
      try {
        const wantsHtml = request.method === 'GET' && acceptsHtml(request);
        const isStatusPage = url.pathname === '/' || url.pathname === '/index.html';

        if (wantsHtml) {
          if (isStatusPage) {
            try {
              const cacheKey = new Request(url.origin + '/', { method: 'GET' });
              const cached = await caches.default.match(cacheKey);
              if (cached) {
                const now = Math.floor(Date.now() / 1000);
                const cachedGeneratedAt = readGeneratedAtHeader(cached);
                if (cachedGeneratedAt === null) return buildSanitizedHtmlResponse(cached);
                const cachedAge = computeHomepageAge(now, cachedGeneratedAt);
                if (cachedAge !== null && canServeCachedHomepageFallback(cachedAge)) {
                  return buildHomepageCacheHit(cached, cachedAge);
                }
              }
            } catch {
              // ignore
            }
          }

          try {
            const indexResp = await fetchIndexHtml(env, url);
            const html = await indexResp.text();
            const headers = sanitizeHtmlResponseHeaders(indexResp.headers);
            headers.set('Content-Type', 'text/html; charset=utf-8');
            headers.append('Vary', 'Accept');
            headers.delete('Location');
            headers.set('Cache-Control', 'no-store');
            return new Response(html, { status: 200, headers });
          } catch {
            // ignore
          }

          return new Response(buildMinimalIndexHtml('Uptimer'), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              Vary: 'Accept',
            },
          });
        }
      } catch {
        // ignore
      }

      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
