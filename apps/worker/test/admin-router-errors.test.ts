import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/snapshots', () => ({
  refreshPublicHomepageSnapshotIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));

import type { Env } from '../src/env';
import type { ErrorResponse } from '../src/middleware/errors';
import { adminRoutes } from '../src/routes/admin';
import { createFakeD1Database } from './helpers/fake-d1';

const ADMIN_TOKEN = 'test-admin-token';

function createEnv(): Env {
  return {
    DB: createFakeD1Database([]),
    ADMIN_TOKEN,
    ADMIN_RATE_LIMIT_MAX: '1000',
    ADMIN_RATE_LIMIT_WINDOW_SEC: '60',
  } as unknown as Env;
}

// Production mounts this router by calling `adminRoutes.fetch()` with the `/api/v1/admin`
// prefix stripped (see rewriteAdminRequest in src/hono-app.ts). Exercising the router
// directly keeps these tests faithful to that mounting semantics.
async function fetchAdmin(
  path: string,
  init: {
    method?: string;
    token?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (init.token !== null) {
    headers.set('Authorization', `Bearer ${init.token ?? ADMIN_TOKEN}`);
  }

  let body: string | undefined;
  if (init.rawBody !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = init.rawBody;
  } else if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  }

  return adminRoutes.fetch(
    new Request(`https://status.example.com${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
    createEnv(),
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

async function expectJsonError(
  res: Response,
  status: number,
  code: string,
): Promise<ErrorResponse> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type') ?? '').toContain('application/json');

  // Parse defensively so a malformed body fails with a readable assertion instead of a
  // TypeError from property access.
  const payload = (await res.json().catch(() => null)) as ErrorResponse | null;
  expect(payload?.error?.code).toBe(code);
  expect(typeof payload?.error?.message).toBe('string');

  if (!payload) {
    throw new Error('Expected a JSON error payload');
  }
  return payload;
}

describe('admin router error handling', () => {
  it('returns 401 JSON when the Authorization header is missing', async () => {
    const res = await fetchAdmin('/monitors', { token: null });
    const payload = await expectJsonError(res, 401, 'UNAUTHORIZED');
    expect(payload.error.message).toBe('Unauthorized');
  });

  it('returns 401 JSON when the Bearer token is invalid on /auth/verify', async () => {
    const res = await fetchAdmin('/auth/verify', { token: 'wrong-token' });
    const payload = await expectJsonError(res, 401, 'UNAUTHORIZED');
    expect(payload.error.message).toBe('Unauthorized');
  });

  it('returns 400 JSON for Zod validation failures', async () => {
    const res = await fetchAdmin('/monitors', { method: 'POST', body: {} });
    const payload = await expectJsonError(res, 400, 'INVALID_ARGUMENT');
    // A ZodError's aggregate message is its JSON-encoded issue list, so the `"path"`
    // issue key distinguishes it from an AppError with a hand-written message.
    expect(payload.error.message).toContain('"path"');
  });

  it('returns 400 JSON naming the blocked TCP target reason', async () => {
    const res = await fetchAdmin('/monitors', {
      method: 'POST',
      body: { name: 'blocked', type: 'tcp', target: '[::1]:443' },
    });
    const payload = await expectJsonError(res, 400, 'INVALID_ARGUMENT');
    // `createMonitorInputSchema.superRefine` rejects loopback targets through
    // `validateTcpTarget`, so the message must carry that reason instead of being a
    // generic schema failure (e.g. the empty-body case above).
    expect(payload.error.message).toContain('target host is not allowed');
  });

  it('returns 400 JSON for AppErrors thrown inside route handlers', async () => {
    const res = await fetchAdmin('/monitors/groups/reorder', {
      method: 'POST',
      rawBody: '{not valid json',
    });
    const payload = await expectJsonError(res, 400, 'INVALID_ARGUMENT');
    expect(payload.error.message).toBe('Invalid JSON body');
  });

  it('returns 400 JSON for errors thrown by .route()-mounted sub-routers', async () => {
    // Mounted at `/analytics`; the invalid range fails Zod validation before any DB access.
    const res = await fetchAdmin('/analytics/overview?range=bogus');
    const payload = await expectJsonError(res, 400, 'INVALID_ARGUMENT');
    expect(payload.error.message).toContain('Invalid enum value');
  });

  it('returns 404 JSON for unknown admin paths with a valid token', async () => {
    const res = await fetchAdmin('/does-not-exist');
    const payload = await expectJsonError(res, 404, 'NOT_FOUND');
    expect(payload.error.message).toBe('Not Found');
  });

  it('returns 404 JSON for the admin root path (rewritten `/api/v1/admin`)', async () => {
    // `rewriteAdminRequest` maps `/api/v1/admin` to `/`, so the inner router's
    // notFound handler must own that path as well.
    const res = await fetchAdmin('/');
    const payload = await expectJsonError(res, 404, 'NOT_FOUND');
    expect(payload.error.message).toBe('Not Found');
  });
});
