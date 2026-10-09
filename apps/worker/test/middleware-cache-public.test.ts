import { afterEach, describe, expect, it, vi } from 'vitest';

import { cachePublic } from '../src/middleware/cache-public';

type CacheStore = Map<string, Response>;

function installCacheMock(store: CacheStore) {
  const open = vi.fn(async () => ({
    async match(request: Request) {
      const cached = store.get(request.url);
      return cached ? cached.clone() : undefined;
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response.clone());
    },
  }));

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { open },
  });

  return open;
}

function makeContext(options: {
  method: string;
  url: string;
  response: Response;
  authorization?: string;
  waitUntil?: ReturnType<typeof vi.fn>;
}): {
  c: {
    req: { method: string; url: string; header(name: string): string | undefined };
    res: Response;
    executionCtx: { waitUntil: ReturnType<typeof vi.fn> };
  };
  waitUntil: ReturnType<typeof vi.fn>;
} {
  const waitUntil = options.waitUntil ?? vi.fn();
  const headers = new Headers();
  if (options.authorization) {
    headers.set('Authorization', options.authorization);
  }

  return {
    c: {
      req: {
        method: options.method,
        url: options.url,
        header(name: string) {
          return headers.get(name) ?? undefined;
        },
      },
      res: options.response,
      executionCtx: { waitUntil },
    },
    waitUntil,
  };
}

describe('middleware/cache-public', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    }
    vi.clearAllMocks();
  });

  it('returns cached responses immediately on cache hits', async () => {
    const store = new Map<string, Response>();
    const url = 'https://status.example.com/api/v1/public/status';
    store.set(url, new Response('cached', { status: 200 }));
    const open = installCacheMock(store);

    const middleware = cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 30 });
    const { c } = makeContext({
      method: 'GET',
      url,
      response: new Response('seed', { status: 200 }),
    });
    const next = vi.fn(async () => {
      c.res = new Response('live', { status: 200 });
    });

    const out = await middleware(c as never, next);
    expect(await (out as Response).text()).toBe('cached');
    expect(next).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('uptimer-public');
  });

  it('stores successful uncached responses and injects default cache-control', async () => {
    const store = new Map<string, Response>();
    const open = installCacheMock(store);
    const url = 'https://status.example.com/api/v1/public/incidents';

    const middleware = cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 45 });
    const { c, waitUntil } = makeContext({
      method: 'GET',
      url,
      response: new Response('seed', { status: 200 }),
    });
    const next = vi.fn(async () => {
      c.res = new Response('live', { status: 200 });
    });

    await middleware(c as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(c.res.headers.get('Cache-Control')).toBe('public, max-age=45');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await (waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    const stored = store.get(url);
    expect(stored).toBeDefined();
    expect(await stored?.text()).toBe('live');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('respects explicit no-store/private cache-control directives', async () => {
    const store = new Map<string, Response>();
    installCacheMock(store);
    const url = 'https://status.example.com/api/v1/public/uptime';
    const middleware = cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 45 });
    const { c, waitUntil } = makeContext({
      method: 'GET',
      url,
      response: new Response('seed', { status: 200 }),
    });

    await middleware(c as never, async () => {
      c.res = new Response('private', {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(store.get(url)).toBeUndefined();
  });

  it('bypasses cache middleware for non-GET requests', async () => {
    const store = new Map<string, Response>();
    const open = installCacheMock(store);
    const middleware = cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 45 });
    const { c, waitUntil } = makeContext({
      method: 'POST',
      url: 'https://status.example.com/api/v1/public/status',
      response: new Response('seed', { status: 200 }),
    });
    const next = vi.fn(async () => undefined);

    await middleware(c as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('bypasses shared cache for GET requests that carry Authorization', async () => {
    const store = new Map<string, Response>();
    const url = 'https://status.example.com/api/v1/public/status';
    store.set(url, new Response('cached-anon', { status: 200 }));
    const open = installCacheMock(store);
    const middleware = cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 45 });
    const { c, waitUntil } = makeContext({
      method: 'GET',
      url,
      authorization: 'Bearer secret-token',
      response: new Response('seed', { status: 200 }),
    });
    const next = vi.fn(async () => {
      c.res = new Response('live-admin', {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    });

    await middleware(c as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(await c.res.text()).toBe('live-admin');
    expect(await store.get(url)?.text()).toBe('cached-anon');
  });

  it('can normalize cache keys so irrelevant query params share the same cached response', async () => {
    const store = new Map<string, Response>();
    const open = installCacheMock(store);
    const middleware = cachePublic({
      cacheName: 'uptimer-public',
      maxAgeSeconds: 45,
      normalizeCacheKeyUrl: (url) => {
        const range = url.searchParams.get('range');
        if (range !== null && range !== '30d' && range !== '90d') {
          return;
        }

        url.search = '';
        if (range === '90d') {
          url.searchParams.set('range', '90d');
        }
      },
    });

    const first = makeContext({
      method: 'GET',
      url: 'https://status.example.com/api/v1/public/analytics/uptime?range=30d&probe=1',
      response: new Response('seed', { status: 200 }),
    });

    await middleware(first.c as never, async () => {
      first.c.res = new Response('live', { status: 200 });
    });
    expect(first.waitUntil).toHaveBeenCalledTimes(1);
    await (first.waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    const cached = store.get('https://status.example.com/api/v1/public/analytics/uptime');
    expect(cached).toBeDefined();
    expect(await cached?.clone().text()).toBe('live');

    const second = makeContext({
      method: 'GET',
      url: 'https://status.example.com/api/v1/public/analytics/uptime?range=30d&probe=2',
      response: new Response('seed', { status: 200 }),
    });
    const next = vi.fn(async () => {
      second.c.res = new Response('miss', { status: 200 });
    });

    const out = await middleware(second.c as never, next);
    expect(await (out as Response).text()).toBe('live');
    expect(next).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('uptimer-public');
  });
});
