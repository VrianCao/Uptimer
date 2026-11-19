import { z } from 'zod';

import { monitorVisibilityPredicate } from './visibility';

const count = z.number().int().nonnegative();
const envelopeSchema = z.object({
  monitor_ids_json: z.string().transform((raw, ctx) => {
    try {
      return z.array(z.number().int().positive()).parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid monitor IDs' });
      return z.NEVER;
    }
  }),
  maintenance_ids_json: z.string().transform((raw, ctx) => {
    try {
      return z.array(z.number().int().positive()).parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid maintenance IDs' });
      return z.NEVER;
    }
  }),
  earliest_created_at: count.nullable(),
  up: count,
  down: count,
  maintenance: count,
  paused: count,
  unknown: count,
  rating: z.string().nullable(),
});

// The envelope needs counts and IDs, not thirty partially built monitor cards.
// Keep the same visibility, ordering, maintenance and stale-state precedence.
export async function readPublicMonitorEnvelope(
  db: D1Database,
  now: number,
  includeHidden: boolean,
) {
  const result = await db
    .prepare(
      `
    WITH visible AS MATERIALIZED (
      SELECT m.id,m.created_at,m.group_sort_order,m.group_name,m.sort_order,
        s.status,s.last_checked_at,m.interval_sec,
        EXISTS(SELECT 1 FROM maintenance_window_monitors mwm
          JOIN maintenance_windows mw ON mw.id=mwm.maintenance_window_id
          WHERE mwm.monitor_id=m.id AND mw.starts_at<=?1 AND mw.ends_at>?1) AS maintained
      FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id=m.id
      WHERE m.is_active=1 AND ${monitorVisibilityPredicate(includeHidden, 'm')}
    ), classified AS MATERIALIZED (
      SELECT id,created_at,maintained,
        CASE WHEN maintained THEN 'maintenance'
          WHEN status IN ('paused','maintenance') THEN status
          WHEN last_checked_at IS NULL OR ?1-last_checked_at>interval_sec*2 THEN 'unknown'
          WHEN status IN ('up','down') THEN status ELSE 'unknown' END AS status
      FROM visible ORDER BY group_sort_order,
        lower(CASE WHEN group_name IS NULL OR trim(group_name)='' THEN 'Ungrouped' ELSE trim(group_name) END),
        sort_order,id
    )
    SELECT json_group_array(id) AS monitor_ids_json,
      json_group_array(id) FILTER (WHERE maintained) AS maintenance_ids_json,
      min(created_at) AS earliest_created_at,
      coalesce(sum(status='up'),0) AS up,coalesce(sum(status='down'),0) AS down,
      coalesce(sum(status='maintenance'),0) AS maintenance,
      coalesce(sum(status='paused'),0) AS paused,coalesce(sum(status='unknown'),0) AS unknown,
      (SELECT value FROM settings WHERE key='uptime_rating_level') AS rating
    FROM classified
  `,
    )
    .bind(now)
    .first();
  const row = envelopeSchema.parse(result);
  const { up, down, maintenance, paused, unknown } = row;
  const summary = { up, down, maintenance, paused, unknown };
  const overallStatus =
    down > 0
      ? 'down'
      : unknown > 0
        ? 'unknown'
        : maintenance > 0
          ? 'maintenance'
          : up > 0
            ? 'up'
            : paused > 0
              ? 'paused'
              : 'unknown';
  const rating = Number.parseInt(row.rating ?? '', 10);
  const uptimeRatingLevel = Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : 3;
  return {
    summary,
    overallStatus,
    uptimeRatingLevel: uptimeRatingLevel as 1 | 2 | 3 | 4 | 5,
    monitorIds: row.monitor_ids_json,
    maintenanceMonitorIds: row.maintenance_ids_json,
    earliestCreatedAt: row.earliest_created_at,
  } as const;
}
