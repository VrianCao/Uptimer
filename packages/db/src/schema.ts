import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export type MonitorType = 'http' | 'tcp';
export type MonitorStatus = 'up' | 'down' | 'maintenance' | 'paused' | 'unknown';
export type CheckStatus = 'up' | 'down' | 'maintenance' | 'unknown';
export type HttpResponseMatchMode = 'contains' | 'regex';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';
export type NotificationChannelType = 'webhook';
export type NotificationDeliveryStatus = 'success' | 'failed';

export const monitors = sqliteTable(
  'monitors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').$type<MonitorType>().notNull(),
    target: text('target').notNull(),
    displayUrl: text('display_url'),

    intervalSec: integer('interval_sec').notNull().default(60),
    timeoutMs: integer('timeout_ms').notNull().default(10000),

    httpMethod: text('http_method'),
    httpHeadersJson: text('http_headers_json'),
    httpBody: text('http_body'),
    followRedirects: integer('follow_redirects', { mode: 'boolean' }).notNull().default(true),
    expectedStatusJson: text('expected_status_json'),
    forbiddenStatusJson: text('forbidden_status_json'),
    responseKeyword: text('response_keyword'),
    responseKeywordMode: text('response_keyword_mode').$type<HttpResponseMatchMode>(),
    responseForbiddenKeyword: text('response_forbidden_keyword'),
    responseForbiddenKeywordMode: text(
      'response_forbidden_keyword_mode',
    ).$type<HttpResponseMatchMode>(),

    groupName: text('group_name'),
    groupSortOrder: integer('group_sort_order').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    showOnStatusPage: integer('show_on_status_page', { mode: 'boolean' }).notNull().default(true),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    groupSortIdx: index('idx_monitors_group_sort').on(
      t.groupName,
      t.groupSortOrder,
      t.sortOrder,
      t.id,
    ),
  }),
);

export const monitorState = sqliteTable('monitor_state', {
  monitorId: integer('monitor_id').primaryKey(),
  status: text('status').$type<MonitorStatus>().notNull(),
  lastCheckedAt: integer('last_checked_at'),
  lastChangedAt: integer('last_changed_at'),
  lastLatencyMs: integer('last_latency_ms'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
});

export const checkResults = sqliteTable(
  'check_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitorId: integer('monitor_id').notNull(),
    checkedAt: integer('checked_at').notNull(),
    status: text('status').$type<CheckStatus>().notNull(),
    latencyMs: integer('latency_ms'),
    httpStatus: integer('http_status'),
    error: text('error'),
    location: text('location'),
    attempt: integer('attempt').notNull().default(1),
  },
  (t) => ({
    monitorTimeIdx: index('idx_check_results_monitor_time').on(t.monitorId, t.checkedAt),
  }),
);

export const outages = sqliteTable(
  'outages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitorId: integer('monitor_id').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    initialError: text('initial_error'),
    lastError: text('last_error'),
  },
  (t) => ({
    monitorStartIdx: index('idx_outages_monitor_start').on(t.monitorId, t.startedAt),
  }),
);

export const incidents = sqliteTable('incidents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  status: text('status').$type<IncidentStatus>().notNull(),
  impact: text('impact').$type<IncidentImpact>().notNull().default('minor'),
  message: text('message'),
  startedAt: integer('started_at')
    .notNull()
    .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  resolvedAt: integer('resolved_at'),
});

export const incidentUpdates = sqliteTable(
  'incident_updates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    incidentId: integer('incident_id').notNull(),
    status: text('status').$type<IncidentStatus>(),
    message: text('message').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    incidentTimeIdx: index('idx_incident_updates_incident_time').on(t.incidentId, t.createdAt),
  }),
);

export const incidentMonitors = sqliteTable(
  'incident_monitors',
  {
    incidentId: integer('incident_id').notNull(),
    monitorId: integer('monitor_id').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.incidentId, t.monitorId] }),
    monitorIdx: index('idx_incident_monitors_monitor').on(t.monitorId),
    incidentIdx: index('idx_incident_monitors_incident').on(t.incidentId),
  }),
);

export const maintenanceWindows = sqliteTable('maintenance_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  message: text('message'),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
});

export const maintenanceWindowMonitors = sqliteTable(
  'maintenance_window_monitors',
  {
    maintenanceWindowId: integer('maintenance_window_id').notNull(),
    monitorId: integer('monitor_id').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.maintenanceWindowId, t.monitorId] }),
    monitorIdx: index('idx_maintenance_window_monitors_monitor').on(t.monitorId),
    windowIdx: index('idx_maintenance_window_monitors_window').on(t.maintenanceWindowId),
  }),
);

export const statusPages = sqliteTable(
  'status_pages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    themeConfigJson: text('theme_config_json'),
    customHostname: text('custom_hostname'),
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    slugUniq: uniqueIndex('uq_status_pages_slug').on(t.slug),
    customHostnameUniq: uniqueIndex('uq_status_pages_custom_hostname')
      .on(t.customHostname)
      .where(sql`custom_hostname IS NOT NULL`),
  }),
);

export const statusPageMonitors = sqliteTable(
  'status_page_monitors',
  {
    statusPageId: integer('status_page_id').notNull(),
    monitorId: integer('monitor_id').notNull(),
    groupName: text('group_name'),
    groupSortOrder: integer('group_sort_order').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.statusPageId, t.monitorId] }),
    monitorIdx: index('idx_status_page_monitors_monitor').on(t.monitorId),
    pageSortIdx: index('idx_status_page_monitors_page_sort').on(
      t.statusPageId,
      t.groupSortOrder,
      t.groupName,
      t.sortOrder,
      t.monitorId,
    ),
  }),
);

export const statusPageIncidents = sqliteTable(
  'status_page_incidents',
  {
    statusPageId: integer('status_page_id').notNull(),
    incidentId: integer('incident_id').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.statusPageId, t.incidentId] }),
    incidentIdx: index('idx_status_page_incidents_incident').on(t.incidentId),
  }),
);

export const statusPageMaintenanceWindows = sqliteTable(
  'status_page_maintenance_windows',
  {
    statusPageId: integer('status_page_id').notNull(),
    maintenanceWindowId: integer('maintenance_window_id').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.statusPageId, t.maintenanceWindowId] }),
    windowIdx: index('idx_status_page_maintenance_windows_window').on(t.maintenanceWindowId),
  }),
);

export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').$type<NotificationChannelType>().notNull(),
  configJson: text('config_json').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
});

export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventKey: text('event_key').notNull(),
    channelId: integer('channel_id').notNull(),
    status: text('status').$type<NotificationDeliveryStatus>().notNull(),
    httpStatus: integer('http_status'),
    error: text('error'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    eventChannelUniq: uniqueIndex('uq_notification_event_channel').on(t.eventKey, t.channelId),
  }),
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const publicSnapshots = sqliteTable('public_snapshots', {
  key: text('key').primaryKey(),
  generatedAt: integer('generated_at').notNull(),
  bodyJson: text('body_json').notNull(),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
});

export const publicSnapshotGuardVersions = sqliteTable('public_snapshot_guard_versions', {
  key: text('key').primaryKey(),
  version: integer('version').notNull(),
  updatedAt: integer('updated_at').notNull(),
  stateJson: text('state_json'),
});

export const locks = sqliteTable('locks', {
  name: text('name').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
});

export const monitorDailyRollups = sqliteTable(
  'monitor_daily_rollups',
  {
    monitorId: integer('monitor_id').notNull(),
    dayStartAt: integer('day_start_at').notNull(),

    totalSec: integer('total_sec').notNull(),
    downtimeSec: integer('downtime_sec').notNull(),
    unknownSec: integer('unknown_sec').notNull(),
    uptimeSec: integer('uptime_sec').notNull(),

    checksTotal: integer('checks_total').notNull(),
    checksUp: integer('checks_up').notNull(),
    checksDown: integer('checks_down').notNull(),
    checksUnknown: integer('checks_unknown').notNull(),
    checksMaintenance: integer('checks_maintenance').notNull(),

    avgLatencyMs: integer('avg_latency_ms'),
    p50LatencyMs: integer('p50_latency_ms'),
    p95LatencyMs: integer('p95_latency_ms'),
    latencyHistogramJson: text('latency_histogram_json'),

    createdAt: integer('created_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(CAST(strftime('%s','now') AS INTEGER))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.monitorId, t.dayStartAt] }),
    dayIdx: index('idx_monitor_daily_rollups_day').on(t.dayStartAt),
    monitorDayIdx: index('idx_monitor_daily_rollups_monitor_day').on(t.monitorId, t.dayStartAt),
  }),
);
