import { Hono } from 'hono';
import { z } from 'zod';

import { rangeToSeconds, type UptimeRange } from '../analytics/uptime';
import type { Env } from '../env';
import { AppError } from '../middleware/errors';

export const adminExportsRoutes = new Hono<{ Bindings: Env }>();

const exportRangeSchema = z.enum(['24h', '7d', '30d', '90d']);
const exportChecksRangeSchema = z.enum(['24h', '7d']);

function computeRange(range: UptimeRange): { start: number; end: number } {
  const now = Math.floor(Date.now() / 1000);

  if (range === '24h') {
    const end = Math.floor(now / 60) * 60;
    return { start: end - rangeToSeconds(range), end };
  }

  // Include the current (partial) UTC day so exports match on-screen analytics.
  const end = Math.floor(now / 60) * 60;
  return { start: end - rangeToSeconds(range), end };
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function toCsvRow(values: Array<string | number | null>): string {
  return (
    values
      .map((v) => {
        if (v === null) return '';
        return csvEscape(String(v));
      })
      .join(',') + '\n'
  );
}

adminExportsRoutes.get('/monitors/:id/outages.csv', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = exportRangeSchema
    .optional()
    .default('30d')
    .parse(c.req.query('range')) as UptimeRange;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .default(5000)
    .parse(c.req.query('limit'));

  const monitor = await c.env.DB.prepare(`SELECT id, created_at FROM monitors WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) throw new AppError(404, 'NOT_FOUND', 'Monitor not found');

  const { start: rangeStartBase, end: rangeEnd } = computeRange(range);
  const rangeStart = Math.max(rangeStartBase, monitor.created_at);

  const { results } = await c.env.DB.prepare(
    `
      SELECT id, started_at, ended_at, initial_error, last_error
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
      ORDER BY id DESC
      LIMIT ?4
    `,
  )
    .bind(id, rangeEnd, rangeStart, limit)
    .all<{
      id: number;
      started_at: number;
      ended_at: number | null;
      initial_error: string | null;
      last_error: string | null;
    }>();

  let csv = '';
  csv += toCsvRow(['id', 'monitor_id', 'started_at', 'ended_at', 'initial_error', 'last_error']);
  for (const r of results ?? []) {
    csv += toCsvRow([r.id, id, r.started_at, r.ended_at, r.initial_error, r.last_error]);
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="outages-monitor-${id}-${range}.csv"`,
    },
  });
});

adminExportsRoutes.get('/monitors/:id/check-results.csv', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = exportChecksRangeSchema
    .optional()
    .default('24h')
    .parse(c.req.query('range')) as UptimeRange;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .default(10000)
    .parse(c.req.query('limit'));

  const monitor = await c.env.DB.prepare(`SELECT id, created_at FROM monitors WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) throw new AppError(404, 'NOT_FOUND', 'Monitor not found');

  const { start: rangeStartBase, end: rangeEnd } = computeRange(range);
  const rangeStart = Math.max(rangeStartBase, monitor.created_at);

  const { results } = await c.env.DB.prepare(
    `
      SELECT checked_at, status, latency_ms, http_status, error, location, attempt
      FROM check_results
      WHERE monitor_id = ?1
        AND storage_shard = CAST((?1 - 1) / 4 AS INTEGER)
        AND bucket_start_at >= (?2) - 3599
        AND checked_at >= ?2
        AND checked_at < ?3
      ORDER BY checked_at
      LIMIT ?4
    `,
  )
    .bind(id, rangeStart, rangeEnd, limit)
    .all<{
      checked_at: number;
      status: string;
      latency_ms: number | null;
      http_status: number | null;
      error: string | null;
      location: string | null;
      attempt: number;
    }>();

  let csv = '';
  csv += toCsvRow([
    'monitor_id',
    'checked_at',
    'status',
    'latency_ms',
    'http_status',
    'error',
    'location',
    'attempt',
  ]);
  for (const r of results ?? []) {
    csv += toCsvRow([
      id,
      r.checked_at,
      r.status,
      r.latency_ms,
      r.http_status,
      r.error,
      r.location,
      r.attempt,
    ]);
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="check-results-monitor-${id}-${range}.csv"`,
    },
  });
});

adminExportsRoutes.get('/incidents.csv', async (c) => {
  const range = exportRangeSchema
    .optional()
    .default('90d')
    .parse(c.req.query('range')) as UptimeRange;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .default(2000)
    .parse(c.req.query('limit'));

  const { start: rangeStart, end: rangeEnd } = computeRange(range);

  const { results: incidentRows } = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE started_at < ?2 AND (resolved_at IS NULL OR resolved_at > ?1)
      ORDER BY id DESC
      LIMIT ?3
    `,
  )
    .bind(rangeStart, rangeEnd, limit)
    .all<{
      id: number;
      title: string;
      status: string;
      impact: string;
      message: string | null;
      started_at: number;
      resolved_at: number | null;
    }>();

  const incidents = incidentRows ?? [];
  const incidentIds = incidents.map((r) => r.id);

  const monitorIdsByIncidentId = new Map<number, number[]>();
  if (incidentIds.length > 0) {
    const { results: linkRows } = await c.env.DB.prepare(
      `
        SELECT incident_id, monitor_id
        FROM incident_monitors
        WHERE incident_id IN (SELECT value FROM json_each(?1))
        ORDER BY incident_id, monitor_id
      `,
    )
      .bind(JSON.stringify(incidentIds))
      .all<{ incident_id: number; monitor_id: number }>();

    for (const r of linkRows ?? []) {
      const list = monitorIdsByIncidentId.get(r.incident_id) ?? [];
      list.push(r.monitor_id);
      monitorIdsByIncidentId.set(r.incident_id, list);
    }
  }

  let csv = '';
  csv += toCsvRow([
    'id',
    'title',
    'status',
    'impact',
    'started_at',
    'resolved_at',
    'monitor_ids',
    'message',
  ]);
  for (const r of incidents) {
    const monitorIds = monitorIdsByIncidentId.get(r.id) ?? [];
    csv += toCsvRow([
      r.id,
      r.title,
      r.status,
      r.impact,
      r.started_at,
      r.resolved_at,
      JSON.stringify(monitorIds),
      r.message,
    ]);
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="incidents-${range}.csv"`,
    },
  });
});
