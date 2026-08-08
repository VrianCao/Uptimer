import { Hono } from 'hono';
import { z } from 'zod';

import type { Env } from '../env';
import { AppError } from '../middleware/errors';
import { createStatusPageInputSchema, patchStatusPageInputSchema, normalizeCustomHostname, parseLogoUrlInput } from '../schemas/status-pages';
import { enqueueStatusPageRefreshes } from '../snapshots/status-page-refresh-queue';

function validateCustomHostname(value: string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  let normalized: string | null;
  try {
    normalized = normalizeCustomHostname(value);
  } catch (err) {
    throw new AppError(400, 'INVALID_ARGUMENT', `custom_hostname validation error: ${(err as Error)?.message ?? 'unknown'}`);
  }
  if (normalized === null) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'custom_hostname must be a bare ASCII hostname (no scheme, path, port, wildcard, IP, or localhost)');
  }
  return normalized;
}

function validateLogoUrl(value: string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = parseLogoUrlInput(value);
  if (normalized === null) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'logo_url must be an absolute http(s) URL of at most 2048 characters');
  }
  return normalized;
}

export const adminStatusPageRoutes = new Hono<{ Bindings: Env }>();

type StatusPageRow = {
  id: number;
  slug: string;
  name: string;
  title: string;
  description: string;
  custom_hostname: string | null;
  logo_url: string | null;
  is_public: number;
  created_at: number;
  updated_at: number;
};

function toApi(row: StatusPageRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    title: row.title,
    description: row.description,
    custom_hostname: row.custom_hostname ?? null,
    logo_url: row.logo_url ?? null,
    is_public: row.is_public === 1,
    monitor_ids: monitorIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

async function ensureMonitorsExist(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM monitors WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number }>();
  const found = new Set((results ?? []).map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `Monitor(s) not found: ${missing.join(', ')}`);
  }
}

async function listMonitorIds(db: D1Database, statusPageId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT monitor_id FROM status_page_monitors WHERE status_page_id = ?1 ORDER BY monitor_id`,
    )
    .bind(statusPageId)
    .all<{ monitor_id: number }>();
  return (results ?? []).map((row) => row.monitor_id);
}

async function replaceMonitorLinks(
  db: D1Database,
  statusPageId: number,
  monitorIds: number[],
  now: number,
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM status_page_monitors WHERE status_page_id = ?1').bind(statusPageId),
    ...monitorIds.map((monitorId) =>
      db
        .prepare(
          `
            INSERT INTO status_page_monitors (
              status_page_id, monitor_id, group_name, group_sort_order, sort_order, created_at
            )
            SELECT ?1, id, group_name, group_sort_order, sort_order, ?2
            FROM monitors
            WHERE id = ?3
          `,
        )
        .bind(statusPageId, now, monitorId),
    ),
  ];
  await db.batch(statements);
}

async function ensureCustomHostnameAvailable(
  db: D1Database,
  hostname: string | null,
  excludeId: number | null,
): Promise<void> {
  if (!hostname) return;
  let row: { id: number } | null;
  try {
    row = excludeId
      ? await db
          .prepare('SELECT id FROM status_pages WHERE custom_hostname = ?1 AND id != ?2')
          .bind(hostname, excludeId)
          .first<{ id: number }>()
      : await db
          .prepare('SELECT id FROM status_pages WHERE custom_hostname = ?1')
          .bind(hostname)
          .first<{ id: number }>();
  } catch (err) {
    throw new AppError(500, 'INTERNAL', `hostname check failed: ${(err as Error)?.message ?? 'unknown'}`);
  }
  if (row) {
    throw new AppError(409, 'CONFLICT', 'Status page custom hostname already exists');
  }
}

adminStatusPageRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `
      SELECT id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at
      FROM status_pages
      ORDER BY id
    `,
  ).all<StatusPageRow>();
  const pages = await Promise.all((results ?? []).map(async (row) => toApi(row, await listMonitorIds(c.env.DB, row.id))));
  return c.json({ status_pages: pages });
});

adminStatusPageRoutes.post('/', async (c) => {
  let input;
  try {
    input = createStatusPageInputSchema.parse(await c.req.json().catch(() => {
      throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
    }));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'INVALID_ARGUMENT', (err as Error)?.message ?? 'Invalid input');
  }
  input.custom_hostname = validateCustomHostname(input.custom_hostname);
  input.logo_url = validateLogoUrl(input.logo_url);
  const monitorIds = normalizeIds(input.monitor_ids);
  await ensureMonitorsExist(c.env.DB, monitorIds);
  const duplicate = await c.env.DB.prepare('SELECT id FROM status_pages WHERE slug = ?1')
    .bind(input.slug)
    .first<{ id: number }>();
  if (duplicate) throw new AppError(409, 'CONFLICT', 'Status page slug already exists');
  await ensureCustomHostnameAvailable(c.env.DB, input.custom_hostname, null);

  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    `
      INSERT INTO status_pages (slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      RETURNING id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at
    `,
  ).bind(
    input.slug,
    input.name,
    input.title,
    input.description,
    input.custom_hostname,
    input.logo_url,
    input.is_public ? 1 : 0,
    now,
  ).first<StatusPageRow>();
  if (!row) throw new AppError(500, 'INTERNAL', 'Failed to create status page');

  if (monitorIds.length > 0) {
    await replaceMonitorLinks(c.env.DB, row.id, monitorIds, now);
  }
  await enqueueStatusPageRefreshes(c.env.DB, [row.id], now, 'page-created');
  return c.json({ status_page: toApi(row, monitorIds) }, 201);
});

adminStatusPageRoutes.patch('/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  let input;
  try {
    input = patchStatusPageInputSchema.parse(await c.req.json().catch(() => {
      throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
    }));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'INVALID_ARGUMENT', (err as Error)?.message ?? 'Invalid input');
  }
  if (input.custom_hostname !== undefined) {
    input.custom_hostname = validateCustomHostname(input.custom_hostname);
  }
  if (input.logo_url !== undefined) {
    input.logo_url = validateLogoUrl(input.logo_url);
  }
  const existing = await c.env.DB.prepare(
    `SELECT id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at FROM status_pages WHERE id = ?1`,
  ).bind(id).first<StatusPageRow>();
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Status page not found');

  if (input.slug !== undefined && input.slug !== existing.slug) {
    const duplicate = await c.env.DB.prepare('SELECT id FROM status_pages WHERE slug = ?1 AND id != ?2')
      .bind(input.slug, id)
      .first<{ id: number }>();
    if (duplicate) throw new AppError(409, 'CONFLICT', 'Status page slug already exists');
  }

  const nextCustomHostname = input.custom_hostname === undefined ? existing.custom_hostname : input.custom_hostname;
  if (nextCustomHostname !== existing.custom_hostname) {
    await ensureCustomHostnameAvailable(c.env.DB, nextCustomHostname, id);
  }

  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    `
      UPDATE status_pages
      SET slug = ?1, name = ?2, title = ?3, description = ?4, custom_hostname = ?5, logo_url = ?6, is_public = ?7, updated_at = ?8
      WHERE id = ?9
      RETURNING id, slug, name, title, description, custom_hostname, logo_url, is_public, created_at, updated_at
    `,
  ).bind(
    input.slug ?? existing.slug,
    input.name ?? existing.name,
    input.title ?? existing.title,
    input.description ?? existing.description,
    nextCustomHostname,
    input.logo_url === undefined ? existing.logo_url : input.logo_url,
    input.is_public === undefined ? existing.is_public : input.is_public ? 1 : 0,
    now,
    id,
  ).first<StatusPageRow>();
  if (!row) throw new AppError(500, 'INTERNAL', 'Failed to update status page');

  const monitorIds = input.monitor_ids === undefined ? await listMonitorIds(c.env.DB, id) : normalizeIds(input.monitor_ids);
  if (input.monitor_ids !== undefined) {
    await ensureMonitorsExist(c.env.DB, monitorIds);
    await replaceMonitorLinks(c.env.DB, id, monitorIds, now);
  }
  await enqueueStatusPageRefreshes(c.env.DB, [id], now, 'page-updated');
  return c.json({ status_page: toApi(row, monitorIds) });
});

adminStatusPageRoutes.delete('/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT id FROM status_pages WHERE id = ?1').bind(id).first<{ id: number }>();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Status page not found');

  const [monitorLink, incidentLink, maintenanceLink] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM status_page_monitors WHERE status_page_id = ?1').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM status_page_incidents WHERE status_page_id = ?1').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM status_page_maintenance_windows WHERE status_page_id = ?1').bind(id).first<{ count: number }>(),
  ]);
  if ((monitorLink?.count ?? 0) > 0 || (incidentLink?.count ?? 0) > 0 || (maintenanceLink?.count ?? 0) > 0) {
    throw new AppError(409, 'CONFLICT', 'Unlink monitors, incidents, and maintenance windows before deleting the status page');
  }

  await c.env.DB.prepare('DELETE FROM status_pages WHERE id = ?1').bind(id).run();
  return c.json({ deleted: true });
});
