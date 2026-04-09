import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/snapshots', () => ({
  refreshPublicHomepageSnapshotIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));

import type { Env } from '../src/env';
import { handleError, handleNotFound } from '../src/middleware/errors';
import { adminRoutes } from '../src/routes/admin';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type StoredMonitorRow = {
  id: number;
  name: string;
  type: 'http' | 'tcp';
  target: string;
  interval_sec: number;
  timeout_ms: number;
  http_method: string | null;
  http_headers_json: string | null;
  http_body: string | null;
  expected_status_json: string | null;
  response_keyword: string | null;
  response_keyword_mode: 'contains' | 'regex' | null;
  response_forbidden_keyword: string | null;
  response_forbidden_keyword_mode: 'contains' | 'regex' | null;
  group_name: string | null;
  group_sort_order: number;
  sort_order: number;
  show_on_status_page: number;
  is_active: number;
  created_at: number;
  updated_at: number;
};

function monitorRowToRaw(row: StoredMonitorRow): unknown[] {
  return [
    row.id,
    row.name,
    row.type,
    row.target,
    row.interval_sec,
    row.timeout_ms,
    row.http_method,
    row.http_headers_json,
    row.http_body,
    row.expected_status_json,
    row.response_keyword,
    row.response_keyword_mode,
    row.response_forbidden_keyword,
    row.response_forbidden_keyword_mode,
    row.group_name,
    row.group_sort_order,
    row.sort_order,
    row.show_on_status_page,
    row.is_active,
    row.created_at,
    row.updated_at,
  ];
}

function createAdminApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.route('/api/v1/admin', adminRoutes);
  return app;
}

function createEnv(monitorsById: Map<number, StoredMonitorRow>): Env {
  let nextMonitorId = 1000;

  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'select group_sort_order from monitors',
      first: () => null,
    },
    {
      match: 'insert into "monitors"',
      raw: (args) => {
        const row: StoredMonitorRow = {
          id: nextMonitorId,
          name: String(args[0]),
          type: String(args[1]) as 'http' | 'tcp',
          target: String(args[2]),
          interval_sec: Number(args[3]),
          timeout_ms: Number(args[4]),
          http_method: (args[5] as string | null) ?? null,
          http_headers_json: (args[6] as string | null) ?? null,
          http_body: (args[7] as string | null) ?? null,
          expected_status_json: (args[8] as string | null) ?? null,
          response_keyword: (args[9] as string | null) ?? null,
          response_keyword_mode: (args[10] as StoredMonitorRow['response_keyword_mode']) ?? null,
          response_forbidden_keyword: (args[11] as string | null) ?? null,
          response_forbidden_keyword_mode:
            (args[12] as StoredMonitorRow['response_forbidden_keyword_mode']) ?? null,
          group_name: (args[13] as string | null) ?? null,
          group_sort_order: Number(args[14]),
          sort_order: Number(args[15]),
          show_on_status_page: Number(args[16]),
          is_active: Number(args[17]),
          created_at: Number(args[18]),
          updated_at: Number(args[19]),
        };
        monitorsById.set(row.id, row);
        nextMonitorId += 1;
        return [monitorRowToRaw(row)];
      },
    },
    {
      match: 'from "monitors" where "monitors"."id" = ?',
      raw: (args) => {
        const id = Number(args[0]);
        const row = monitorsById.get(id);
        return row ? [monitorRowToRaw(row)] : [];
      },
    },
  ];

  return {
    DB: createFakeD1Database(handlers),
    ADMIN_TOKEN: 'test-admin-token',
    ADMIN_RATE_LIMIT_MAX: '100',
    ADMIN_RATE_LIMIT_WINDOW_SEC: '60',
  } as unknown as Env;
}

async function requestAdmin(
  app: ReturnType<typeof createAdminApp>,
  env: Env,
  path: string,
  init: {
    method?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers({
    Authorization: 'Bearer test-admin-token',
  });
  let body: string | undefined;

  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  }

  return app.fetch(
    new Request(`https://status.example.com${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

describe('admin monitor response assertion routes', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('persists explicit assertion modes and reuses them for manual monitor tests', async () => {
    vi.useFakeTimers();
    const app = createAdminApp();
    const monitorsById = new Map<number, StoredMonitorRow>();
    const env = createEnv(monitorsById);

    const createRes = await requestAdmin(app, env, '/api/v1/admin/monitors', {
      method: 'POST',
      body: {
        name: 'Regex API',
        type: 'http',
        target: 'https://example.com/health',
        response_keyword: 'ready:\\d+',
        response_keyword_mode: 'regex',
        response_forbidden_keyword: 'FAIL_[A-Z]+',
        response_forbidden_keyword_mode: 'regex',
      },
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      monitor: {
        id: number;
        response_keyword_mode: string | null;
        response_forbidden_keyword_mode: string | null;
      };
    };
    expect(created.monitor.response_keyword_mode).toBe('regex');
    expect(created.monitor.response_forbidden_keyword_mode).toBe('regex');

    const createdId = created.monitor.id;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('ready:42', { status: 200 }))
      .mockResolvedValueOnce(new Response('ready:42\nFAIL_TOKEN', { status: 200 }))
      .mockResolvedValueOnce(new Response('ready:42\nFAIL_TOKEN', { status: 200 }))
      .mockResolvedValueOnce(new Response('ready:42\nFAIL_TOKEN', { status: 200 }))
      .mockResolvedValueOnce(new Response('starting up', { status: 200 }))
      .mockResolvedValueOnce(new Response('starting up', { status: 200 }))
      .mockResolvedValueOnce(new Response('starting up', { status: 200 })) as unknown as typeof fetch;

    const upRes = await requestAdmin(app, env, `/api/v1/admin/monitors/${createdId}/test`, {
      method: 'POST',
    });
    expect(upRes.status).toBe(200);
    await expect(upRes.json()).resolves.toMatchObject({
      result: {
        status: 'up',
        error: null,
      },
    });

    const forbiddenHitPromise = requestAdmin(app, env, `/api/v1/admin/monitors/${createdId}/test`, {
      method: 'POST',
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const forbiddenHitRes = await forbiddenHitPromise;
    expect(forbiddenHitRes.status).toBe(200);
    await expect(forbiddenHitRes.json()).resolves.toMatchObject({
      result: {
        status: 'down',
        error: 'Forbidden response regex matched',
      },
    });

    const requiredMissPromise = requestAdmin(app, env, `/api/v1/admin/monitors/${createdId}/test`, {
      method: 'POST',
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const requiredMissRes = await requiredMissPromise;
    expect(requiredMissRes.status).toBe(200);
    await expect(requiredMissRes.json()).resolves.toMatchObject({
      result: {
        status: 'down',
        error: 'Required response regex not matched',
      },
    });
  });

  it('rejects invalid regex patterns at API validation time', async () => {
    const app = createAdminApp();
    const env = createEnv(new Map());

    const res = await requestAdmin(app, env, '/api/v1/admin/monitors', {
      method: 'POST',
      body: {
        name: 'Bad Regex API',
        type: 'http',
        target: 'https://example.com/health',
        response_keyword: '(',
        response_keyword_mode: 'regex',
      },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/invalid regex/i),
      },
    });
  });

  it('rejects new HTTP-only assertion mode fields for tcp monitors on create and patch', async () => {
    const app = createAdminApp();
    const tcpMonitor: StoredMonitorRow = {
      id: 7,
      name: 'TCP Service',
      type: 'tcp',
      target: 'example.com:443',
      interval_sec: 60,
      timeout_ms: 5000,
      http_method: null,
      http_headers_json: null,
      http_body: null,
      expected_status_json: null,
      response_keyword: null,
      response_keyword_mode: null,
      response_forbidden_keyword: null,
      response_forbidden_keyword_mode: null,
      group_name: null,
      group_sort_order: 0,
      sort_order: 0,
      show_on_status_page: 1,
      is_active: 1,
      created_at: 1700000000,
      updated_at: 1700000000,
    };
    const env = createEnv(new Map([[tcpMonitor.id, tcpMonitor]]));

    const createRes = await requestAdmin(app, env, '/api/v1/admin/monitors', {
      method: 'POST',
      body: {
        name: 'TCP Create',
        type: 'tcp',
        target: 'example.com:5432',
        response_keyword: 'ready',
        response_keyword_mode: 'regex',
      },
    });
    expect(createRes.status).toBe(400);
    await expect(createRes.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/http_\* fields are not allowed for tcp monitors/i),
      },
    });

    const patchRes = await requestAdmin(app, env, `/api/v1/admin/monitors/${tcpMonitor.id}`, {
      method: 'PATCH',
      body: {
        response_keyword: 'ready',
        response_keyword_mode: 'regex',
      },
    });
    expect(patchRes.status).toBe(400);
    await expect(patchRes.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/http_\* fields are not allowed for tcp monitors/i),
      },
    });
  });
});
