import assert from 'node:assert/strict';
import { z } from 'zod';

const project = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .parse(process.env.PAGES_PROJECT);
const base = `https://${project}.pages.dev`;
async function request(path, token) {
  const response = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  // Check only status/cache policy. Never print authenticated response bodies.
  await response.body?.cancel();
  return response;
}
assert.equal((await request('/api/v1/public/status')).status, 200);
assert.equal((await request('/api/v1/admin/settings')).status, 401);
assert.equal((await request('/api/v1/internal/scheduled/check-batch')).status, 404);
const token = process.env.UPTIMER_ADMIN_TOKEN;
if (token) {
  const response = await request('/api/v1/admin/settings', token);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  const authenticatedPublic = await request('/api/v1/public/status', token);
  assert.equal(authenticatedPublic.status, 200);
  assert.match(authenticatedPublic.headers.get('Cache-Control') ?? '', /no-store/);
}
console.log(
  JSON.stringify({
    publicStatus: 200,
    unauthenticatedAdmin: 401,
    internalRoutes: 404,
    authenticatedAdmin: token ? 200 : 'not checked: no local admin token',
  }),
);
