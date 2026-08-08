import { z } from 'zod';

const monitorStatusSchema = z.enum(['up', 'down', 'maintenance', 'paused', 'unknown']);
const checkStatusSchema = z.enum(['up', 'down', 'maintenance', 'unknown']);

const uptimeRatingLevelSchema = z.number().int().min(1).max(5);

const incidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring', 'resolved']);
const incidentImpactSchema = z.enum(['none', 'minor', 'major', 'critical']);

const incidentUpdateSchema = z.object({
  id: z.number().int().positive(),
  incident_id: z.number().int().positive(),
  status: incidentStatusSchema.nullable(),
  message: z.string(),
  created_at: z.number().int().nonnegative(),
});

const incidentSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  status: incidentStatusSchema,
  impact: incidentImpactSchema,
  message: z.string().nullable(),
  started_at: z.number().int().nonnegative(),
  resolved_at: z.number().int().nonnegative().nullable(),
  monitor_ids: z.array(z.number().int().positive()),
  updates: z.array(incidentUpdateSchema),
});

const maintenanceWindowSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  message: z.string().nullable(),
  starts_at: z.number().int().nonnegative(),
  ends_at: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  monitor_ids: z.array(z.number().int().positive()),
});

const uptimeSummarySchema = z.object({
  range_start_at: z.number().int().nonnegative(),
  range_end_at: z.number().int().nonnegative(),
  total_sec: z.number().int().nonnegative(),
  downtime_sec: z.number().int().nonnegative(),
  unknown_sec: z.number().int().nonnegative(),
  uptime_sec: z.number().int().nonnegative(),
  uptime_pct: z.number().min(0).max(100),
});

const uptimeDaySchema = z.object({
  day_start_at: z.number().int().nonnegative(),
  total_sec: z.number().int().nonnegative(),
  downtime_sec: z.number().int().nonnegative(),
  unknown_sec: z.number().int().nonnegative(),
  uptime_sec: z.number().int().nonnegative(),
  uptime_pct: z.number().min(0).max(100).nullable(),
});

const heartbeatSchema = z.object({
  checked_at: z.number().int().nonnegative(),
  status: checkStatusSchema,
  latency_ms: z.number().int().nonnegative().nullable(),
});

const displayUrlSchema = z.string().url().nullable().catch(null);

const storedPublicMonitorSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.enum(['http', 'tcp']),
  display_url: displayUrlSchema,
  group_name: z.string().min(1).nullable(),
  group_sort_order: z.number().int(),
  sort_order: z.number().int(),
  uptime_rating_level: uptimeRatingLevelSchema,
  status: monitorStatusSchema,
  is_stale: z.boolean(),
  last_checked_at: z.number().int().nonnegative().nullable(),
  last_latency_ms: z.number().int().nonnegative().nullable(),
  heartbeats: z.array(heartbeatSchema),
  uptime_30d: uptimeSummarySchema.nullable(),
  uptime_days: z.array(uptimeDaySchema),
});

const publicMonitorSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.enum(['http', 'tcp']),
  display_url: displayUrlSchema,
  group_name: z.string().min(1).nullable(),
  group_sort_order: z.number().int(),
  sort_order: z.number().int(),
  uptime_rating_level: uptimeRatingLevelSchema,
  status: monitorStatusSchema,
  is_stale: z.boolean(),
  last_checked_at: z.number().int().nonnegative().nullable(),
  last_latency_ms: z.number().int().nonnegative().nullable(),

  // Last N checks (bounded in payload) for heartbeat bar.
  heartbeats: z.array(heartbeatSchema).optional().default([]),

  // 60-day availability computed from daily rollups (UTC full days).
  uptime_30d: uptimeSummarySchema.nullable(),

  // 60 daily points (oldest -> newest). Each entry is the day's total uptime.
  uptime_days: z.array(uptimeDaySchema),
});

const bannerSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('incident'),
    status: z.enum(['operational', 'partial_outage', 'major_outage', 'maintenance', 'unknown']),
    title: z.string(),
    incident: z
      .object({
        id: z.number().int().positive(),
        title: z.string(),
        status: incidentStatusSchema,
        impact: incidentImpactSchema,
      })
      .nullable(),
  }),
  z.object({
    source: z.literal('maintenance'),
    status: z.enum(['operational', 'partial_outage', 'major_outage', 'maintenance', 'unknown']),
    title: z.string(),
    maintenance_window: z
      .object({
        id: z.number().int().positive(),
        title: z.string(),
        starts_at: z.number().int().nonnegative(),
        ends_at: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
  z.object({
    source: z.literal('monitors'),
    status: z.enum(['operational', 'partial_outage', 'major_outage', 'maintenance', 'unknown']),
    title: z.string(),
    down_ratio: z.number().nullable().optional(),
  }),
]);

export const publicStatusResponseSchema = z.object({
  generated_at: z.number().int().nonnegative(),
  site_title: z.string().default('Uptimer'),
  site_description: z.string().default(''),
  logo_url: z.string().nullable().default(null),
  site_locale: z.enum(['auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'es']).default('auto'),
  site_timezone: z.string().default('UTC'),
  uptime_rating_level: uptimeRatingLevelSchema,
  overall_status: monitorStatusSchema,
  banner: bannerSchema,
  summary: z.object({
    up: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  monitors: z.array(publicMonitorSchema),
  active_incidents: z.array(incidentSchema),
  maintenance_windows: z.object({
    active: z.array(maintenanceWindowSchema),
    upcoming: z.array(maintenanceWindowSchema),
  }),
});

export const storedPublicStatusResponseSchema = z.object({
  generated_at: z.number().int().nonnegative(),
  site_title: z.string(),
  site_description: z.string(),
  logo_url: z.string().nullable().default(null),
  site_locale: z.enum(['auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'es']),
  site_timezone: z.string(),
  uptime_rating_level: uptimeRatingLevelSchema,
  overall_status: monitorStatusSchema,
  banner: bannerSchema,
  summary: z.object({
    up: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  monitors: z.array(storedPublicMonitorSchema),
  active_incidents: z.array(incidentSchema),
  maintenance_windows: z.object({
    active: z.array(maintenanceWindowSchema),
    upcoming: z.array(maintenanceWindowSchema),
  }),
});

export type PublicStatusResponse = z.infer<typeof publicStatusResponseSchema>;
