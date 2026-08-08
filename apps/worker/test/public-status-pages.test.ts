import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../src/env';
import { AppError, handleError, handleNotFound } from '../src/middleware/errors';
import { publicRoutes } from '../src/routes/public';
import {
  assertStatusPageMonitor,
  resolveAccessibleStatusPage,
  resolvePublicStatusPage,
} from '../src/public/status-page';
import { createFakeD1Database } from './helpers/fake-d1';
import { readPageStatusSnapshotJson } from '../src/snapshots/public-status-read';

describe('public status page scope', () => {
  it('resolves a public slug and rejects an unknown or private page', async () => {
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: (args) =>
          args[0] === 'partners'
            ? { id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '', custom_hostname: null, logo_url: 'https://cdn.example.com/logo.png' }
            : null,
      },
    ]);

    await expect(resolvePublicStatusPage(db, 'partners')).resolves.toMatchObject({
      id: 4,
      logo_url: 'https://cdn.example.com/logo.png',
    });
    await expect(resolvePublicStatusPage(db, 'missing')).rejects.toMatchObject<AppError>({ status: 404 });
  });

  it('carries a page logo through the slug status payload and never leaks another page logo', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partners',
          title: 'Partner status',
          description: '',
          custom_hostname: null,
          logo_url: 'https://cdn.example.com/partners.png',
          is_public: 1,
        }),
      },
      {
        match: 'from monitors m',
        all: () => [],
      },
      { match: 'from incidents', all: () => [] },
      { match: 'from maintenance_windows', all: () => [] },
      { match: 'select value from settings', first: () => ({ value: '3' }) },
      { match: 'select key, value from settings', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/status-pages/partners/status'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      logo_url: 'https://cdn.example.com/partners.png',
      status_page: { slug: 'partners', logo_url: 'https://cdn.example.com/partners.png' },
    });
  });

  it('conceals a private slug unless administrator access is allowed', async () => {
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 5,
          slug: 'private',
          name: 'Private',
          title: 'Private status',
          description: '',
          custom_hostname: null,
          is_public: 0,
        }),
      },
    ]);

    await expect(resolveAccessibleStatusPage(db, 'private', false)).rejects.toMatchObject<AppError>({
      status: 404,
      code: 'NOT_FOUND',
    });
    await expect(resolveAccessibleStatusPage(db, 'private', true)).resolves.toMatchObject({
      id: 5,
      is_private: true,
    });
  });

  it('returns only the resolved page payload from the slug route', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({ id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '' }),
      },
      {
        match: 'from monitors m',
        all: () => [],
      },
      { match: 'from incidents', all: () => [] },
      { match: 'from maintenance_windows', all: () => [] },
      { match: 'select value from settings', first: () => ({ value: '3' }) },
      { match: 'select key, value from settings', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/status-pages/partners/status'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      site_title: 'Partner status',
      site_description: '',
      monitors: [],
      status_page: { slug: 'partners', name: 'Partners' },
    });
  });

  it('preserves __status_page in the analytics uptime cache key to prevent cross-page poisoning', async () => {
    const { normalizeAnalyticsUptimeCacheKeyUrl } = await import('../src/routes/public-ui-analytics');

    const pubUrl = new URL('https://example.com/api/v1/public/analytics/uptime?__status_page=pub');
    const privateUrl = new URL('https://example.com/api/v1/public/analytics/uptime?__status_page=private');
    normalizeAnalyticsUptimeCacheKeyUrl(pubUrl);
    normalizeAnalyticsUptimeCacheKeyUrl(privateUrl);

    expect(pubUrl.search).toContain('__status_page=pub');
    expect(privateUrl.search).toContain('__status_page=private');
    expect(pubUrl.search).not.toBe(privateUrl.search);
  });

  it('serves a private slug only with Admin authorization and never queues a snapshot write', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 5,
          slug: 'private',
          name: 'Private',
          title: 'Private status',
          description: '',
          custom_hostname: null,
          is_public: 0,
        }),
      },
      { match: 'from monitors m', all: () => [] },
      { match: 'from incidents', all: () => [] },
      { match: 'from maintenance_windows', all: () => [] },
      { match: 'select value from settings', first: () => ({ value: '3' }) },
      { match: 'select key, value from settings', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);
    const waitUntil = vi.fn();
    const env = { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env;
    const url = 'https://status.example.test/api/v1/public/status-pages/private/status';

    const anonymous = await app.fetch(new Request(url), env, { waitUntil } as unknown as ExecutionContext);
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get('Cache-Control')).toBe('private, no-store');

    const authorized = await app.fetch(
      new Request(url, { headers: { Authorization: 'Bearer test-admin-token' } }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('Cache-Control')).toBe('private, no-store');
    expect(authorized.headers.get('Vary')).toContain('Authorization');
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    '/api/v1/public/status-pages/private/status',
    '/api/v1/public/status-pages/private/incidents',
    '/api/v1/public/status-pages/private/maintenance-windows',
    '/api/v1/public/analytics/uptime?__status_page=private',
    '/api/v1/public/monitors/9/latency?range=24h&__status_page=private',
    '/api/v1/public/monitors/9/uptime?range=24h&__status_page=private',
    '/api/v1/public/monitors/9/outages?range=30d&__status_page=private',
    '/api/v1/public/monitors/9/day-context?day_start_at=1&__status_page=private',
  ])('conceals private page-scoped endpoint %s for missing and invalid tokens', async (path) => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 5,
          slug: 'private',
          name: 'Private',
          title: 'Private status',
          description: '',
          custom_hostname: null,
          is_public: 0,
        }),
      },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);
    const env = { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env;

    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const headers = authorization ? { Authorization: authorization } : undefined;
      const res = await app.fetch(
        new Request(`https://status.example.test${path}`, { headers }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('Vary')).toContain('Authorization');
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('keeps private custom hostname resolution public-only', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([{ match: 'from status_pages', first: () => null }]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);
    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/resolve-host?host=private.example.test', {
        headers: {
          Authorization: 'Bearer test-admin-token',
          'X-Forwarded-Host': 'public.example.test',
        },
      }),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it('conceals a private slug analytics uptime endpoint without shared caching for missing and invalid tokens', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 5,
          slug: 'private',
          name: 'Private',
          title: 'Private status',
          description: '',
          custom_hostname: null,
          is_public: 0,
        }),
      },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);
    const env = { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env;

    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const headers = authorization ? { Authorization: authorization } : undefined;
      const res = await app.fetch(
        new Request('https://status.example.test/api/v1/public/analytics/uptime?__status_page=private', { headers }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('Vary')).toContain('Authorization');
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('does not read a default snapshot for a different page', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: (args) => (args[0] === 'status:page:4' ? null : { generated_at: 190, body_json: '{}' }),
      },
    ]);

    await expect(readPageStatusSnapshotJson(db, 200, 4)).resolves.toBeNull();
  });

  it.each([
    ['/api/v1/public/status-pages/private/incidents', 'incidents'],
    ['/api/v1/public/status-pages/private/maintenance-windows', 'maintenance_windows'],
  ] as const)('serves authorized private collection %s without shared caching', async (path, key) => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({
          id: 5,
          slug: 'private',
          name: 'Private',
          title: 'Private status',
          description: '',
          custom_hostname: null,
          is_public: 0,
        }),
      },
      { match: (sql) => sql.includes('join status_page_incidents'), all: () => [] },
      { match: (sql) => sql.includes('join status_page_maintenance_windows'), all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);
    const res = await app.fetch(
      new Request(`https://status.example.test${path}`, {
        headers: { Authorization: 'Bearer test-admin-token' },
      }),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    await expect(res.json()).resolves.toMatchObject({ [key]: [] });
  });

  it('renders explicitly linked incidents without monitor links', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({ id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '' }),
      },
      {
        match: (sql) => sql.includes('join status_page_incidents'),
        all: () => [{ id: 11, title: 'Partner incident', status: 'investigating', impact: 'minor', message: null, started_at: 10, resolved_at: null }],
      },
      { match: 'from incident_updates', all: () => [] },
      { match: 'from incident_monitors', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/status-pages/partners/incidents'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      incidents: [{ id: 11, title: 'Partner incident', monitor_ids: [] }],
    });
  });

  it('renders explicitly linked maintenance windows without monitor links', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({ id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '' }),
      },
      {
        match: (sql) => sql.includes('join status_page_maintenance_windows'),
        all: () => [{ id: 12, title: 'Partner maintenance', message: null, starts_at: 10, ends_at: 20, created_at: 1 }],
      },
      { match: 'from maintenance_window_monitors', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/status-pages/partners/maintenance-windows'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      maintenance_windows: [{ id: 12, title: 'Partner maintenance', monitor_ids: [] }],
    });
  });

  it('filters analytics to the requested page monitor links', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({ id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '' }),
      },
      {
        match: (sql) => sql.includes('join status_page_monitors'),
        all: (args) => args[0] === 4 ? [] : [{ id: 99 }],
      },
      { match: 'from monitor_daily_rollups', all: () => [] },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/analytics/uptime?__status_page=partners'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ monitors: [] });
  });

  it('returns 404 before reading a monitor outside the requested page', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: vi.fn(async () => ({ match: async () => undefined, put: async () => undefined })) },
    });
    const db = createFakeD1Database([
      {
        match: 'from status_pages',
        first: () => ({ id: 4, slug: 'partners', name: 'Partners', title: 'Partner status', description: '' }),
      },
      { match: (sql) => sql.includes('join status_page_monitors'), first: () => null },
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.route('/api/v1/public', publicRoutes);

    const res = await app.fetch(
      new Request('https://status.example.test/api/v1/public/monitors/9/uptime?__status_page=partners'),
      { DB: db, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('rejects a monitor outside the resolved status page', async () => {
    const db = createFakeD1Database([
      {
        match: (sql) => sql.includes('join status_page_monitors'),
        first: (args) => (args[0] === 4 && args[1] === 7 ? { id: 7 } : null),
      },
    ]);

    await expect(assertStatusPageMonitor(db, 4, 7)).resolves.toEqual({ id: 7 });
    await expect(assertStatusPageMonitor(db, 4, 9)).rejects.toMatchObject<AppError>({ status: 404 });
  });
});
