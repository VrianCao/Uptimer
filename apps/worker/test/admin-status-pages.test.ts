import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../src/env';
import { handleError, handleNotFound } from '../src/middleware/errors';
import { adminStatusPageRoutes } from '../src/routes/admin-status-pages';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.onError(handleError);
  instance.notFound(handleNotFound);
  instance.route('/api/v1/admin/status-pages', adminStatusPageRoutes);
  return instance;
}

function env(handlers: FakeD1QueryHandler[]): Env {
  return {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
    ADMIN_RATE_LIMIT_MAX: '100',
    ADMIN_RATE_LIMIT_WINDOW_SEC: '60',
  } as unknown as Env;
}

function request(
  instance: ReturnType<typeof app>,
  bindings: Env,
  path: string,
  body: unknown,
): Promise<Response> {
  return instance.fetch(
    new Request(`https://status.example.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    bindings,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

function patchRequest(
  instance: ReturnType<typeof app>,
  bindings: Env,
  id: number,
  body: unknown,
): Promise<Response> {
  return instance.fetch(
    new Request(`https://status.example.test/api/v1/admin/status-pages/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    bindings,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

describe('admin status page routes', () => {
  it('creates a page and atomically records monitor publication links', async () => {
    const inserts: unknown[][] = [];
    const queued: unknown[][] = [];
    const bindings = env([
      { match: 'select id from status_pages', first: () => null },
      { match: 'select id from monitors', all: () => [{ id: 7 }, { id: 9 }] },
      {
        match: 'insert into status_pages',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partner services',
          title: 'Partner status',
          description: '',
          is_public: 1,
          created_at: 10,
          updated_at: 10,
        }),
      },
      { match: 'delete from status_page_monitors', run: () => 1 },
      {
        match: 'insert into status_page_monitors',
        run: (args) => {
          inserts.push(args);
          return 1;
        },
      },
      {
        match: 'insert into status_page_refresh_queue',
        run: (args) => {
          queued.push(args);
          return 1;
        },
      },
    ]);

    const res = await request(app(), bindings, '/api/v1/admin/status-pages', {
      slug: 'partners',
      name: 'Partner services',
      title: 'Partner status',
      monitor_ids: [7, 9],
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      status_page: { id: 4, slug: 'partners', monitor_ids: [7, 9] },
    });
    expect(inserts).toHaveLength(2);
    expect(inserts.map((args) => [args[0], args[2]])).toEqual([[4, 7], [4, 9]]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject([4, expect.any(Number), 'page-created']);
  });

  it('rejects malformed slugs before writing a page', async () => {
    const res = await request(app(), env([]), '/api/v1/admin/status-pages', {
      slug: 'Partner Page',
      name: 'Partner services',
      title: 'Partner status',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('admin status page custom hostname', () => {
  it('creates a page with a normalized custom hostname', async () => {
    const bindings = env([
      { match: 'select id from status_pages', first: () => null },
      { match: 'select id from monitors', all: () => [{ id: 1 }] },
      { match: 'delete from status_page_monitors', run: () => 1 },
      { match: 'insert into status_page_monitors', run: () => 1 },
      {
        match: 'insert into status_pages',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partner services',
          title: 'Partner status',
          description: '',
          custom_hostname: 'status.partners.com',
          is_public: 1,
          created_at: 10,
          updated_at: 10,
        }),
      },
      { match: 'insert into status_page_refresh_queue', run: () => 1 },
    ]);

    const res = await request(app(), bindings, '/api/v1/admin/status-pages', {
      slug: 'partners',
      name: 'Partner services',
      title: 'Partner status',
      custom_hostname: 'STATUS.Partners.com.',
      monitor_ids: [1],
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      status_page: { id: 4, custom_hostname: 'status.partners.com' },
    });
  });

  it('returns CONFLICT when another page already owns the hostname', async () => {
    const bindings = env([
      { match: 'select id from status_pages', first: () => ({ id: 9 }) },
      { match: 'select id from monitors', all: () => [{ id: 1 }] },
    ]);

    const res = await request(app(), bindings, '/api/v1/admin/status-pages', {
      slug: 'partners',
      name: 'Partner services',
      title: 'Partner status',
      custom_hostname: 'taken.com',
      monitor_ids: [1],
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('patches and clears custom_hostname atomically', async () => {
    const seenHostnames: (string | null)[] = [];
    const bindings = env([
      {
        match: 'select id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at from status_pages where id = ?1',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partners',
          title: 'Partner status',
          description: '',
          custom_hostname: 'status.partners.com',
          logo_url: null,
          is_public: 1,
          created_at: 10,
          updated_at: 10,
        }),
      },
      { match: 'select id from status_pages', first: () => null },
      { match: 'select monitor_id from status_page_monitors', all: () => [] },
      {
        match: 'update status_pages',
        first: (_args, _sql) => {
          seenHostnames.push(_args[4] as string | null);
          return {
            id: 4,
            slug: 'partners',
            name: 'Partners',
            title: 'Partner status',
            description: '',
            custom_hostname: _args[4] as string | null,
            is_public: 1,
            created_at: 10,
            updated_at: 20,
          };
        },
      },
      { match: 'insert into status_page_refresh_queue', run: () => 1 },
    ]);

    const patchRes = await patchRequest(app(), bindings, 4, { custom_hostname: 'new.partners.com' });
    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toMatchObject({
      status_page: { custom_hostname: 'new.partners.com' },
    });

    const clearRes = await patchRequest(app(), bindings, 4, { custom_hostname: '' });
    expect(clearRes.status).toBe(200);
    await expect(clearRes.json()).resolves.toMatchObject({
      status_page: { custom_hostname: null },
    });
    expect(seenHostnames).toEqual(['new.partners.com', null]);
  });

  it('rejects an invalid hostname before writing', async () => {
    const res = await patchRequest(app(), env([]), 4, { custom_hostname: 'https://invalid.com' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('admin status page logo url', () => {
  it('creates a page with a logo url', async () => {
    const bindings = env([
      { match: 'select id from status_pages', first: () => null },
      { match: 'select id from monitors', all: () => [{ id: 1 }] },
      { match: 'delete from status_page_monitors', run: () => 1 },
      { match: 'insert into status_page_monitors', run: () => 1 },
      {
        match: 'insert into status_pages',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partner services',
          title: 'Partner status',
          description: '',
          custom_hostname: null,
          logo_url: 'https://cdn.example.com/logo.png',
          is_public: 1,
          created_at: 10,
          updated_at: 10,
        }),
      },
      { match: 'insert into status_page_refresh_queue', run: () => 1 },
    ]);

    const res = await request(app(), bindings, '/api/v1/admin/status-pages', {
      slug: 'partners',
      name: 'Partner services',
      title: 'Partner status',
      logo_url: 'https://cdn.example.com/logo.png',
      monitor_ids: [1],
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      status_page: { id: 4, logo_url: 'https://cdn.example.com/logo.png' },
    });
  });

  it('patches and clears logo_url atomically', async () => {
    const seenLogos: (string | null)[] = [];
    const bindings = env([
      {
        match: 'select id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at from status_pages where id = ?1',
        first: () => ({
          id: 4,
          slug: 'partners',
          name: 'Partners',
          title: 'Partner status',
          description: '',
          custom_hostname: null,
          logo_url: null,
          is_public: 1,
          created_at: 10,
          updated_at: 10,
        }),
      },
      { match: 'select monitor_id from status_page_monitors', all: () => [] },
      {
        match: 'update status_pages',
        first: (_args, _sql) => {
          seenLogos.push(_args[5] as string | null);
          return {
            id: 4,
            slug: 'partners',
            name: 'Partners',
            title: 'Partner status',
            description: '',
            custom_hostname: null,
            logo_url: _args[5] as string | null,
            is_public: 1,
            created_at: 10,
            updated_at: 20,
          };
        },
      },
      { match: 'insert into status_page_refresh_queue', run: () => 1 },
    ]);

    const patchRes = await patchRequest(app(), bindings, 4, {
      logo_url: 'https://cdn.example.com/new-logo.svg',
    });
    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toMatchObject({
      status_page: { logo_url: 'https://cdn.example.com/new-logo.svg' },
    });

    const clearRes = await patchRequest(app(), bindings, 4, { logo_url: '' });
    expect(clearRes.status).toBe(200);
    await expect(clearRes.json()).resolves.toMatchObject({
      status_page: { logo_url: null },
    });
    expect(seenLogos).toEqual(['https://cdn.example.com/new-logo.svg', null]);
  });

  it('rejects an invalid logo url before writing', async () => {
    const res = await patchRequest(app(), env([]), 4, { logo_url: 'not-a-url' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  });
});
