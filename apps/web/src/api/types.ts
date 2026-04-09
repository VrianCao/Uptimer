// API Response Types

export type MonitorStatus = 'up' | 'down' | 'maintenance' | 'paused' | 'unknown';
export type CheckStatus = 'up' | 'down' | 'maintenance' | 'unknown';
export type MonitorType = 'http' | 'tcp';
export type HttpResponseMatchMode = 'contains' | 'regex';
export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'es';
export type LocaleSetting = 'auto' | SupportedLocale;

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface IncidentUpdate {
  id: number;
  incident_id: number;
  status: IncidentStatus | null;
  message: string;
  created_at: number;
}

export interface Incident {
  id: number;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
  monitor_ids: number[];
  updates: IncidentUpdate[];
}

export interface MaintenanceWindow {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
  monitor_ids: number[];
}

export interface Heartbeat {
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
}

export interface UptimeSummary {
  range_start_at: number;
  range_end_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number;
}

export type UptimeColorTier =
  | 'emerald'
  | 'green'
  | 'lime'
  | 'yellow'
  | 'amber'
  | 'orange'
  | 'red'
  | 'rose'
  | 'slate';
export type UptimeRatingLevel = 1 | 2 | 3 | 4 | 5;

export interface UptimeDay {
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number | null;
}

export interface UptimeDayPreview {
  day_start_at: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_pct: number | null;
}

export interface UptimeSummaryPreview {
  uptime_pct: number;
}

export interface PublicMonitor {
  id: number;
  name: string;
  type: MonitorType;
  group_name: string | null;
  group_sort_order: number;
  sort_order: number;
  uptime_rating_level: UptimeRatingLevel;
  status: MonitorStatus;
  is_stale: boolean;
  last_checked_at: number | null;
  last_latency_ms: number | null;

  heartbeats: Heartbeat[];

  uptime_30d: UptimeSummary | null;
  uptime_days: UptimeDay[];
}

export interface StatusResponse {
  generated_at: number;
  site_title: string;
  site_description: string;
  site_locale: LocaleSetting;
  site_timezone: string;
  uptime_rating_level: 1 | 2 | 3 | 4 | 5;
  overall_status: MonitorStatus;
  banner: {
    source: 'incident' | 'maintenance' | 'monitors';
    status: 'operational' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown';
    title: string;
    incident?: { id: number; title: string; status: IncidentStatus; impact: IncidentImpact } | null;
    maintenance_window?: { id: number; title: string; starts_at: number; ends_at: number } | null;
    down_ratio?: number;
  };
  summary: {
    up: number;
    down: number;
    maintenance: number;
    paused: number;
    unknown: number;
  };
  monitors: PublicMonitor[];
  active_incidents: Incident[];
  maintenance_windows: {
    active: MaintenanceWindow[];
    upcoming: MaintenanceWindow[];
  };
}

export interface IncidentSummary {
  id: number;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
}

export interface MaintenanceWindowPreview {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  monitor_ids: number[];
}

export interface HomepageMonitorCard {
  id: number;
  name: string;
  type: MonitorType;
  group_name: string | null;
  status: MonitorStatus;
  is_stale: boolean;
  last_checked_at: number | null;
  heartbeats: Heartbeat[];
  uptime_30d: UptimeSummaryPreview | null;
  uptime_days: UptimeDayPreview[];
}

export interface PublicHomepageResponse {
  generated_at: number;
  site_title: string;
  site_description: string;
  site_locale: LocaleSetting;
  site_timezone: string;
  uptime_rating_level: UptimeRatingLevel;
  overall_status: MonitorStatus;
  banner: StatusResponse['banner'];
  summary: StatusResponse['summary'];
  monitors: HomepageMonitorCard[];
  active_incidents: IncidentSummary[];
  maintenance_windows: {
    active: MaintenanceWindowPreview[];
    upcoming: MaintenanceWindowPreview[];
  };
  resolved_incident_preview: IncidentSummary | null;
  maintenance_history_preview: MaintenanceWindowPreview | null;
}

export interface LatencyPoint {
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
}

export interface LatencyResponse {
  monitor: { id: number; name: string };
  range: '24h';
  range_start_at: number;
  range_end_at: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  points: LatencyPoint[];
}

export interface UptimeResponse {
  monitor: { id: number; name: string };
  range: '24h' | '7d' | '30d';
  range_start_at: number;
  range_end_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number;
}

export type AnalyticsRange = '24h' | '7d' | '30d' | '90d';
export type AnalyticsOverviewRange = '24h' | '7d';

export interface AnalyticsOverviewResponse {
  range: AnalyticsOverviewRange;
  range_start_at: number;
  range_end_at: number;
  monitors: { total: number };
  totals: {
    total_sec: number;
    downtime_sec: number;
    uptime_sec: number;
    uptime_pct: number;
  };
  alerts: { count: number };
  outages: { longest_sec: number | null; mttr_sec: number | null };
}

export interface MonitorAnalyticsDayPoint {
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  checks_total: number;
  checks_up: number;
  checks_down: number;
  checks_unknown: number;
  checks_maintenance: number;
}

export interface MonitorAnalyticsResponse {
  monitor: { id: number; name: string; type: MonitorType };
  range: AnalyticsRange;
  range_start_at: number;
  range_end_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
  uptime_pct: number;
  unknown_pct: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  checks: { total: number; up: number; down: number; unknown: number; maintenance: number };
  points: LatencyPoint[];
  daily: MonitorAnalyticsDayPoint[];
}

export interface Outage {
  id: number;
  monitor_id: number;
  started_at: number;
  ended_at: number | null;
  initial_error: string | null;
  last_error: string | null;
}

export interface PublicDayContextResponse {
  day_start_at: number;
  day_end_at: number;
  maintenance_windows: MaintenanceWindow[];
  incidents: Incident[];
}

export interface MonitorOutagesResponse {
  range: AnalyticsRange;
  range_start_at: number;
  range_end_at: number;
  outages: Outage[];
  next_cursor: number | null;
}

export interface PublicUptimeOverviewResponse {
  generated_at: number;
  range: '30d' | '90d';
  range_start_at: number;
  range_end_at: number;
  overall: {
    total_sec: number;
    downtime_sec: number;
    unknown_sec: number;
    uptime_sec: number;
    uptime_pct: number;
  };
  monitors: Array<{
    id: number;
    name: string;
    type: MonitorType;
    total_sec: number;
    downtime_sec: number;
    unknown_sec: number;
    uptime_sec: number;
    uptime_pct: number;
  }>;
}

// Admin Types

export interface AdminMonitor {
  id: number;
  name: string;
  type: MonitorType;
  target: string;
  group_name: string | null;
  group_sort_order: number;
  sort_order: number;
  show_on_status_page: boolean;
  interval_sec: number;
  timeout_ms: number;
  http_method: string | null;
  http_headers_json: Record<string, string> | null;
  http_body: string | null;
  expected_status_json: number[] | null;
  response_keyword: string | null;
  response_keyword_mode: HttpResponseMatchMode | null;
  response_forbidden_keyword: string | null;
  response_forbidden_keyword_mode: HttpResponseMatchMode | null;
  is_active: boolean;
  created_at: number;
  updated_at: number;

  // Runtime state (from monitor_state)
  status: MonitorStatus;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
}

export interface CreateMonitorInput {
  name: string;
  type: MonitorType;
  target: string;
  group_name?: string;
  group_sort_order?: number;
  sort_order?: number;
  show_on_status_page?: boolean;
  interval_sec?: number;
  timeout_ms?: number;
  http_method?: string;
  http_headers_json?: Record<string, string>;
  http_body?: string;
  expected_status_json?: number[];
  response_keyword?: string;
  response_keyword_mode?: HttpResponseMatchMode;
  response_forbidden_keyword?: string;
  response_forbidden_keyword_mode?: HttpResponseMatchMode;
  is_active?: boolean;
}

export interface PatchMonitorInput {
  name?: string;
  target?: string;
  group_name?: string | null;
  group_sort_order?: number;
  sort_order?: number;
  show_on_status_page?: boolean;
  interval_sec?: number;
  timeout_ms?: number;
  http_method?: string;
  http_headers_json?: Record<string, string> | null;
  http_body?: string | null;
  expected_status_json?: number[] | null;
  response_keyword?: string | null;
  response_keyword_mode?: HttpResponseMatchMode | null;
  response_forbidden_keyword?: string | null;
  response_forbidden_keyword_mode?: HttpResponseMatchMode | null;
  is_active?: boolean;
}

export interface ReorderMonitorGroupsInput {
  groups: Array<{
    group_name: string | null;
    group_sort_order: number;
  }>;
}

export interface ReorderMonitorGroupsResult {
  updated_groups: number;
  affected_monitors: number;
}

export interface AssignMonitorsToGroupInput {
  monitor_ids: number[];
  group_name: string | null;
  group_sort_order?: number;
}

export interface AssignMonitorsToGroupResult {
  group_name: string | null;
  group_sort_order: number;
  updated_monitors: number;
}

export interface MonitorTestResult {
  monitor: { id: number; name: string; type: MonitorType };
  result: {
    status: CheckStatus;
    latency_ms: number | null;
    http_status: number | null;
    error: string | null;
    attempts: number;
  };
}

export interface WebhookChannelConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  timeout_ms?: number;
  payload_type?: 'json' | 'param' | 'x-www-form-urlencoded';
  message_template?: string;
  payload_template?: unknown;
  enabled_events?: Array<
    | 'monitor.down'
    | 'monitor.up'
    | 'incident.created'
    | 'incident.updated'
    | 'incident.resolved'
    | 'maintenance.started'
    | 'maintenance.ended'
    | 'test.ping'
  >;
  signing?: {
    enabled: boolean;
    secret_ref: string;
  };
}

export interface NotificationChannel {
  id: number;
  name: string;
  type: 'webhook';
  config_json: WebhookChannelConfig;
  is_active: boolean;
  created_at: number;
}

export interface CreateNotificationChannelInput {
  name: string;
  type?: 'webhook';
  config_json: WebhookChannelConfig;
  is_active?: boolean;
}

export interface PatchNotificationChannelInput {
  name?: string;
  config_json?: WebhookChannelConfig;
  is_active?: boolean;
}

export interface NotificationChannelTestResult {
  event_key: string;
  delivery: {
    status: string;
    http_status: number | null;
    error: string | null;
    created_at: number;
  } | null;
}

export interface PublicIncidentsResponse {
  incidents: Incident[];
  next_cursor: number | null;
}

export interface PublicMaintenanceWindowsResponse {
  maintenance_windows: MaintenanceWindow[];
  next_cursor: number | null;
}

export interface AdminIncidentsResponse {
  incidents: Incident[];
}

export interface CreateIncidentInput {
  title: string;
  status?: Exclude<IncidentStatus, 'resolved'>;
  impact?: IncidentImpact;
  message?: string;
  started_at?: number;
  monitor_ids: number[];
}

export interface CreateIncidentUpdateInput {
  message: string;
  status?: Exclude<IncidentStatus, 'resolved'>;
}

export interface ResolveIncidentInput {
  message?: string;
}

export interface CreateMaintenanceWindowInput {
  title: string;
  message?: string;
  starts_at: number;
  ends_at: number;
  monitor_ids: number[];
}

export interface PatchMaintenanceWindowInput {
  title?: string;
  message?: string | null;
  starts_at?: number;
  ends_at?: number;
  monitor_ids?: number[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// Admin settings (non-sensitive, stored in D1 settings table)
export interface AdminSettings {
  site_title: string;
  site_description: string;
  site_locale: LocaleSetting;
  site_timezone: string;

  retention_check_results_days: number;

  state_failures_to_down_from_up: number;
  state_successes_to_up_from_down: number;

  admin_default_overview_range: '24h' | '7d';
  admin_default_monitor_range: '24h' | '7d' | '30d' | '90d';

  uptime_rating_level: UptimeRatingLevel;
}

export interface AdminSettingsResponse {
  settings: AdminSettings;
}
