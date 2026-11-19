import { queuePublicHomepageSnapshotRefresh } from '../public/queue-refresh';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  eq,
  type CustomWebhookChannelConfig,
  expectedStatusJsonSchema,
  forbiddenStatusJsonSchema,
  getDb,
  getTableColumns,
  httpHeadersJsonSchema,
  monitors,
  monitorState,
  parseDbJson,
  parseDbJsonNullable,
  serializeDbJson,
  serializeDbJsonNullable,
  type TelegramChannelConfig,
  type WpushChannelConfig,
  type WebhookChannelConfig,
  webhookChannelConfigSchema,
} from '@uptimer/db';

import type { Env } from '../env';
import { requireAdmin } from '../middleware/auth';
import { AppError, handleError, handleNotFound } from '../middleware/errors';
import { requireAdminRateLimit } from '../middleware/rate-limit';
import {
  bumpHomepageIncidentGuardVersion,
  bumpHomepageMaintenanceGuardVersion,
  bumpHomepageMonitorGuardVersions,
  bumpHomepageSettingsGuardVersion,
} from '../public/homepage-guard-state';
import { runHttpCheck } from '../monitor/http';
import {
  validateHttpResponseAssertionConfig,
  type HttpResponseMatchMode,
} from '../monitor/http-assertions';
import { validateHttpTarget, validateTcpTarget } from '../monitor/targets';
import { runTcpCheck } from '../monitor/tcp';
import {
  dispatchWebhookToChannelLegacy,
  dispatchWebhookToChannels,
  type WebhookChannel,
} from '../notify/webhook';
import { encryptTelegramBotToken } from '../notify/telegram-token';
import { encryptWpushApiKey } from '../notify/wpush-token';
import { adminAnalyticsRoutes } from './admin-analytics';
import { adminExportsRoutes } from './admin-exports';
import { adminSettingsRoutes } from './admin-settings';
import {
  createIncidentInputSchema,
  createIncidentUpdateInputSchema,
  resolveIncidentInputSchema,
} from '../schemas/incidents';
import {
  createMaintenanceWindowInputSchema,
  patchMaintenanceWindowInputSchema,
} from '../schemas/maintenance-windows';
import {
  assignMonitorsToGroupInputSchema,
  createMonitorInputSchema,
  patchMonitorInputSchema,
  reorderMonitorGroupsInputSchema,
} from '../schemas/monitors';
import {
  createNotificationChannelInputSchema,
  patchNotificationChannelInputSchema,
  type TelegramChannelCreateInput,
  type TelegramChannelPatchInput,
  type WpushChannelCreateInput,
  type WpushChannelPatchInput,
} from '../schemas/notification-channels';

export const adminRoutes = new Hono<{ Bindings: Env }>();

// Mounted via `adminRoutes.fetch()` (see src/hono-app.ts), not `app.route()`, so this
// router must own the shared JSON error/not-found handlers; Hono's defaults would
// otherwise return text/plain 500s for AppError/ZodErrors and text/plain 404s for
// unknown routes.
adminRoutes.onError(handleError);
adminRoutes.notFound(handleNotFound);

adminRoutes.use('*', requireAdminRateLimit);

// Lightweight token verification endpoint for the web UI.
//
// The admin UI is a static SPA and cannot know whether a token is valid without
// calling the Worker. Exposing a dedicated endpoint lets the UI validate a token
// before entering the admin panel.
adminRoutes.get('/auth/verify', requireAdmin, (c) => {
  return c.json({ ok: true });
});

adminRoutes.use('*', requireAdmin);

// Keep analytics endpoints in a separate router to reduce churn in this already-large file.
adminRoutes.route('/analytics', adminAnalyticsRoutes);
adminRoutes.route('/exports', adminExportsRoutes);
adminRoutes.route('/settings', adminSettingsRoutes);

function normalizeMonitorGroupName(groupName: string | null | undefined): string | null {
  const trimmed = groupName?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAssertionModeForStorage(
  value: string | null | undefined,
  mode: HttpResponseMatchMode | null | undefined,
): HttpResponseMatchMode | null {
  return typeof value === 'string' ? (mode ?? null) : null;
}

function throwOnInvalidHttpResponseAssertionConfig(input: {
  responseKeyword: string | null | undefined;
  responseKeywordMode: HttpResponseMatchMode | null | undefined;
  responseForbiddenKeyword: string | null | undefined;
  responseForbiddenKeywordMode: HttpResponseMatchMode | null | undefined;
}) {
  const issues = validateHttpResponseAssertionConfig(input);
  if (issues.length === 0) return;

  throw new AppError(400, 'INVALID_ARGUMENT', issues[0]!.message);
}

async function findGroupSortOrder(
  db: D1Database,
  groupName: string | null,
): Promise<number | null> {
  const sql =
    groupName === null
      ? `
      SELECT group_sort_order
      FROM monitors
      WHERE group_name IS NULL OR trim(group_name) = ''
      ORDER BY group_sort_order ASC, id ASC
      LIMIT 1
    `
      : `
      SELECT group_sort_order
      FROM monitors
      WHERE group_name IS NOT NULL
        AND trim(group_name) <> ''
        AND lower(trim(group_name)) = lower(?1)
      ORDER BY group_sort_order ASC, id ASC
      LIMIT 1
    `;

  const stmt = db.prepare(sql);
  const row =
    groupName === null
      ? await stmt.first<{ group_sort_order: number }>()
      : await stmt.bind(groupName).first<{ group_sort_order: number }>();

  return row?.group_sort_order ?? null;
}

async function syncGroupSortOrder(
  db: D1Database,
  groupName: string | null,
  groupSortOrder: number,
  updatedAt: number,
  skipMonitorId?: number,
): Promise<void> {
  const binds: (string | number)[] = [groupSortOrder, updatedAt];
  const scopeSql =
    groupName === null
      ? `(group_name IS NULL OR trim(group_name) = '')`
      : `(group_name IS NOT NULL AND trim(group_name) <> '' AND lower(trim(group_name)) = lower(?))`;

  if (groupName !== null) {
    binds.push(groupName);
  }

  const skipSql = skipMonitorId !== undefined ? ` AND id <> ?` : '';
  if (skipMonitorId !== undefined) {
    binds.push(skipMonitorId);
  }

  await db
    .prepare(
      `
      UPDATE monitors
      SET group_sort_order = ?,
          updated_at = ?
      WHERE ${scopeSql}${skipSql}
    `,
    )
    .bind(...binds)
    .run();
}

type MonitorGroupReorderEntry = {
  groupName: string | null;
  groupSortOrder: number;
};

function normalizeMonitorGroupReorderEntries(
  input: { group_name: string | null; group_sort_order: number }[],
): MonitorGroupReorderEntry[] {
  return input.map((group) => ({
    groupName: normalizeMonitorGroupName(group.group_name),
    groupSortOrder: group.group_sort_order,
  }));
}

function buildGroupReorderUpdate(
  groups: MonitorGroupReorderEntry[],
  updatedAt: number,
): { sql: string; binds: (string | number)[] } {
  // Keep one atomic update without allocating two SQL parameters per group.
  const sql = `
    WITH group_order AS (
      SELECT
        coalesce(lower(trim(json_extract(value, '$.groupName'))), '') AS name,
        json_extract(value, '$.groupSortOrder') AS sort_order
      FROM json_each(?1)
    )
    UPDATE monitors
    SET group_sort_order = group_order.sort_order,
        updated_at = ?2
    FROM group_order
    WHERE coalesce(lower(trim(monitors.group_name)), '') = group_order.name
  `;
  return { sql, binds: [JSON.stringify(groups), updatedAt] };
}

function monitorRowToApi(
  row: typeof monitors.$inferSelect,
  state?: Pick<
    typeof monitorState.$inferSelect,
    'status' | 'lastCheckedAt' | 'lastLatencyMs' | 'lastError'
  > | null,
) {
  const groupName = normalizeMonitorGroupName(row.groupName);

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    target: row.target,
    display_url: row.displayUrl,
    interval_sec: row.intervalSec,
    timeout_ms: row.timeoutMs,
    http_method: row.httpMethod,
    http_headers_json: parseDbJsonNullable(httpHeadersJsonSchema, row.httpHeadersJson, {
      field: 'http_headers_json',
    }),
    http_body: row.httpBody,
    follow_redirects: row.followRedirects,
    expected_status_json: parseDbJsonNullable(expectedStatusJsonSchema, row.expectedStatusJson, {
      field: 'expected_status_json',
    }),
    forbidden_status_json: parseDbJsonNullable(forbiddenStatusJsonSchema, row.forbiddenStatusJson, {
      field: 'forbidden_status_json',
    }),
    response_keyword: row.responseKeyword,
    response_keyword_mode: row.responseKeywordMode,
    response_forbidden_keyword: row.responseForbiddenKeyword,
    response_forbidden_keyword_mode: row.responseForbiddenKeywordMode,
    group_name: groupName,
    group_sort_order: row.groupSortOrder,
    sort_order: row.sortOrder,
    show_on_status_page: row.showOnStatusPage,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,

    // Runtime state (denormalized from monitor_state for admin list).
    status: state?.status ?? 'unknown',
    last_checked_at: state?.lastCheckedAt ?? null,
    last_latency_ms: state?.lastLatencyMs ?? null,
    last_error: state?.lastError ?? null,
  };
}

// Generate the fixed read projection once during startup. It follows Drizzle's
// column definitions without constructing a query and nested result mapper on
// the first management request in each isolate.
const ADMIN_MONITOR_LIST_SQL = `
  SELECT ${Object.entries(getTableColumns(monitors))
    .map(([key, column]) => `m."${column.name}" AS "${key}"`)
    .join(',')},
    s.status AS list_state_status, s.last_checked_at AS list_checked_at,
    s.last_latency_ms AS list_latency_ms, s.last_error AS list_error
  FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id=m.id
  WHERE ?2 IS NULL OR m.group_sort_order > ?2 OR
    (m.group_sort_order = ?2 AND (
      (?3 IS NULL AND m.group_name IS NOT NULL) OR m.group_name > ?3 OR
      (m.group_name IS ?3 AND (m.sort_order,m.id) > (?4,?5))
    ))
  ORDER BY m.group_sort_order,m.group_name,m.sort_order,m.id LIMIT ?1
`;
type AdminMonitorListRow = Omit<
  typeof monitors.$inferSelect,
  'followRedirects' | 'showOnStatusPage' | 'isActive'
> & {
  followRedirects: number;
  showOnStatusPage: number;
  isActive: number;
  list_state_status: (typeof monitorState.$inferSelect)['status'] | null;
  list_checked_at: number | null;
  list_latency_ms: number | null;
  list_error: string | null;
};

adminRoutes.get('/monitors', async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .parse(c.req.query('limit'));
  let cursor: [number, string | null, number, number] | null = null;
  const rawCursor = c.req.query('cursor');
  if (rawCursor !== undefined) {
    try {
      cursor = z
        .tuple([
          z.number().int(),
          z.string().max(64).nullable(),
          z.number().int(),
          z.number().int().positive(),
        ])
        .parse(JSON.parse(z.string().max(512).parse(rawCursor)));
    } catch {
      throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid monitor cursor');
    }
  }
  const { results } = await c.env.DB.prepare(ADMIN_MONITOR_LIST_SQL)
    .bind(limit + 1, ...(cursor ?? [null, null, null, null]))
    .all<AdminMonitorListRow>();
  const rows = (results ?? []).slice(0, limit);
  const last = rows.at(-1);
  return c.json({
    monitors: rows.map((row) =>
      monitorRowToApi(
        {
          ...row,
          followRedirects: row.followRedirects === 1,
          showOnStatusPage: row.showOnStatusPage === 1,
          isActive: row.isActive === 1,
        },
        {
          status: row.list_state_status ?? 'unknown',
          lastCheckedAt: row.list_checked_at,
          lastLatencyMs: row.list_latency_ms,
          lastError: row.list_error,
        },
      ),
    ),
    next_cursor:
      last && (results?.length ?? 0) > limit
        ? JSON.stringify([last.groupSortOrder, last.groupName, last.sortOrder, last.id])
        : null,
  });
});

adminRoutes.post('/monitors/groups/reorder', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = reorderMonitorGroupsInputSchema.parse(rawBody);
  const now = Math.floor(Date.now() / 1000);

  const groups = normalizeMonitorGroupReorderEntries(input.groups);
  const { sql, binds } = buildGroupReorderUpdate(groups, now);
  const result = await c.env.DB.prepare(sql)
    .bind(...binds)
    .run();

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({
    updated_groups: groups.length,
    affected_monitors: result.meta.changes ?? 0,
  });
});

adminRoutes.post('/monitors/groups/assign', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = assignMonitorsToGroupInputSchema.parse(rawBody);
  const now = Math.floor(Date.now() / 1000);

  const monitorIds = [...new Set(input.monitor_ids)];
  const targetGroupName = normalizeMonitorGroupName(input.group_name);
  const targetGroupSortOrder =
    input.group_sort_order ?? (await findGroupSortOrder(c.env.DB, targetGroupName)) ?? 0;

  const result = await c.env.DB.prepare(
    `
      UPDATE monitors
      SET group_name = ?,
          group_sort_order = ?,
          updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))
    `,
  )
    .bind(targetGroupName, targetGroupSortOrder, now, JSON.stringify(monitorIds))
    .run();

  if (input.group_sort_order !== undefined) {
    await syncGroupSortOrder(c.env.DB, targetGroupName, targetGroupSortOrder, now);
  }

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({
    group_name: targetGroupName,
    group_sort_order: targetGroupSortOrder,
    updated_monitors: result.meta.changes ?? 0,
  });
});

adminRoutes.get('/settings/uptime-rating', async (c) => {
  const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind('uptime_rating_level')
    .first<{ value: string }>();

  const n = Number.parseInt(row?.value ?? '', 10);
  const level = Number.isFinite(n) && n >= 1 && n <= 5 ? (n as 1 | 2 | 3 | 4 | 5) : 3;

  return c.json({ uptime_rating_level: level });
});

adminRoutes.put('/settings/uptime-rating', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });

  const input = z.object({ uptime_rating_level: z.number().int().min(1).max(5) }).parse(rawBody);

  await c.env.DB.prepare(
    `
      INSERT INTO settings (key, value)
      VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  )
    .bind('uptime_rating_level', String(input.uptime_rating_level))
    .run();

  await bumpHomepageSettingsGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ uptime_rating_level: input.uptime_rating_level });
});

adminRoutes.post('/monitors', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = createMonitorInputSchema.parse(rawBody);

  const db = getDb(c.env);
  const now = Math.floor(Date.now() / 1000);
  const groupName = normalizeMonitorGroupName(input.group_name);
  const groupSortOrder =
    input.group_sort_order ?? (await findGroupSortOrder(c.env.DB, groupName)) ?? 0;

  const inserted = await db
    .insert(monitors)
    .values({
      name: input.name,
      type: input.type,
      target: input.target,
      displayUrl: input.display_url ?? null,
      intervalSec: input.interval_sec ?? 60,
      timeoutMs: input.timeout_ms ?? 10000,

      httpMethod: input.type === 'http' ? (input.http_method ?? null) : null,
      httpHeadersJson:
        input.type === 'http'
          ? serializeDbJsonNullable(httpHeadersJsonSchema, input.http_headers_json ?? null, {
              field: 'http_headers_json',
            })
          : null,
      httpBody: input.type === 'http' ? (input.http_body ?? null) : null,
      followRedirects: input.type === 'http' ? (input.follow_redirects ?? true) : true,
      expectedStatusJson:
        input.type === 'http'
          ? serializeDbJsonNullable(expectedStatusJsonSchema, input.expected_status_json ?? null, {
              field: 'expected_status_json',
            })
          : null,
      forbiddenStatusJson:
        input.type === 'http'
          ? serializeDbJsonNullable(
              forbiddenStatusJsonSchema,
              input.forbidden_status_json ?? null,
              {
                field: 'forbidden_status_json',
              },
            )
          : null,
      responseKeyword: input.type === 'http' ? (input.response_keyword ?? null) : null,
      responseKeywordMode:
        input.type === 'http'
          ? normalizeAssertionModeForStorage(
              input.response_keyword ?? null,
              input.response_keyword_mode,
            )
          : null,
      responseForbiddenKeyword:
        input.type === 'http' ? (input.response_forbidden_keyword ?? null) : null,
      responseForbiddenKeywordMode:
        input.type === 'http'
          ? normalizeAssertionModeForStorage(
              input.response_forbidden_keyword ?? null,
              input.response_forbidden_keyword_mode,
            )
          : null,

      groupName,
      groupSortOrder,
      sortOrder: input.sort_order ?? 0,
      showOnStatusPage: input.show_on_status_page ?? true,
      isActive: input.is_active ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  if (input.group_sort_order !== undefined) {
    await syncGroupSortOrder(c.env.DB, groupName, groupSortOrder, now, inserted.id);
  }

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ monitor: monitorRowToApi(inserted, null) }, 201);
});

adminRoutes.patch('/monitors/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = patchMonitorInputSchema.parse(rawBody);

  const db = getDb(c.env);
  const existing = await db.select().from(monitors).where(eq(monitors.id, id)).get();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  // Validate target if being updated
  if (input.target !== undefined) {
    const targetErr =
      existing.type === 'http' ? validateHttpTarget(input.target) : validateTcpTarget(input.target);
    if (targetErr) {
      throw new AppError(400, 'INVALID_ARGUMENT', targetErr);
    }
  }

  // Prevent http_* fields on tcp monitors
  if (existing.type === 'tcp') {
    const httpFields = [
      'http_method',
      'http_headers_json',
      'http_body',
      'follow_redirects',
      'expected_status_json',
      'forbidden_status_json',
      'response_keyword',
      'response_keyword_mode',
      'response_forbidden_keyword',
      'response_forbidden_keyword_mode',
    ] as const;
    for (const field of httpFields) {
      if (input[field] !== undefined) {
        throw new AppError(
          400,
          'INVALID_ARGUMENT',
          'http_* fields are not allowed for tcp monitors',
        );
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const nextGroupName =
    input.group_name !== undefined
      ? normalizeMonitorGroupName(input.group_name)
      : normalizeMonitorGroupName(existing.groupName);
  const nextGroupSortOrder =
    input.group_sort_order !== undefined
      ? input.group_sort_order
      : ((await findGroupSortOrder(c.env.DB, nextGroupName)) ?? existing.groupSortOrder);
  const nextResponseKeyword =
    input.response_keyword !== undefined ? input.response_keyword : existing.responseKeyword;
  const nextResponseKeywordMode = normalizeAssertionModeForStorage(
    nextResponseKeyword,
    input.response_keyword_mode !== undefined
      ? input.response_keyword_mode
      : existing.responseKeywordMode,
  );
  const nextResponseForbiddenKeyword =
    input.response_forbidden_keyword !== undefined
      ? input.response_forbidden_keyword
      : existing.responseForbiddenKeyword;
  const nextResponseForbiddenKeywordMode = normalizeAssertionModeForStorage(
    nextResponseForbiddenKeyword,
    input.response_forbidden_keyword_mode !== undefined
      ? input.response_forbidden_keyword_mode
      : existing.responseForbiddenKeywordMode,
  );

  throwOnInvalidHttpResponseAssertionConfig({
    responseKeyword: nextResponseKeyword,
    responseKeywordMode: nextResponseKeywordMode,
    responseForbiddenKeyword: nextResponseForbiddenKeyword,
    responseForbiddenKeywordMode: nextResponseForbiddenKeywordMode,
  });

  const updated = await db
    .update(monitors)
    .set({
      name: input.name ?? existing.name,
      target: input.target ?? existing.target,
      displayUrl: input.display_url !== undefined ? input.display_url : existing.displayUrl,
      intervalSec: input.interval_sec ?? existing.intervalSec,
      timeoutMs: input.timeout_ms ?? existing.timeoutMs,
      httpMethod: input.http_method !== undefined ? input.http_method : existing.httpMethod,
      httpHeadersJson:
        input.http_headers_json !== undefined
          ? serializeDbJsonNullable(httpHeadersJsonSchema, input.http_headers_json, {
              field: 'http_headers_json',
            })
          : existing.httpHeadersJson,
      httpBody: input.http_body !== undefined ? input.http_body : existing.httpBody,
      followRedirects:
        input.follow_redirects !== undefined ? input.follow_redirects : existing.followRedirects,
      expectedStatusJson:
        input.expected_status_json !== undefined
          ? serializeDbJsonNullable(expectedStatusJsonSchema, input.expected_status_json, {
              field: 'expected_status_json',
            })
          : existing.expectedStatusJson,
      forbiddenStatusJson:
        input.forbidden_status_json !== undefined
          ? serializeDbJsonNullable(forbiddenStatusJsonSchema, input.forbidden_status_json, {
              field: 'forbidden_status_json',
            })
          : existing.forbiddenStatusJson,
      responseKeyword: nextResponseKeyword,
      responseKeywordMode: nextResponseKeywordMode,
      responseForbiddenKeyword: nextResponseForbiddenKeyword,
      responseForbiddenKeywordMode: nextResponseForbiddenKeywordMode,
      groupName: nextGroupName,
      groupSortOrder: nextGroupSortOrder,
      sortOrder: input.sort_order ?? existing.sortOrder,
      showOnStatusPage: input.show_on_status_page ?? existing.showOnStatusPage,
      isActive: input.is_active ?? existing.isActive,
      updatedAt: now,
    })
    .where(eq(monitors.id, id))
    .returning()
    .get();

  if (!updated) {
    throw new AppError(500, 'INTERNAL', 'Failed to update monitor');
  }

  if (input.group_sort_order !== undefined) {
    await syncGroupSortOrder(c.env.DB, nextGroupName, nextGroupSortOrder, now, updated.id);
  }

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ monitor: monitorRowToApi(updated, null) });
});

adminRoutes.delete('/monitors/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const db = getDb(c.env);
  const existing = await db.select().from(monitors).where(eq(monitors.id, id)).get();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  // Deleting a monitor must also stop future scheduled checks and keep analytics
  // consistent. We hard-delete and cascade-delete all monitor-scoped records.
  // (No FK constraints are enforced by D1 here.)
  await c.env.DB.batch([
    // Determine the audience inside the same transaction as deletion, rather
    // than trusting the earlier read if visibility changed concurrently.
    c.env.DB.prepare(
      `UPDATE incidents SET scope='global'
      WHERE scope='monitors' AND EXISTS (
        SELECT 1 FROM monitors WHERE id=?1 AND show_on_status_page=1
      ) AND id IN (SELECT incident_id FROM incident_monitors WHERE monitor_id=?1)
      AND NOT EXISTS (
        SELECT 1 FROM incident_monitors im
        WHERE im.incident_id=incidents.id AND im.monitor_id != ?1
      )`,
    ).bind(id),
    c.env.DB.prepare(
      `UPDATE maintenance_windows SET scope='global'
      WHERE scope='monitors' AND EXISTS (
        SELECT 1 FROM monitors WHERE id=?1 AND show_on_status_page=1
      ) AND id IN (
        SELECT maintenance_window_id FROM maintenance_window_monitors WHERE monitor_id=?1
      ) AND NOT EXISTS (
        SELECT 1 FROM maintenance_window_monitors mwm
        WHERE mwm.maintenance_window_id=maintenance_windows.id AND mwm.monitor_id != ?1
      )`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM check_results_legacy WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare(
      `UPDATE check_result_buckets
      SET samples_json = (SELECT json_group_array(json(value)) FROM json_each(samples_json)
        WHERE type = 'array' AND json_extract(value, '$[0]') != ?1)
      WHERE shard_id = CAST((?1 - 1) / 4 AS INTEGER)`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM outages WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM monitor_state WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM monitor_daily_rollups WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM maintenance_window_monitors WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM incident_monitors WHERE monitor_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM monitors WHERE id = ?1').bind(id),
  ]);

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ deleted: true });
});

adminRoutes.post('/monitors/:id/test', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const db = getDb(c.env);
  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  let outcome;
  if (monitor.type === 'http') {
    outcome = await runHttpCheck({
      url: monitor.target,
      timeoutMs: monitor.timeoutMs,
      method: (monitor.httpMethod as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD') ?? 'GET',
      headers: parseDbJsonNullable(httpHeadersJsonSchema, monitor.httpHeadersJson, {
        field: 'http_headers_json',
      }),
      body: monitor.httpBody,
      followRedirects: monitor.followRedirects,
      expectedStatus: parseDbJsonNullable(expectedStatusJsonSchema, monitor.expectedStatusJson, {
        field: 'expected_status_json',
      }),
      forbiddenStatus: parseDbJsonNullable(forbiddenStatusJsonSchema, monitor.forbiddenStatusJson, {
        field: 'forbidden_status_json',
      }),
      responseKeyword: monitor.responseKeyword,
      responseKeywordMode: monitor.responseKeywordMode,
      responseForbiddenKeyword: monitor.responseForbiddenKeyword,
      responseForbiddenKeywordMode: monitor.responseForbiddenKeywordMode,
    });
  } else {
    outcome = await runTcpCheck({
      target: monitor.target,
      timeoutMs: monitor.timeoutMs,
    });
  }

  return c.json({
    monitor: { id: monitor.id, name: monitor.name, type: monitor.type },
    result: {
      status: outcome.status,
      latency_ms: outcome.latencyMs,
      http_status: outcome.httpStatus,
      error: outcome.error,
      attempts: outcome.attempts,
    },
  });
});

adminRoutes.post('/monitors/:id/pause', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const db = getDb(c.env);
  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);

  // Keep the state row present so public/admin payloads can reliably surface `paused`.
  // Reset streaks to avoid flapping thresholds being affected when the monitor resumes.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `
        INSERT INTO monitor_state (
          monitor_id,
          status,
          last_checked_at,
          last_changed_at,
          last_latency_ms,
          last_error,
          consecutive_failures,
          consecutive_successes
        ) VALUES (?1, 'paused', NULL, ?2, NULL, NULL, 0, 0)
        ON CONFLICT(monitor_id) DO UPDATE SET
          status = 'paused',
          last_changed_at = ?2,
          consecutive_failures = 0,
          consecutive_successes = 0
      `,
    ).bind(id, now),

    // If the monitor was DOWN when it got paused, the scheduler will no longer run to close the outage.
    // Close any open outage interval so analytics/exports don't keep accumulating downtime indefinitely.
    c.env.DB.prepare(
      `
        UPDATE outages
        SET ended_at = ?1
        WHERE monitor_id = ?2 AND ended_at IS NULL
      `,
    ).bind(now, id),
  ]);

  const state = await db.select().from(monitorState).where(eq(monitorState.monitorId, id)).get();

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ monitor: monitorRowToApi(monitor, state ?? null) });
});

adminRoutes.post('/monitors/:id/resume', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const db = getDb(c.env);
  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);

  // Resume by returning to UNKNOWN so the scheduler will pick it up on the next tick.
  await c.env.DB.prepare(
    `
      INSERT INTO monitor_state (
        monitor_id,
        status,
        last_checked_at,
        last_changed_at,
        last_latency_ms,
        last_error,
        consecutive_failures,
        consecutive_successes
      ) VALUES (?1, 'unknown', NULL, ?2, NULL, NULL, 0, 0)
      ON CONFLICT(monitor_id) DO UPDATE SET
        status = 'unknown',
        last_changed_at = ?2,
        consecutive_failures = 0,
        consecutive_successes = 0
    `,
  )
    .bind(id, now)
    .run();

  const state = await db.select().from(monitorState).where(eq(monitorState.monitorId, id)).get();

  await bumpHomepageMonitorGuardVersions(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ monitor: monitorRowToApi(monitor, state ?? null) });
});

type NotificationChannelRow = {
  id: number;
  name: string;
  type: string;
  config_json: string;
  is_active: number;
  created_at: number;
};

type NotificationChannelInputConfig =
  | CustomWebhookChannelConfig
  | TelegramChannelCreateInput
  | TelegramChannelPatchInput
  | WpushChannelCreateInput
  | WpushChannelPatchInput;

type TelegramApiChannelConfig = Omit<TelegramChannelConfig, 'bot_token_encrypted'> & {
  bot_token_configured: boolean;
  bot_token_source: 'stored' | 'secret_ref';
};

type WpushApiChannelConfig = Omit<WpushChannelConfig, 'api_key_encrypted'> & {
  api_key_configured: boolean;
  api_key_source: 'stored' | 'secret_ref';
};

type NotificationChannelApiConfig =
  | CustomWebhookChannelConfig
  | TelegramApiChannelConfig
  | WpushApiChannelConfig;

function isTelegramInputConfig(
  config: NotificationChannelInputConfig,
): config is TelegramChannelCreateInput | TelegramChannelPatchInput {
  return config.preset === 'telegram';
}

function isTelegramStoredConfig(
  config: WebhookChannelConfig | undefined,
): config is TelegramChannelConfig {
  return config?.preset === 'telegram';
}

function isWpushInputConfig(
  config: NotificationChannelInputConfig,
): config is WpushChannelCreateInput | WpushChannelPatchInput {
  return config.preset === 'wpush';
}

function isWpushStoredConfig(
  config: WebhookChannelConfig | undefined,
): config is WpushChannelConfig {
  return config?.preset === 'wpush';
}

async function normalizeNotificationConfigForStorage(
  env: Env,
  inputConfig: NotificationChannelInputConfig,
  existingConfig?: WebhookChannelConfig,
): Promise<WebhookChannelConfig> {
  if (isWpushInputConfig(inputConfig)) {
    const { api_key: apiKey, api_key_secret_ref: apiKeySecretRef, ...wpushConfig } = inputConfig;
    const baseWpushConfig = isWpushStoredConfig(existingConfig) ? existingConfig : undefined;

    if (apiKey) {
      const adminToken = env.ADMIN_TOKEN?.trim();
      if (!adminToken) {
        throw new AppError(500, 'INTERNAL', 'Admin token not configured');
      }
      return {
        ...wpushConfig,
        api_key_encrypted: await encryptWpushApiKey(adminToken, apiKey),
      };
    }

    if (apiKeySecretRef) {
      return {
        ...wpushConfig,
        api_key_secret_ref: apiKeySecretRef,
      };
    }

    if (baseWpushConfig?.api_key_encrypted) {
      return {
        ...wpushConfig,
        api_key_encrypted: baseWpushConfig.api_key_encrypted,
      };
    }

    if (baseWpushConfig?.api_key_secret_ref) {
      return {
        ...wpushConfig,
        api_key_secret_ref: baseWpushConfig.api_key_secret_ref,
      };
    }

    throw new AppError(400, 'INVALID_ARGUMENT', 'WPush API key is required');
  }

  if (!isTelegramInputConfig(inputConfig)) {
    return inputConfig;
  }

  const {
    bot_token: botToken,
    bot_token_secret_ref: botTokenSecretRef,
    ...telegramConfig
  } = inputConfig;
  const baseTelegramConfig = isTelegramStoredConfig(existingConfig) ? existingConfig : undefined;

  if (botToken) {
    const adminToken = env.ADMIN_TOKEN?.trim();
    if (!adminToken) {
      throw new AppError(500, 'INTERNAL', 'Admin token not configured');
    }

    return {
      ...telegramConfig,
      bot_token_encrypted: await encryptTelegramBotToken(adminToken, botToken),
    };
  }

  if (botTokenSecretRef) {
    return {
      ...telegramConfig,
      bot_token_secret_ref: botTokenSecretRef,
    };
  }

  if (baseTelegramConfig?.bot_token_encrypted) {
    return {
      ...telegramConfig,
      bot_token_encrypted: baseTelegramConfig.bot_token_encrypted,
    };
  }

  if (baseTelegramConfig?.bot_token_secret_ref) {
    return {
      ...telegramConfig,
      bot_token_secret_ref: baseTelegramConfig.bot_token_secret_ref,
    };
  }

  throw new AppError(400, 'INVALID_ARGUMENT', 'Telegram bot token is required');
}

function sanitizeNotificationConfigForApi(
  config: WebhookChannelConfig,
): NotificationChannelApiConfig {
  if (isWpushStoredConfig(config)) {
    const { api_key_encrypted: encryptedKey, ...wpushConfig } = config;
    return {
      ...wpushConfig,
      api_key_configured: Boolean(encryptedKey || wpushConfig.api_key_secret_ref),
      api_key_source: wpushConfig.api_key_secret_ref ? 'secret_ref' : 'stored',
    };
  }

  if (!isTelegramStoredConfig(config)) {
    return config;
  }

  const { bot_token_encrypted: encryptedToken, ...telegramConfig } = config;

  return {
    ...telegramConfig,
    bot_token_configured: Boolean(encryptedToken || telegramConfig.bot_token_secret_ref),
    bot_token_source: telegramConfig.bot_token_secret_ref ? 'secret_ref' : 'stored',
  };
}

function notificationChannelRowToApi(row: NotificationChannelRow) {
  const config = parseDbJson(webhookChannelConfigSchema, row.config_json, { field: 'config_json' });

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config_json: sanitizeNotificationConfigForApi(config),
    is_active: row.is_active === 1,
    created_at: row.created_at,
  };
}

adminRoutes.get('/notification-channels', async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .parse(c.req.query('limit'));

  const { results } = await c.env.DB.prepare(
    `
      SELECT id, name, type, config_json, is_active, created_at
      FROM notification_channels
      ORDER BY id
      LIMIT ?1
    `,
  )
    .bind(limit)
    .all<NotificationChannelRow>();

  return c.json({ notification_channels: (results ?? []).map(notificationChannelRowToApi) });
});

adminRoutes.post('/notification-channels', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = createNotificationChannelInputSchema.parse(rawBody);

  const now = Math.floor(Date.now() / 1000);
  const isActive = input.is_active ?? true;
  const storageConfig = await normalizeNotificationConfigForStorage(c.env, input.config_json);
  const configJson = serializeDbJson(webhookChannelConfigSchema, storageConfig, {
    field: 'config_json',
  });

  const row = await c.env.DB.prepare(
    `
      INSERT INTO notification_channels (name, type, config_json, is_active, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      RETURNING id, name, type, config_json, is_active, created_at
    `,
  )
    .bind(input.name, input.type, configJson, isActive ? 1 : 0, now)
    .first<NotificationChannelRow>();

  if (!row) {
    throw new AppError(500, 'INTERNAL', 'Failed to create notification channel');
  }

  return c.json({ notification_channel: notificationChannelRowToApi(row) }, 201);
});

adminRoutes.patch('/notification-channels/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = patchNotificationChannelInputSchema.parse(rawBody);

  const existing = await c.env.DB.prepare(
    `
      SELECT id, name, type, config_json, is_active, created_at
      FROM notification_channels
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<NotificationChannelRow>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Notification channel not found');
  }

  const nextName = input.name ?? existing.name;
  const nextIsActive =
    input.is_active !== undefined ? (input.is_active ? 1 : 0) : existing.is_active;
  const existingConfig = parseDbJson(webhookChannelConfigSchema, existing.config_json, {
    field: 'config_json',
  });
  const nextConfigJson =
    input.config_json !== undefined
      ? serializeDbJson(
          webhookChannelConfigSchema,
          await normalizeNotificationConfigForStorage(c.env, input.config_json, existingConfig),
          { field: 'config_json' },
        )
      : existing.config_json;

  const updated = await c.env.DB.prepare(
    `
      UPDATE notification_channels
      SET name = ?1, config_json = ?2, is_active = ?3
      WHERE id = ?4
      RETURNING id, name, type, config_json, is_active, created_at
    `,
  )
    .bind(nextName, nextConfigJson, nextIsActive, id)
    .first<NotificationChannelRow>();

  if (!updated) {
    throw new AppError(500, 'INTERNAL', 'Failed to update notification channel');
  }

  return c.json({ notification_channel: notificationChannelRowToApi(updated) });
});

adminRoutes.delete('/notification-channels/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const existing = await c.env.DB.prepare(
    `
      SELECT id
      FROM notification_channels
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<{ id: number }>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Notification channel not found');
  }

  // Keep notification_deliveries tidy; these rows become orphaned once the channel is removed.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `
        DELETE FROM notification_deliveries
        WHERE channel_id = ?1
      `,
    ).bind(id),
    c.env.DB.prepare(
      `
        DELETE FROM notification_channels
        WHERE id = ?1
      `,
    ).bind(id),
  ]);

  return c.json({ deleted: true });
});

type NotificationDeliveryRow = {
  status: string;
  http_status: number | null;
  error: string | null;
  created_at: number;
};

type ActiveWebhookChannelRow = {
  id: number;
  name: string;
  config_json: string;
};

async function listActiveWebhookChannels(db: D1Database): Promise<WebhookChannel[]> {
  const { results } = await db
    .prepare(
      `
      SELECT id, name, config_json
      FROM notification_channels
      WHERE is_active = 1 AND type = 'webhook'
      ORDER BY id
    `,
    )
    .all<ActiveWebhookChannelRow>();

  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    config: parseDbJson(webhookChannelConfigSchema, r.config_json, { field: 'config_json' }),
  }));
}

function normalizeIdList(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function ensureMonitorsExist(db: D1Database, monitorIds: number[]): Promise<void> {
  const ids = normalizeIdList(monitorIds);
  if (ids.length === 0) {
    throw new AppError(
      400,
      'INVALID_ARGUMENT',
      '`monitor_ids` must contain at least one monitor id',
    );
  }

  const { results } = await db
    .prepare(
      `
        SELECT id
        FROM monitors
        WHERE id IN (SELECT value FROM json_each(?1))
      `,
    )
    .bind(JSON.stringify(ids))
    .all<{ id: number }>();

  const found = new Set((results ?? []).map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `Monitor(s) not found: ${missing.join(', ')}`);
  }
}

type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  status: string | null;
  message: string;
  created_at: number;
};

type IncidentMonitorLinkRow = {
  incident_id: number;
  monitor_id: number;
};

function toIncidentStatus(
  value: string | null,
): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  switch (value) {
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'resolved':
      return value;
    default:
      return 'investigating';
  }
}

function toIncidentImpact(value: string | null): 'none' | 'minor' | 'major' | 'critical' {
  switch (value) {
    case 'none':
    case 'minor':
    case 'major':
    case 'critical':
      return value;
    default:
      return 'minor';
  }
}

function incidentUpdateRowToApi(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status === null ? null : toIncidentStatus(row.status),
    message: row.message,
    created_at: row.created_at,
  };
}

function incidentRowToApi(
  row: IncidentRow,
  updates: IncidentUpdateRow[] = [],
  monitorIds: number[] = [],
) {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    monitor_ids: monitorIds,
    updates: updates.map(incidentUpdateRowToApi),
  };
}

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();
  if (incidentIds.length === 0) return byIncident;

  const sql = `
    SELECT id, incident_id, status, message, created_at
    FROM incident_updates
    WHERE incident_id IN (SELECT value FROM json_each(?1))
    ORDER BY incident_id, created_at, id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(JSON.stringify(incidentIds))
    .all<IncidentUpdateRow>();
  for (const r of results ?? []) {
    const existing = byIncident.get(r.incident_id) ?? [];
    existing.push(r);
    byIncident.set(r.incident_id, existing);
  }
  return byIncident;
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();
  if (incidentIds.length === 0) return byIncident;

  const sql = `
    SELECT incident_id, monitor_id
    FROM incident_monitors
    WHERE incident_id IN (SELECT value FROM json_each(?1))
    ORDER BY incident_id, monitor_id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(JSON.stringify(incidentIds))
    .all<IncidentMonitorLinkRow>();
  for (const r of results ?? []) {
    const existing = byIncident.get(r.incident_id) ?? [];
    existing.push(r.monitor_id);
    byIncident.set(r.incident_id, existing);
  }

  return byIncident;
}

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();
  if (windowIds.length === 0) return byWindow;

  const sql = `
    SELECT maintenance_window_id, monitor_id
    FROM maintenance_window_monitors
    WHERE maintenance_window_id IN (SELECT value FROM json_each(?1))
    ORDER BY maintenance_window_id, monitor_id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(JSON.stringify(windowIds))
    .all<MaintenanceWindowMonitorLinkRow>();
  for (const r of results ?? []) {
    const existing = byWindow.get(r.maintenance_window_id) ?? [];
    existing.push(r.monitor_id);
    byWindow.set(r.maintenance_window_id, existing);
  }

  return byWindow;
}

adminRoutes.post('/notification-channels/:id/test', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const channelRow = await c.env.DB.prepare(
    `
      SELECT id, name, type, config_json, is_active, created_at
      FROM notification_channels
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<NotificationChannelRow>();

  if (!channelRow) {
    throw new AppError(404, 'NOT_FOUND', 'Notification channel not found');
  }

  const config = parseDbJson(webhookChannelConfigSchema, channelRow.config_json, {
    field: 'config_json',
  });
  const channel = { id: channelRow.id, name: channelRow.name, config };

  const now = Math.floor(Date.now() / 1000);
  const eventKey = `test:webhook:${id}:${now}`;
  const payload = {
    event: 'test.ping',
    event_id: eventKey,
    timestamp: now,
    // Provide representative fields so templates can be validated via the test button.
    monitor: { id: 0, name: 'Example monitor', type: 'http', target: 'https://example.com/health' },
    state: { status: 'up', latency_ms: 123, http_status: 200, error: null, location: null },
  };

  await dispatchWebhookToChannelLegacy({
    db: c.env.DB,
    env: c.env as unknown as Record<string, unknown>,
    channel,
    eventKey,
    payload,
  });

  const delivery = await c.env.DB.prepare(
    `
      SELECT status, http_status, error, created_at
      FROM notification_deliveries
      WHERE event_key = ?1 AND channel_id = ?2
    `,
  )
    .bind(eventKey, id)
    .first<NotificationDeliveryRow>();

  return c.json({
    event_key: eventKey,
    delivery: delivery
      ? {
          status: delivery.status,
          http_status: delivery.http_status,
          error: delivery.error,
          created_at: delivery.created_at,
        }
      : null,
  });
});

adminRoutes.get('/incidents', async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .parse(c.req.query('limit'));

  const { results: incidentRows } = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      ORDER BY
        CASE WHEN status != 'resolved' THEN 0 ELSE 1 END,
        started_at DESC,
        id DESC
      LIMIT ?1
    `,
  )
    .bind(limit)
    .all<IncidentRow>();

  const incidentsList = incidentRows ?? [];
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    c.env.DB,
    incidentsList.map((r) => r.id),
  );
  const updatesByIncidentId = await listIncidentUpdatesByIncidentId(
    c.env.DB,
    incidentsList.map((r) => r.id),
  );

  return c.json({
    incidents: incidentsList.map((r) =>
      incidentRowToApi(
        r,
        updatesByIncidentId.get(r.id) ?? [],
        monitorIdsByIncidentId.get(r.id) ?? [],
      ),
    ),
  });
});

adminRoutes.post('/incidents', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = createIncidentInputSchema.parse(rawBody);

  const now = Math.floor(Date.now() / 1000);
  const startedAt = input.started_at ?? now;
  if (startedAt > now) {
    throw new AppError(400, 'INVALID_ARGUMENT', '`started_at` cannot be in the future');
  }

  const monitorIds = normalizeIdList(input.monitor_ids);
  await ensureMonitorsExist(c.env.DB, monitorIds);

  const row = await c.env.DB.prepare(
    `
      INSERT INTO incidents (title, status, impact, message, started_at, resolved_at)
      VALUES (?1, ?2, ?3, ?4, ?5, NULL)
      RETURNING id, title, status, impact, message, started_at, resolved_at
    `,
  )
    .bind(input.title, input.status, input.impact, input.message ?? null, startedAt)
    .first<IncidentRow>();

  if (!row) {
    throw new AppError(500, 'INTERNAL', 'Failed to create incident');
  }

  const linkStatements = monitorIds.map((monitorId) =>
    c.env.DB.prepare(
      `
        INSERT INTO incident_monitors (incident_id, monitor_id, created_at)
        VALUES (?1, ?2, ?3)
      `,
    ).bind(row.id, monitorId, now),
  );
  if (linkStatements.length > 0) {
    await c.env.DB.batch(linkStatements);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const channels = await listActiveWebhookChannels(c.env.DB);
      if (channels.length === 0) return;

      const eventKey = `incident:${row.id}:created:${startedAt}`;
      const payload = {
        event: 'incident.created',
        event_id: eventKey,
        timestamp: now,
        incident: incidentRowToApi(row, [], monitorIds),
      };

      await dispatchWebhookToChannels({
        db: c.env.DB,
        env: c.env as unknown as Record<string, unknown>,
        channels,
        eventType: payload.event,
        eventKey,
        payload,
      });
    })().catch((err) => {
      console.error('notify: failed to dispatch incident.created', err);
    }),
  );

  await bumpHomepageIncidentGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ incident: incidentRowToApi(row, [], monitorIds) }, 201);
});

adminRoutes.post('/incidents/:id/updates', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = createIncidentUpdateInputSchema.parse(rawBody);

  const existing = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<IncidentRow>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Incident not found');
  }
  if (existing.status === 'resolved') {
    throw new AppError(409, 'CONFLICT', 'Incident already resolved');
  }

  const now = Math.floor(Date.now() / 1000);
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(c.env.DB, [id]);
  const monitorIds = monitorIdsByIncidentId.get(id) ?? [];

  const updateRow = await c.env.DB.prepare(
    `
      INSERT INTO incident_updates (incident_id, status, message, created_at)
      VALUES (?1, ?2, ?3, ?4)
      RETURNING id, incident_id, status, message, created_at
    `,
  )
    .bind(id, input.status ?? null, input.message, now)
    .first<IncidentUpdateRow>();

  if (!updateRow) {
    throw new AppError(500, 'INTERNAL', 'Failed to create incident update');
  }

  if (input.status) {
    await c.env.DB.prepare(
      `
        UPDATE incidents
        SET status = ?1
        WHERE id = ?2
      `,
    )
      .bind(input.status, id)
      .run();
  }

  const incidentRow = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<IncidentRow>();

  if (!incidentRow) {
    throw new AppError(500, 'INTERNAL', 'Incident missing after update');
  }

  c.executionCtx.waitUntil(
    (async () => {
      const channels = await listActiveWebhookChannels(c.env.DB);
      if (channels.length === 0) return;

      const eventKey = `incident:${id}:update:${updateRow.id}`;
      const payload = {
        event: 'incident.updated',
        event_id: eventKey,
        timestamp: now,
        incident: incidentRowToApi(incidentRow, [], monitorIds),
        update: incidentUpdateRowToApi(updateRow),
      };

      await dispatchWebhookToChannels({
        db: c.env.DB,
        env: c.env as unknown as Record<string, unknown>,
        channels,
        eventType: payload.event,
        eventKey,
        payload,
      });
    })().catch((err) => {
      console.error('notify: failed to dispatch incident.updated', err);
    }),
  );

  await bumpHomepageIncidentGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({
    incident: incidentRowToApi(incidentRow, [], monitorIds),
    update: incidentUpdateRowToApi(updateRow),
  });
});

adminRoutes.patch('/incidents/:id/resolve', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = resolveIncidentInputSchema.parse(rawBody);

  const existing = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<IncidentRow>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Incident not found');
  }
  if (existing.status === 'resolved') {
    const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(c.env.DB, [id]);
    const monitorIds = monitorIdsByIncidentId.get(id) ?? [];

    return c.json({ incident: incidentRowToApi(existing, [], monitorIds) });
  }

  const now = Math.floor(Date.now() / 1000);
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(c.env.DB, [id]);
  const monitorIds = monitorIdsByIncidentId.get(id) ?? [];

  await c.env.DB.prepare(
    `
      UPDATE incidents
      SET status = 'resolved', resolved_at = ?1
      WHERE id = ?2
    `,
  )
    .bind(now, id)
    .run();

  const message = input.message ?? 'Resolved';
  const updateRow = await c.env.DB.prepare(
    `
      INSERT INTO incident_updates (incident_id, status, message, created_at)
      VALUES (?1, 'resolved', ?2, ?3)
      RETURNING id, incident_id, status, message, created_at
    `,
  )
    .bind(id, message, now)
    .first<IncidentUpdateRow>();

  if (!updateRow) {
    throw new AppError(500, 'INTERNAL', 'Failed to create incident resolution update');
  }

  const incidentRow = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<IncidentRow>();

  if (!incidentRow) {
    throw new AppError(500, 'INTERNAL', 'Incident missing after resolve');
  }

  c.executionCtx.waitUntil(
    (async () => {
      const channels = await listActiveWebhookChannels(c.env.DB);
      if (channels.length === 0) return;

      const eventKey = `incident:${id}:resolved:${updateRow.id}`;
      const payload = {
        event: 'incident.resolved',
        event_id: eventKey,
        timestamp: now,
        incident: incidentRowToApi(incidentRow, [], monitorIds),
        update: incidentUpdateRowToApi(updateRow),
      };

      await dispatchWebhookToChannels({
        db: c.env.DB,
        env: c.env as unknown as Record<string, unknown>,
        channels,
        eventType: payload.event,
        eventKey,
        payload,
      });
    })().catch((err) => {
      console.error('notify: failed to dispatch incident.resolved', err);
    }),
  );

  await bumpHomepageIncidentGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({
    incident: incidentRowToApi(incidentRow, [], monitorIds),
    update: incidentUpdateRowToApi(updateRow),
  });
});

adminRoutes.delete('/incidents/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const existing = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<IncidentRow>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Incident not found');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `
        DELETE FROM incident_updates
        WHERE incident_id = ?1
      `,
    ).bind(id),
    c.env.DB.prepare(
      `
        DELETE FROM incident_monitors
        WHERE incident_id = ?1
      `,
    ).bind(id),
    c.env.DB.prepare(
      `
        DELETE FROM incidents
        WHERE id = ?1
      `,
    ).bind(id),
  ]);

  await bumpHomepageIncidentGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ deleted: true });
});

adminRoutes.get('/maintenance-windows', async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .parse(c.req.query('limit'));

  const { results } = await c.env.DB.prepare(
    `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      ORDER BY starts_at DESC, id DESC
      LIMIT ?1
    `,
  )
    .bind(limit)
    .all<MaintenanceWindowRow>();

  const windows = results ?? [];
  const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
    c.env.DB,
    windows.map((w) => w.id),
  );

  return c.json({
    maintenance_windows: windows.map((w) =>
      maintenanceWindowRowToApi(w, monitorIdsByWindowId.get(w.id) ?? []),
    ),
  });
});

adminRoutes.post('/maintenance-windows', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = createMaintenanceWindowInputSchema.parse(rawBody);

  const now = Math.floor(Date.now() / 1000);
  const monitorIds = normalizeIdList(input.monitor_ids);
  await ensureMonitorsExist(c.env.DB, monitorIds);

  const row = await c.env.DB.prepare(
    `
      INSERT INTO maintenance_windows (title, message, starts_at, ends_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      RETURNING id, title, message, starts_at, ends_at, created_at
    `,
  )
    .bind(input.title, input.message ?? null, input.starts_at, input.ends_at, now)
    .first<MaintenanceWindowRow>();

  if (!row) {
    throw new AppError(500, 'INTERNAL', 'Failed to create maintenance window');
  }

  const linkStatements = monitorIds.map((monitorId) =>
    c.env.DB.prepare(
      `
        INSERT INTO maintenance_window_monitors (maintenance_window_id, monitor_id, created_at)
        VALUES (?1, ?2, ?3)
      `,
    ).bind(row.id, monitorId, now),
  );
  if (linkStatements.length > 0) {
    await c.env.DB.batch(linkStatements);
  }

  await bumpHomepageMaintenanceGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ maintenance_window: maintenanceWindowRowToApi(row, monitorIds) }, 201);
});

adminRoutes.patch('/maintenance-windows/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });
  const input = patchMaintenanceWindowInputSchema.parse(rawBody);

  const existing = await c.env.DB.prepare(
    `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<MaintenanceWindowRow>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Maintenance window not found');
  }

  const nextStartsAt = input.starts_at ?? existing.starts_at;
  const nextEndsAt = input.ends_at ?? existing.ends_at;
  if (nextStartsAt >= nextEndsAt) {
    throw new AppError(400, 'INVALID_ARGUMENT', '`starts_at` must be less than `ends_at`');
  }

  if (input.monitor_ids !== undefined) {
    await ensureMonitorsExist(c.env.DB, normalizeIdList(input.monitor_ids));
  }

  const updated = await c.env.DB.prepare(
    `
      UPDATE maintenance_windows
      SET title = ?1, message = ?2, starts_at = ?3, ends_at = ?4,
          scope = CASE WHEN ?6 = 1 THEN 'monitors' ELSE scope END
      WHERE id = ?5
      RETURNING id, title, message, starts_at, ends_at, created_at
    `,
  )
    .bind(
      input.title ?? existing.title,
      input.message !== undefined ? input.message : existing.message,
      nextStartsAt,
      nextEndsAt,
      id,
      input.monitor_ids !== undefined ? 1 : 0,
    )
    .first<MaintenanceWindowRow>();

  if (!updated) {
    throw new AppError(500, 'INTERNAL', 'Failed to update maintenance window');
  }

  if (input.monitor_ids !== undefined) {
    const monitorIds = normalizeIdList(input.monitor_ids);

    const statements: D1PreparedStatement[] = [];
    statements.push(
      c.env.DB.prepare(
        `
          DELETE FROM maintenance_window_monitors
          WHERE maintenance_window_id = ?1
        `,
      ).bind(id),
    );
    for (const monitorId of monitorIds) {
      statements.push(
        c.env.DB.prepare(
          `
            INSERT INTO maintenance_window_monitors (maintenance_window_id, monitor_id, created_at)
            VALUES (?1, ?2, ?3)
          `,
        ).bind(id, monitorId, Math.floor(Date.now() / 1000)),
      );
    }

    await c.env.DB.batch(statements);
  }

  const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(c.env.DB, [id]);
  const monitorIds = monitorIdsByWindowId.get(id) ?? [];
  await bumpHomepageMaintenanceGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ maintenance_window: maintenanceWindowRowToApi(updated, monitorIds) });
});

adminRoutes.delete('/maintenance-windows/:id', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));

  const existing = await c.env.DB.prepare(
    `
      SELECT id
      FROM maintenance_windows
      WHERE id = ?1
    `,
  )
    .bind(id)
    .first<{ id: number }>();

  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Maintenance window not found');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `
        DELETE FROM maintenance_window_monitors
        WHERE maintenance_window_id = ?1
      `,
    ).bind(id),
    c.env.DB.prepare(
      `
        DELETE FROM maintenance_windows
        WHERE id = ?1
      `,
    ).bind(id),
  ]);

  await bumpHomepageMaintenanceGuardVersion(c.env.DB);
  queuePublicHomepageSnapshotRefresh(c);

  return c.json({ deleted: true });
});

// Build Hono's lazy matcher during isolate startup; this runs no handlers or I/O.
adminRoutes.router.match('GET', '/monitors');
