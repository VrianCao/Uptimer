import { afterEach, describe, expect, it, vi } from 'vitest';

import pageWorker from '../../web/public/_worker.js';

type CacheMatcher = (request: Request) => Response | undefined;

function installDefaultCacheMock(
  match: CacheMatcher,
  opts: { putImpl?: (request: Request, response: Response) => Promise<void> | void } = {},
) {
  const put = vi.fn(async (request: Request, response: Response) => {
    await opts.putImpl?.(request, response);
  });

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return match(request)?.clone();
        },
        put,
      },
    },
  });

  return { put };
}

function makeEnv(
  indexHtml = '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
) {
  return {
    ASSETS: {
      fetch: vi.fn(async () => new Response(indexHtml, { status: 200 })),
    },
    UPTIMER_API_ORIGIN: 'https://api.example.com',
  };
}

describe('pages homepage worker', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    }

    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('serves cached injected HTML without calling the homepage API', async () => {
    installDefaultCacheMock((request) =>
      request.url === 'https://status.example.com/'
        ? new Response('<html>cached homepage</html>', {
            status: 200,
            headers: { 'Set-Cookie': 'session=1' },
          })
        : undefined,
    );
    const env = makeEnv();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(await res.text()).toContain('cached homepage');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recomputes cache-control on cache hit with generated-at header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:01:00.000Z'));

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const generatedAt = nowSec - 10;

      installDefaultCacheMock((request) =>
        request.url === 'https://status.example.com/'
          ? new Response('<html>cached homepage</html>', {
              status: 200,
              headers: {
                'X-Uptimer-Generated-At': String(generatedAt),
                'Cache-Control': 'public, max-age=600',
              },
            })
          : undefined,
      );
      const env = makeEnv();
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as never;

      const res = await pageWorker.fetch(
        new Request('https://status.example.com/', {
          headers: { Accept: 'text/html' },
        }),
        env,
        { waitUntil: vi.fn() },
      );

      expect(await res.text()).toContain('cached homepage');
      expect(res.headers.get('X-Uptimer-Generated-At')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe(
        'public, max-age=30, stale-while-revalidate=20, stale-if-error=20',
      );
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the cached injected homepage when snapshot fetch fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:10:00.000Z'));

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      installDefaultCacheMock((request) =>
        request.url === 'https://status.example.com/'
          ? new Response('<html>fallback homepage</html>', {
              status: 200,
              headers: { 'X-Uptimer-Generated-At': String(nowSec - 120) },
            })
          : undefined,
      );
      const env = makeEnv();
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network failed');
      }) as never;

      const res = await pageWorker.fetch(
        new Request('https://status.example.com/', {
          headers: { Accept: 'text/html' },
        }),
        env,
        { waitUntil: vi.fn() },
      );

      expect(await res.text()).toContain('fallback homepage');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not serve an over-stale cached homepage when snapshot fetch fails', async () => {
    installDefaultCacheMock((request) =>
      request.url === 'https://status.example.com/'
        ? new Response('<html>stale fallback homepage</html>', {
            status: 200,
            headers: { 'X-Uptimer-Generated-At': '0' },
          })
        : undefined,
    );
    const env = makeEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network failed');
    }) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    const html = await res.text();
    expect(html).not.toContain('stale fallback homepage');
    expect(html).toContain('<div id="root"></div>');
  });

  it('injects the precomputed homepage artifact and updates the html cache on success', async () => {
    const { put } = installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            generated_at: 1_728_000_000,
            preload_html: '<div id="uptimer-preload"><main>artifact preload</main></div>',
            snapshot_json: JSON.stringify({ site_title: 'Status Hub' }),
            meta_title: 'Status Hub',
            meta_description: 'Production',
          }),
          { status: 200 },
        ),
    ) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn((promise) => promise) },
    );

    const html = await res.text();
    expect(html).toContain('__UPTIMER_INITIAL_HOMEPAGE__');
    expect(html).not.toContain('__UPTIMER_INITIAL_STATUS__');
    expect(html).toContain('artifact preload');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('sanitizes string snapshot_json payloads before inlining them into html', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            generated_at: 1_728_000_000,
            preload_html: '<div id="uptimer-preload"><main>artifact preload</main></div>',
            snapshot_json:
              '{"site_title":"Status Hub","note":"</script><script>globalThis.pwned=1</script>"}',
            meta_title: 'Status Hub',
            meta_description: 'Production',
          }),
          { status: 200 },
        ),
    ) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn((promise) => promise) },
    );

    const html = await res.text();
    expect(html).toContain('__UPTIMER_INITIAL_HOMEPAGE__');
    expect(html).toContain('\\u003c/script>\\u003cscript>globalThis.pwned=1\\u003c/script>');
    expect(html).not.toContain('</script><script>globalThis.pwned=1</script>');
  });

  it('rejects homepage artifacts whose preload_html contains executable markup', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            generated_at: 1_728_000_000,
            preload_html:
              '<div id="uptimer-preload"><img src=x onerror="globalThis.pwned=1" /></div>',
            snapshot_json: JSON.stringify({ site_title: 'Status Hub' }),
            meta_title: 'Status Hub',
            meta_description: 'Production',
          }),
          { status: 200 },
        ),
    ) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn((promise) => promise) },
    );

    const html = await res.text();
    expect(html).not.toContain('__UPTIMER_INITIAL_HOMEPAGE__');
    expect(html).not.toContain('onerror=');
    expect(html).toContain('<div id="root"></div>');
  });

  it('rejects future-dated homepage artifacts from the api before injecting them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:01:00.000Z'));

    try {
      installDefaultCacheMock(() => undefined);
      const env = makeEnv();
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              generated_at: nowSec + 3_600,
              preload_html: '<div id="uptimer-preload"><main>artifact preload</main></div>',
              snapshot_json: JSON.stringify({ site_title: 'Status Hub' }),
              meta_title: 'Status Hub',
              meta_description: 'Production',
            }),
            { status: 200 },
          ),
      ) as never;

      const res = await pageWorker.fetch(
        new Request('https://status.example.com/', {
          headers: { Accept: 'text/html' },
        }),
        env,
        { waitUntil: vi.fn((promise) => promise) },
      );

      const html = await res.text();
      expect(html).not.toContain('artifact preload');
      expect(html).not.toContain('__UPTIMER_INITIAL_HOMEPAGE__');
      expect(html).toContain('<div id="root"></div>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores cached homepage entries whose generated-at header is implausibly in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:01:00.000Z'));

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      installDefaultCacheMock((request) =>
        request.url === 'https://status.example.com/'
          ? new Response('<html>future cached homepage</html>', {
              status: 200,
              headers: {
                'X-Uptimer-Generated-At': String(nowSec + 3_600),
              },
            })
          : undefined,
      );
      const env = makeEnv();
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network failed');
      }) as never;

      const res = await pageWorker.fetch(
        new Request('https://status.example.com/', {
          headers: { Accept: 'text/html' },
        }),
        env,
        { waitUntil: vi.fn() },
      );

      const html = await res.text();
      expect(html).not.toContain('future cached homepage');
      expect(html).toContain('<div id="root"></div>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when the html cache put fails and strips set-cookie from cached response', async () => {
    const { put } = installDefaultCacheMock(() => undefined, {
      putImpl: () => {
        throw new Error('cache rejected put');
      },
    });
    const env = makeEnv();
    env.ASSETS.fetch = vi.fn(
      async () =>
        new Response(
          '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
          {
            status: 200,
            headers: { 'Set-Cookie': 'cf=1' },
          },
        ),
    );

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            generated_at: 1_728_000_000,
            preload_html: '<div id="uptimer-preload"><main>artifact preload</main></div>',
            snapshot_json: JSON.stringify({ site_title: 'Status Hub' }),
            meta_title: 'Status Hub',
            meta_description: 'Production',
          }),
          { status: 200 },
        ),
    ) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn((promise) => promise) },
    );

    const html = await res.text();
    expect(html).toContain('__UPTIMER_INITIAL_HOMEPAGE__');
    expect(html).toContain('artifact preload');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(put).toHaveBeenCalledTimes(1);

    const cachedResponse = vi.mocked(put).mock.calls[0]?.[1];
    expect(cachedResponse?.headers.get('Set-Cookie')).toBeNull();
  });

  it('strips Set-Cookie from fallback html responses served directly to the browser', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    env.ASSETS.fetch = vi.fn(
      async () =>
        new Response(
          '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
          {
            status: 200,
            headers: { 'Set-Cookie': 'cf=1' },
          },
        ),
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network failed');
    }) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('never throws a 1101 for HTML navigations when the asset pipeline errors', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    env.ASSETS.fetch = vi.fn(async () => {
      throw new Error('asset fetch failed');
    });

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/', {
        headers: { Accept: 'text/html' },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('proxies api requests with the original method and preserves upstream status', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.example.com/api/v1/admin/monitors/1');
      return new Response('denied', {
        status: 405,
        headers: { Allow: 'PATCH, OPTIONS' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/admin/monitors/1', {
        method: 'PATCH',
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('PATCH, OPTIONS');
    expect(await res.text()).toBe('denied');
  });

  it('redirects legacy api paths to the versioned route before proxying', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/public/status', {
        headers: {
          Origin: 'https://status-web.example.com',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://status.example.com/api/v1/public/status');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects non-GET requests on legacy GET-only api paths before redirecting them', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/public/status', {
        method: 'PATCH',
        headers: {
          Origin: 'https://status-web.example.com',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('Location')).toBeNull();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('answers legacy api preflight requests locally instead of redirecting them', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/public/status', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://status-web.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('Location')).toBeNull();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('forces private no-store on sensitive legacy api redirects', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/public/status', {
        headers: {
          Origin: 'https://status-web.example.com',
          Authorization: 'Bearer test-admin-token',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(308);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('forces private no-store on sensitive api preflight responses', async () => {
    installDefaultCacheMock(() => undefined);
    const env = {
      ...makeEnv(),
      UPTIMER_TRACE_TOKEN: 'expected-trace-token',
    };
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/public/status', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://status-web.example.com',
          'Access-Control-Request-Method': 'GET',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Token': 'expected-trace-token',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('X-Uptimer-Trace-Token');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('advertises GET-only preflight methods for the public health endpoint', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://status-web.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('normalizes repeated slashes before proxying api requests', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.example.com/api/v1/public/status');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api//v1/public//status//'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('blocks internal api paths at the pages proxy boundary', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal/refresh/homepage'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks percent-decoded internal api paths at the pages proxy boundary', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal%2Frefresh%2Fhomepage'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks internal api paths after stripping control characters during canonicalization', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal%0A/refresh/homepage'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks internal api paths after dot-segment canonicalization', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/%252e%252e/internal/refresh/homepage'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks deeply percent-encoded internal api paths at the pages proxy boundary', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal%2525252Frefresh%2525252Fhomepage'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks internal api paths when malformed percent escapes are mixed into the pathname', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal%2Frefresh%2Fhomepage%ZZ'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('blocks dot-segment internal escapes even when malformed percent escapes are appended', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request(
        'https://status.example.com/api/v1/public/%252e%252e/internal/refresh/homepage%ZZ',
      ),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects internal api preflight requests at the pages boundary', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/internal/refresh/homepage', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://status-web.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('refuses to forward Authorization to an untrusted api origin', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/admin/monitors', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer test-admin-token',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(503);
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'API_ORIGIN_UNTRUSTED_FOR_SENSITIVE_HEADERS',
      },
    });
  });

  it('applies API CORS headers to local proxy errors', async () => {
    installDefaultCacheMock(() => undefined);
    const env = {
      ...makeEnv(),
      UPTIMER_API_ORIGIN: '',
    };
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Origin: 'https://status-web.example.com',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'API_ORIGIN_NOT_CONFIGURED',
      },
    });
  });

  it('returns a local JSON api error instead of surfacing a proxy fetch exception', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('upstream boom');
    }) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Origin: 'https://status-web.example.com',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'INTERNAL',
        message: 'Internal Server Error',
      },
    });
  });

  it('refuses to forward trace tokens to an untrusted api origin', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        method: 'GET',
        headers: {
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Token': 'trace-secret',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(503);
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'API_ORIGIN_UNTRUSTED_FOR_SENSITIVE_HEADERS',
      },
    });
  });

  it('forwards sensitive headers to the configured sensitive api origin', async () => {
    installDefaultCacheMock(() => undefined);
    const env = {
      ...makeEnv(),
      UPTIMER_API_ORIGIN: 'https://public-api.example.com',
      UPTIMER_API_SENSITIVE_ORIGIN: 'https://worker.example.workers.dev',
    };
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://worker.example.workers.dev/api/v1/public/status');
      expect(request.headers.get('Authorization')).toBe('Bearer test-admin-token');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Authorization: 'Bearer test-admin-token',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('does not allow proxied api requests to auto-follow upstream redirects', async () => {
    installDefaultCacheMock(() => undefined);
    const env = {
      ...makeEnv(),
      UPTIMER_API_ORIGIN: 'https://public-api.example.com',
      UPTIMER_API_SENSITIVE_ORIGIN: 'https://worker.example.workers.dev',
    };
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://worker.example.workers.dev/api/v1/public/status');
      expect(request.redirect).toBe('manual');
      return new Response('redirecting', {
        status: 302,
        headers: {
          Location: 'https://malicious.example.test/steal',
          'Set-Cookie': 'session=1',
        },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Authorization: 'Bearer test-admin-token',
          Origin: 'https://status-web.example.com',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://status-web.example.com');
    expect(res.headers.get('Vary')).toContain('Authorization');
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'UPSTREAM_REDIRECT_BLOCKED',
      },
    });
  });

  it('strips hop-by-hop headers from proxied api responses', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            Connection: 'keep-alive, X-Up',
            'Keep-Alive': 'timeout=5',
            'Proxy-Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'X-Up': 'secret',
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
    ) as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Connection')).toBeNull();
    expect(res.headers.get('Keep-Alive')).toBeNull();
    expect(res.headers.get('Proxy-Connection')).toBeNull();
    expect(res.headers.get('Transfer-Encoding')).toBeNull();
    expect(res.headers.get('X-Up')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('rejects insecure non-local http sensitive origins for sensitive proxy headers', async () => {
    installDefaultCacheMock(() => undefined);
    const env = {
      ...makeEnv(),
      UPTIMER_API_ORIGIN: 'https://public-api.example.com',
      UPTIMER_API_SENSITIVE_ORIGIN: 'http://worker.example.workers.dev',
    };
    const upstreamFetch = vi.fn();
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Authorization: 'Bearer test-admin-token',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'API_ORIGIN_UNTRUSTED_FOR_SENSITIVE_HEADERS',
      },
    });
  });

  it('treats empty Authorization and trace token headers as absent when proxying', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.example.com/api/v1/public/status');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Authorization: '   ',
          'X-Uptimer-Trace': '1',
          'X-Uptimer-Trace-Token': '   ',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('strips sensitive forwarding and hop-by-hop headers before proxying api requests', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.example.com/api/v1/public/status');
      expect(request.headers.get('Cookie')).toBeNull();
      expect(request.headers.get('CF-Access-Jwt-Assertion')).toBeNull();
      expect(request.headers.get('CF-Connecting-IP')).toBeNull();
      expect(request.headers.get('CF-Connecting-IPv6')).toBeNull();
      expect(request.headers.get('CF-IPCountry')).toBeNull();
      expect(request.headers.get('CF-Pseudo-IPv4')).toBeNull();
      expect(request.headers.get('Proxy-Authorization')).toBeNull();
      expect(request.headers.get('X-Forwarded-For')).toBeNull();
      expect(request.headers.get('Connection')).toBeNull();
      expect(request.headers.get('Transfer-Encoding')).toBeNull();
      expect(request.headers.get('TE')).toBeNull();
      expect(request.headers.get('Upgrade')).toBeNull();
      expect(request.headers.get('Trailer')).toBeNull();
      expect(request.headers.get('Keep-Alive')).toBeNull();
      expect(request.headers.get('Proxy-Connection')).toBeNull();
      expect(request.headers.get('Accept')).toBe('application/json');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Accept: 'application/json',
          Cookie: 'session=1',
          'CF-Access-Jwt-Assertion': 'jwt',
          'CF-Connecting-IP': '198.51.100.20',
          'CF-Connecting-IPv6': '2001:db8::1',
          'CF-IPCountry': 'US',
          'CF-Pseudo-IPv4': '192.0.2.10',
          'Proxy-Authorization': 'Basic abc',
          Connection: 'keep-alive',
          'Transfer-Encoding': 'chunked',
          TE: 'trailers',
          Upgrade: 'websocket',
          Trailer: 'Expires',
          'Keep-Alive': 'timeout=5',
          'Proxy-Connection': 'keep-alive',
          'X-Forwarded-For': '198.51.100.10',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('strips headers dynamically nominated by the Connection header before proxying', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.example.com/api/v1/public/status');
      expect(request.headers.get('X-Internal-Auth')).toBeNull();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status', {
        headers: {
          Connection: 'keep-alive, X-Internal-Auth',
          'X-Internal-Auth': 'secret',
        },
      }),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('strips Set-Cookie from proxied api responses', async () => {
    installDefaultCacheMock(() => undefined);
    const env = makeEnv();
    const upstreamFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': 'session=1; HttpOnly; Secure',
          },
        }),
    );
    globalThis.fetch = upstreamFetch as never;

    const res = await pageWorker.fetch(
      new Request('https://status.example.com/api/v1/public/status'),
      env,
      { waitUntil: vi.fn() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });
});
