import { z } from 'zod';

import type { PublicHomepageResponse } from './public-homepage';

const SITE_LOCALES = new Set(['auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'es']);
const MONITOR_STATUSES = new Set(['up', 'down', 'maintenance', 'paused', 'unknown']);
const INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved']);
const INCIDENT_IMPACTS = new Set(['none', 'minor', 'major', 'critical']);
const BANNER_STATUSES = new Set([
  'operational',
  'partial_outage',
  'major_outage',
  'maintenance',
  'unknown',
]);

type StoredPublicHomepageRenderArtifact =
  | {
      generated_at: number;
      preload_html: string;
      meta_title: string;
      meta_description: string;
      snapshot: PublicHomepageResponse;
    }
  | {
      generated_at: number;
      preload_html: string;
      meta_title: string;
      meta_description: string;
      snapshot_json: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isPositiveInt(value: unknown): value is number {
  return isInt(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return isInt(value) && value >= 0;
}

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || isNonNegativeInt(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100;
}

function isNullableMilliPercent(value: unknown): value is number | null {
  return value === null || (isInt(value) && value >= 0 && value <= 100_000);
}

function isStringMember(set: ReadonlySet<string>, value: unknown): value is string {
  return typeof value === 'string' && set.has(value);
}

function isUptimeRatingLevel(value: unknown): value is number {
  return isInt(value) && value >= 1 && value <= 5;
}

function validateBanner(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!isStringMember(BANNER_STATUSES, value.status) || typeof value.title !== 'string') {
    return false;
  }

  if (value.source === 'incident') {
    return (
      value.incident === null ||
      (isRecord(value.incident) &&
        isPositiveInt(value.incident.id) &&
        typeof value.incident.title === 'string' &&
        isStringMember(INCIDENT_STATUSES, value.incident.status) &&
        isStringMember(INCIDENT_IMPACTS, value.incident.impact))
    );
  }

  if (value.source === 'maintenance') {
    return (
      value.maintenance_window === null ||
      (isRecord(value.maintenance_window) &&
        isPositiveInt(value.maintenance_window.id) &&
        typeof value.maintenance_window.title === 'string' &&
        isNonNegativeInt(value.maintenance_window.starts_at) &&
        isNonNegativeInt(value.maintenance_window.ends_at))
    );
  }

  if (value.source === 'monitors') {
    return (
      value.down_ratio === undefined ||
      value.down_ratio === null ||
      typeof value.down_ratio === 'number'
    );
  }

  return false;
}

function validateSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInt(value.up) &&
    isNonNegativeInt(value.down) &&
    isNonNegativeInt(value.maintenance) &&
    isNonNegativeInt(value.paused) &&
    isNonNegativeInt(value.unknown)
  );
}

function validateHeartbeatStrip(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.checked_at) &&
    value.checked_at.every(isNonNegativeInt) &&
    typeof value.status_codes === 'string' &&
    /^[udmx]*$/.test(value.status_codes) &&
    Array.isArray(value.latency_ms) &&
    value.latency_ms.every(isNullableNonNegativeInt)
  );
}

function validateUptimeSummaryPreview(value: unknown): boolean {
  return value === null || (isRecord(value) && isPercent(value.uptime_pct));
}

function validateUptimeDayStrip(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.day_start_at) &&
    value.day_start_at.every(isNonNegativeInt) &&
    Array.isArray(value.downtime_sec) &&
    value.downtime_sec.every(isNonNegativeInt) &&
    Array.isArray(value.unknown_sec) &&
    value.unknown_sec.every(isNonNegativeInt) &&
    Array.isArray(value.uptime_pct_milli) &&
    value.uptime_pct_milli.every(isNullableMilliPercent)
  );
}

function validateHomepageMonitorCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveInt(value.id) &&
    typeof value.name === 'string' &&
    (value.type === 'http' || value.type === 'tcp') &&
    (value.group_name === null ||
      (typeof value.group_name === 'string' && value.group_name.length > 0)) &&
    isStringMember(MONITOR_STATUSES, value.status) &&
    typeof value.is_stale === 'boolean' &&
    isNullableNonNegativeInt(value.last_checked_at) &&
    validateHeartbeatStrip(value.heartbeat_strip) &&
    validateUptimeSummaryPreview(value.uptime_30d) &&
    validateUptimeDayStrip(value.uptime_day_strip)
  );
}

function validateIncidentSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveInt(value.id) &&
    typeof value.title === 'string' &&
    isStringMember(INCIDENT_STATUSES, value.status) &&
    isStringMember(INCIDENT_IMPACTS, value.impact) &&
    isNullableString(value.message) &&
    isNonNegativeInt(value.started_at) &&
    isNullableNonNegativeInt(value.resolved_at)
  );
}

function validateMaintenancePreview(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveInt(value.id) &&
    typeof value.title === 'string' &&
    isNullableString(value.message) &&
    isNonNegativeInt(value.starts_at) &&
    isNonNegativeInt(value.ends_at) &&
    Array.isArray(value.monitor_ids) &&
    value.monitor_ids.every(isPositiveInt)
  );
}

function isStoredPublicHomepageResponse(value: unknown): value is PublicHomepageResponse {
  if (!isRecord(value)) {
    return false;
  }

  const maintenanceWindows = value.maintenance_windows;
  return (
    isNonNegativeInt(value.generated_at) &&
    (value.bootstrap_mode === 'full' || value.bootstrap_mode === 'partial') &&
    isNonNegativeInt(value.monitor_count_total) &&
    typeof value.site_title === 'string' &&
    typeof value.site_description === 'string' &&
    isStringMember(SITE_LOCALES, value.site_locale) &&
    typeof value.site_timezone === 'string' &&
    isUptimeRatingLevel(value.uptime_rating_level) &&
    isStringMember(MONITOR_STATUSES, value.overall_status) &&
    validateBanner(value.banner) &&
    validateSummary(value.summary) &&
    Array.isArray(value.monitors) &&
    value.monitors.every(validateHomepageMonitorCard) &&
    Array.isArray(value.active_incidents) &&
    value.active_incidents.every(validateIncidentSummary) &&
    isRecord(maintenanceWindows) &&
    Array.isArray(maintenanceWindows.active) &&
    maintenanceWindows.active.every(validateMaintenancePreview) &&
    Array.isArray(maintenanceWindows.upcoming) &&
    maintenanceWindows.upcoming.every(validateMaintenancePreview) &&
    (value.resolved_incident_preview === null ||
      validateIncidentSummary(value.resolved_incident_preview)) &&
    (value.maintenance_history_preview === null ||
      validateMaintenancePreview(value.maintenance_history_preview))
  );
}

function isStoredPublicHomepageRenderArtifact(
  value: unknown,
): value is StoredPublicHomepageRenderArtifact {
  if (
    !isRecord(value) ||
    !isNonNegativeInt(value.generated_at) ||
    typeof value.preload_html !== 'string' ||
    typeof value.meta_title !== 'string' ||
    typeof value.meta_description !== 'string'
  ) {
    return false;
  }

  if ('snapshot' in value) {
    return isStoredPublicHomepageResponse(value.snapshot);
  }

  return typeof value.snapshot_json === 'string' && value.snapshot_json.length > 0;
}

export const storedPublicHomepageResponseSchema = z.custom<PublicHomepageResponse>(
  isStoredPublicHomepageResponse,
);

export const publicHomepageStoredRenderArtifactSchema =
  z.custom<StoredPublicHomepageRenderArtifact>(isStoredPublicHomepageRenderArtifact);
