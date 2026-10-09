import { z } from 'zod';

import { AppError } from '../middleware/errors';
import type { Trace } from '../observability/trace';
import { acquireLease, releaseLease } from '../scheduler/lock';
import { LeaseLostError, startRenewableLease } from '../scheduler/lease-guard';
import { primeHomepageRefreshBaseSnapshotCache } from './public-homepage-read';
import {
  publicHomepageResponseSchema,
  type PublicHomepageRenderArtifact,
  type PublicHomepageResponse,
  publicHomepageStoredRenderArtifactSchema,
  type StoredPublicHomepageRenderArtifact,
} from '../schemas/public-homepage';
import type { PublicSnapshotFragmentRow } from './public-fragments';

const SNAPSHOT_KEY = 'homepage';
const SNAPSHOT_ARTIFACT_KEY = 'homepage:artifact';
export const HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY = 'homepage:artifact:monitors';

const homepageArtifactMonitorFragmentSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  group_name: z.string().min(1).nullable(),
  card_html: z.string().min(1),
});
const MAX_AGE_SECONDS = 60;
const MAX_STALE_SECONDS = 10 * 60;
const REFRESH_LOCK_NAME = 'snapshot:homepage:refresh';
const REFRESH_LOCK_LEASE_SECONDS = 55;
const REFRESH_LOCK_RENEW_INTERVAL_MS = 15_000;
const REFRESH_LOCK_RENEW_MIN_REMAINING_SECONDS = 20;
const FUTURE_SNAPSHOT_TOLERANCE_SECONDS = 60;
const READ_SNAPSHOT_SQL = `
  SELECT generated_at, updated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;
const UPSERT_SNAPSHOT_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshots.generated_at
    OR public_snapshots.generated_at > ?5
`;
const UPSERT_SNAPSHOT_WHILE_LEASE_SQL = `
  INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
  SELECT ?1, ?2, ?3, ?4
  WHERE EXISTS (
    SELECT 1
    FROM locks refresh_lock
    WHERE refresh_lock.name = ?6
      AND refresh_lock.expires_at = ?7
      AND refresh_lock.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
  )
  ON CONFLICT(key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE (
      excluded.generated_at >= public_snapshots.generated_at
      OR public_snapshots.generated_at > ?5
    )
    AND EXISTS (
      SELECT 1
      FROM locks refresh_lock
      WHERE refresh_lock.name = ?6
        AND refresh_lock.expires_at = ?7
        AND refresh_lock.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
    )
`;
const SPLIT_SNAPSHOT_VERSION = 3;
const LEGACY_COMBINED_SNAPSHOT_VERSION = 2;

const readSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const upsertSnapshotWhileLeaseStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

function withTraceSync<T>(trace: Trace | undefined, name: string, fn: () => T): T {
  return trace ? trace.time(name, fn) : fn();
}

async function withTraceAsync<T>(
  trace: Trace | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return trace ? trace.timeAsync(name, fn) : await fn();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSnapshotText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(tsSec: number, cache?: Map<number, string>): string {
  if (cache?.has(tsSec)) {
    return cache.get(tsSec) ?? '';
  }

  let formatted = '';
  try {
    formatted = new Date(tsSec * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z');
  } catch {
    formatted = '';
  }

  cache?.set(tsSec, formatted);
  return formatted;
}

function monitorGroupLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : 'Ungrouped';
}

function uptimeFillFromMilli(uptimePctMilli: number | null | undefined): string {
  if (typeof uptimePctMilli !== 'number') return '#cbd5e1';
  if (uptimePctMilli >= 99_950) return '#10b981';
  if (uptimePctMilli >= 99_000) return '#84cc16';
  if (uptimePctMilli >= 95_000) return '#f59e0b';
  return '#ef4444';
}

function heartbeatFillFromCode(code: string | undefined): string {
  switch (code) {
    case 'u':
      return '#10b981';
    case 'd':
      return '#ef4444';
    case 'm':
      return '#3b82f6';
    case 'x':
    default:
      return '#cbd5e1';
  }
}

function heartbeatHeightPct(
  code: string | undefined,
  latencyMs: number | null | undefined,
): number {
  if (code === 'd') return 100;
  if (code === 'm') return 62;
  if (code !== 'u') return 48;
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return 74;
  return 36 + Math.min(64, Math.max(0, latencyMs / 12));
}

type StripRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
};

function buildStripSvgFromRects(rects: StripRect[], width: number, height: number): string {
  const pathByFill = new Map<string, string[]>();

  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const command = `M${rect.x},${rect.y}h${rect.width}v${rect.height}H${rect.x}z`;
    const existing = pathByFill.get(rect.fill);
    if (existing) {
      existing.push(command);
      continue;
    }
    pathByFill.set(rect.fill, [command]);
  }

  const paths: string[] = [];
  for (const [fill, commands] of pathByFill.entries()) {
    paths.push(`<path d="${commands.join('')}" fill="${fill}"/>`);
  }

  return `<svg class="usv" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${paths.join('')}</svg>`;
}

function buildUptimeStripSvg(
  strip: PublicHomepageResponse['monitors'][number]['uptime_day_strip'],
): string {
  const count = Math.min(
    strip.day_start_at.length,
    strip.downtime_sec.length,
    strip.unknown_sec.length,
    strip.uptime_pct_milli.length,
  );
  const barWidth = 4;
  const gap = 2;
  const height = 20;
  const width = count <= 0 ? barWidth : count * barWidth + Math.max(0, count - 1) * gap;
  const rects: StripRect[] = [];
  for (let index = 0; index < count; index += 1) {
    rects.push({
      x: index * (barWidth + gap),
      y: 0,
      width: barWidth,
      height,
      fill: uptimeFillFromMilli(strip.uptime_pct_milli[index]),
    });
  }
  return buildStripSvgFromRects(rects, width, height);
}

function buildHeartbeatStripSvg(
  strip: PublicHomepageResponse['monitors'][number]['heartbeat_strip'],
): string {
  const count = Math.min(
    strip.checked_at.length,
    strip.latency_ms.length,
    strip.status_codes.length,
  );
  const barWidth = 4;
  const gap = 2;
  const height = 20;
  const width = count <= 0 ? barWidth : count * barWidth + Math.max(0, count - 1) * gap;
  const rects: StripRect[] = [];
  for (let index = 0; index < count; index += 1) {
    const barHeight = Math.round(
      (height * heartbeatHeightPct(strip.status_codes[index], strip.latency_ms[index])) / 100,
    );
    rects.push({
      x: index * (barWidth + gap),
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
      fill: heartbeatFillFromCode(strip.status_codes[index]),
    });
  }
  return buildStripSvgFromRects(rects, width, height);
}

function renderIncidentCard(
  incident: PublicHomepageResponse['active_incidents'][number],
  formatTimestamp: (tsSec: number) => string,
): string {
  const impactVariant =
    incident.impact === 'major' || incident.impact === 'critical' ? 'down' : 'paused';

  const parts: string[] = [
    `<article class="card"><div class="row"><h4 class="mn">${escapeHtml(incident.title)}</h4><span class="sb sb-${impactVariant}">${escapeHtml(incident.impact)}</span></div><div class="ft">${formatTimestamp(incident.started_at)}</div>`,
  ];
  if (incident.message) {
    parts.push(`<p class="bt">${escapeHtml(incident.message)}</p>`);
  }
  parts.push('</article>');
  return parts.join('');
}

function renderMaintenanceCard(
  window: NonNullable<PublicHomepageResponse['maintenance_history_preview']>,
  monitorNames: ReadonlyMap<number, string>,
  formatTimestamp: (tsSec: number) => string,
): string {
  const affected: string[] = [];
  for (let index = 0; index < window.monitor_ids.length; index += 1) {
    const monitorId = window.monitor_ids[index];
    if (typeof monitorId !== 'number') {
      continue;
    }
    affected.push(escapeHtml(monitorNames.get(monitorId) || `#${monitorId}`));
  }

  const parts: string[] = [
    `<article class="card"><div><h4 class="mn">${escapeHtml(window.title)}</h4><div class="ft">${formatTimestamp(window.starts_at)} - ${formatTimestamp(window.ends_at)}</div></div>`,
  ];
  if (affected.length > 0) {
    parts.push(`<div class="bt">Affected: ${affected.join(', ')}</div>`);
  }
  if (window.message) {
    parts.push(`<p class="bt">${escapeHtml(window.message)}</p>`);
  }
  parts.push('</article>');
  return parts.join('');
}

function renderHomepageMonitorPreloadCard(
  monitor: PublicHomepageResponse['monitors'][number],
  formatTimestamp: (tsSec: number) => string,
): string {
  const uptimePct =
    typeof monitor.uptime_30d?.uptime_pct === 'number'
      ? `${monitor.uptime_30d.uptime_pct.toFixed(3)}%`
      : '-';
  const status = monitor.status;
  const statusLabel = escapeHtml(status);
  const lastCheckedLabel = monitor.last_checked_at
    ? `Last checked: ${formatTimestamp(monitor.last_checked_at)}`
    : 'Never checked';

  return `<article class="card"><div class="row"><div class="lhs"><span class="dot dot-${status}"></span><div class="ut"><div class="mn">${escapeHtml(monitor.name)}</div><div class="mt">${escapeHtml(monitor.type)}</div></div></div><div class="rhs"><span class="up">${escapeHtml(uptimePct)}</span><span class="sb sb-${status}">${statusLabel}</span></div></div><div><div class="lbl">Availability (60d)</div><div class="strip">${buildUptimeStripSvg(monitor.uptime_day_strip)}</div></div><div><div class="lbl">Recent checks</div><div class="strip">${buildHeartbeatStripSvg(monitor.heartbeat_strip)}</div></div><div class="ft">${lastCheckedLabel}</div></article>`;
}

export function renderHomepageMonitorPreloadCardFragment(
  monitor: PublicHomepageResponse['monitors'][number],
): string {
  const timeCache = new Map<number, string>();
  const formatTimestamp = (tsSec: number) => escapeHtml(formatTime(tsSec, timeCache));
  return renderHomepageMonitorPreloadCard(monitor, formatTimestamp);
}

export type HomepageArtifactMonitorFragment = z.infer<typeof homepageArtifactMonitorFragmentSchema>;

export type HomepageArtifactMonitorFragmentParseResult = {
  cardHtmlByMonitorId: Map<number, string>;
  monitorNameById: Map<number, string>;
  invalidCount: number;
  staleCount: number;
  missingCount: number;
};

export function buildHomepageArtifactMonitorFragmentWrites(
  payload: PublicHomepageResponse,
  updatedAt: number,
  monitorIds?: Iterable<number>,
): Array<{
  snapshotKey: string;
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
}> {
  const selectedMonitorIds = monitorIds ? new Set(monitorIds) : null;
  const writes: Array<{
    snapshotKey: string;
    fragmentKey: string;
    generatedAt: number;
    bodyJson: string;
    updatedAt: number;
  }> = [];

  for (const monitor of payload.monitors) {
    if (selectedMonitorIds && !selectedMonitorIds.has(monitor.id)) {
      continue;
    }
    writes.push({
      snapshotKey: HOMEPAGE_ARTIFACT_MONITOR_FRAGMENTS_KEY,
      fragmentKey: `monitor:${monitor.id}`,
      generatedAt: payload.generated_at,
      bodyJson: JSON.stringify({
        id: monitor.id,
        name: monitor.name,
        group_name: monitor.group_name,
        card_html: renderHomepageMonitorPreloadCardFragment(monitor),
      }),
      updatedAt,
    });
  }

  return writes;
}

function parseHomepageArtifactMonitorFragmentKey(fragmentKey: string): number | null {
  if (!fragmentKey.startsWith('monitor:')) {
    return null;
  }
  const parsed = Number.parseInt(fragmentKey.slice('monitor:'.length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseHomepageArtifactMonitorFragmentRows(
  rows: readonly PublicSnapshotFragmentRow[],
  snapshot: PublicHomepageResponse,
): HomepageArtifactMonitorFragmentParseResult {
  const cardHtmlByMonitorId = new Map<number, string>();
  const monitorNameById = new Map<number, string>();
  const expectedMonitorIds = new Set(snapshot.monitors.map((monitor) => monitor.id));
  let invalidCount = 0;
  let staleCount = 0;

  for (const row of rows) {
    const monitorId = parseHomepageArtifactMonitorFragmentKey(row.fragment_key);
    if (monitorId === null || !expectedMonitorIds.has(monitorId)) {
      invalidCount += 1;
      continue;
    }
    if (row.generated_at !== snapshot.generated_at) {
      staleCount += 1;
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(row.body_json) as unknown;
    } catch {
      invalidCount += 1;
      continue;
    }
    const parsed = homepageArtifactMonitorFragmentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== monitorId) {
      invalidCount += 1;
      continue;
    }
    cardHtmlByMonitorId.set(monitorId, parsed.data.card_html);
    monitorNameById.set(monitorId, parsed.data.name);
  }

  let missingCount = 0;
  for (const monitorId of expectedMonitorIds) {
    if (!cardHtmlByMonitorId.has(monitorId)) {
      missingCount += 1;
    }
  }

  return {
    cardHtmlByMonitorId,
    monitorNameById,
    invalidCount,
    staleCount,
    missingCount,
  };
}

function renderPreload(
  snapshot: PublicHomepageResponse,
  monitorNameById?: ReadonlyMap<number, string>,
  monitorCardHtmlById?: ReadonlyMap<number, string>,
): string {
  const overall = snapshot.overall_status;
  const siteTitle = snapshot.site_title;
  const siteDescription = snapshot.site_description;
  const bannerTitle = snapshot.banner.title;
  const generatedAt = snapshot.generated_at;
  const timeCache = new Map<number, string>();
  const formatTimestamp = (tsSec: number) => escapeHtml(formatTime(tsSec, timeCache));
  const needsMonitorNames =
    snapshot.maintenance_windows.active.length > 0 ||
    snapshot.maintenance_windows.upcoming.length > 0 ||
    snapshot.maintenance_history_preview !== null;
  const monitorNames: ReadonlyMap<number, string> | null = needsMonitorNames
    ? (monitorNameById ?? new Map(snapshot.monitors.map((monitor) => [monitor.id, monitor.name])))
    : null;
  const groups = new Map<string, PublicHomepageResponse['monitors']>();
  for (const monitor of snapshot.monitors) {
    const key = monitorGroupLabel(monitor.group_name);
    const existing = groups.get(key) ?? [];
    existing.push(monitor);
    groups.set(key, existing);
  }

  const groupedMonitorsParts: string[] = [];
  for (const [groupName, groupMonitors] of groups.entries()) {
    const monitorCardsParts: string[] = [];
    for (const monitor of groupMonitors) {
      monitorCardsParts.push(
        monitorCardHtmlById?.get(monitor.id) ??
          renderHomepageMonitorPreloadCard(monitor, formatTimestamp),
      );
    }

    groupedMonitorsParts.push(
      `<section class="sg"><div class="sgh"><h4 class="sgt">${escapeHtml(groupName)}</h4><span class="sgc">${groupMonitors.length}</span></div><div class="grid">${monitorCardsParts.join('')}</div></section>`,
    );
  }

  const activeMaintenance = snapshot.maintenance_windows.active;
  const upcomingMaintenance = snapshot.maintenance_windows.upcoming;
  let maintenanceSection = '';
  if (activeMaintenance.length > 0 || upcomingMaintenance.length > 0) {
    const activeCards: string[] = [];
    for (const window of activeMaintenance) {
      if (monitorNames) {
        activeCards.push(renderMaintenanceCard(window, monitorNames, formatTimestamp));
      }
    }
    const upcomingCards: string[] = [];
    for (const window of upcomingMaintenance) {
      if (monitorNames) {
        upcomingCards.push(renderMaintenanceCard(window, monitorNames, formatTimestamp));
      }
    }

    maintenanceSection = `<section class="sec"><h3 class="sh">Scheduled Maintenance</h3>${activeCards.length > 0 ? `<div class="st">${activeCards.join('')}</div>` : ''}${upcomingCards.length > 0 ? `<div class="st">${upcomingCards.join('')}</div>` : ''}</section>`;
  }

  let incidentSection = '';
  if (snapshot.active_incidents.length > 0) {
    const incidentCards: string[] = [];
    for (const incident of snapshot.active_incidents) {
      incidentCards.push(renderIncidentCard(incident, formatTimestamp));
    }
    incidentSection = `<section class="sec"><h3 class="sh">Active Incidents</h3><div class="st">${incidentCards.join('')}</div></section>`;
  }

  const incidentHistory = snapshot.resolved_incident_preview
    ? renderIncidentCard(snapshot.resolved_incident_preview, formatTimestamp)
    : '<div class="card">No past incidents</div>';
  const maintenanceHistory = snapshot.maintenance_history_preview
    ? monitorNames
      ? renderMaintenanceCard(snapshot.maintenance_history_preview, monitorNames, formatTimestamp)
      : '<div class="card">No past maintenance</div>'
    : '<div class="card">No past maintenance</div>';
  const descriptionHtml = siteDescription
    ? `<div class="ud">${escapeHtml(siteDescription)}</div>`
    : '';
  return `<div class="hp"><header class="uh"><div class="uw uhw"><div class="ut"><div class="un">${escapeHtml(siteTitle)}</div>${descriptionHtml}</div><span class="sb sb-${overall}">${escapeHtml(overall)}</span></div></header><main class="uw um"><section class="bn"><div class="bt">${escapeHtml(bannerTitle)}</div><div class="bu">Updated: ${formatTimestamp(generatedAt)}</div></section>${maintenanceSection}${incidentSection}<section class="sec"><h3 class="sh">Services</h3>${groupedMonitorsParts.join('')}</section><section class="sec ih"><div><h3 class="sh">Incident History</h3>${incidentHistory}</div><div><h3 class="sh">Maintenance History</h3>${maintenanceHistory}</div></section></main></div>`;
}

function toFullHomepageSnapshot(snapshot: PublicHomepageResponse): PublicHomepageResponse {
  return {
    ...snapshot,
    bootstrap_mode: 'full',
    monitor_count_total: snapshot.monitors.length,
  };
}

function buildHomepageRenderArtifactWithPreloadOptions(
  snapshot: PublicHomepageResponse,
  opts: {
    monitorNameById?: ReadonlyMap<number, string>;
    monitorCardHtmlById?: ReadonlyMap<number, string>;
  } = {},
): StoredPublicHomepageRenderArtifact {
  const fullSnapshot = toFullHomepageSnapshot(snapshot);
  const needsMonitorNames =
    fullSnapshot.maintenance_windows.active.length > 0 ||
    fullSnapshot.maintenance_windows.upcoming.length > 0 ||
    fullSnapshot.maintenance_history_preview !== null;
  const allMonitorNames = needsMonitorNames
    ? (opts.monitorNameById ??
      new Map(fullSnapshot.monitors.map((monitor) => [monitor.id, monitor.name])))
    : undefined;
  const metaTitle = normalizeSnapshotText(fullSnapshot.site_title, 'Uptimer');
  const fallbackDescription = normalizeSnapshotText(
    fullSnapshot.banner.title,
    'Real-time status and incident updates.',
  );
  const metaDescription = normalizeSnapshotText(fullSnapshot.site_description, fallbackDescription)
    .replace(/\s+/g, ' ')
    .trim();

  return {
    generated_at: fullSnapshot.generated_at,
    preload_html: `<div id="uptimer-preload">${renderPreload(
      fullSnapshot,
      allMonitorNames,
      opts.monitorCardHtmlById,
    )}</div>`,
    snapshot: fullSnapshot,
    meta_title: metaTitle,
    meta_description: metaDescription,
  };
}

export function buildHomepageRenderArtifact(
  snapshot: PublicHomepageResponse,
): StoredPublicHomepageRenderArtifact {
  return buildHomepageRenderArtifactWithPreloadOptions(snapshot);
}

export function buildHomepageRenderArtifactFromMonitorFragments(
  snapshot: PublicHomepageResponse,
  rows: readonly PublicSnapshotFragmentRow[],
): {
  artifact: StoredPublicHomepageRenderArtifact | null;
} & HomepageArtifactMonitorFragmentParseResult {
  const parsed = parseHomepageArtifactMonitorFragmentRows(rows, snapshot);
  if (parsed.missingCount > 0 || parsed.staleCount > 0 || parsed.invalidCount > 0) {
    return {
      ...parsed,
      artifact: null,
    };
  }

  return {
    ...parsed,
    artifact: buildHomepageRenderArtifactWithPreloadOptions(snapshot, {
      monitorNameById: parsed.monitorNameById,
      monitorCardHtmlById: parsed.cardHtmlByMonitorId,
    }),
  };
}

function normalizeDirectHomepagePayload(value: unknown): PublicHomepageResponse | null {
  const directPayload = publicHomepageResponseSchema.safeParse(value);
  if (directPayload.success) {
    return directPayload.data;
  }

  if (!isRecord(value)) return null;

  const normalizedPayload = publicHomepageResponseSchema.safeParse({
    ...value,
    bootstrap_mode:
      value.bootstrap_mode === 'full' || value.bootstrap_mode === 'partial'
        ? value.bootstrap_mode
        : 'full',
    monitor_count_total: Array.isArray(value.monitors) ? value.monitors.length : 0,
  });
  return normalizedPayload.success ? normalizedPayload.data : null;
}

function readStoredHomepageSnapshotData(value: unknown): PublicHomepageResponse | null {
  const artifact = publicHomepageStoredRenderArtifactSchema.safeParse(value);
  if (artifact.success) {
    if ('snapshot' in artifact.data) {
      return artifact.data.snapshot;
    }
    return readStoredHomepageSnapshotData(safeJsonParse(artifact.data.snapshot_json));
  }

  if (!isRecord(value)) return null;

  const version = value.version;
  if (version === SPLIT_SNAPSHOT_VERSION || version === LEGACY_COMBINED_SNAPSHOT_VERSION) {
    return normalizeDirectHomepagePayload(value.data);
  }

  return normalizeDirectHomepagePayload(value);
}

function readStoredHomepageSnapshotRender(value: unknown): PublicHomepageRenderArtifact | null {
  const artifact = publicHomepageStoredRenderArtifactSchema.safeParse(value);
  if (artifact.success) {
    if ('snapshot' in artifact.data) {
      return artifact.data;
    }
    const snapshot = readStoredHomepageSnapshotData(safeJsonParse(artifact.data.snapshot_json));
    if (!snapshot) {
      return null;
    }
    return {
      generated_at: artifact.data.generated_at,
      preload_html: artifact.data.preload_html,
      snapshot,
      meta_title: artifact.data.meta_title,
      meta_description: artifact.data.meta_description,
    };
  }

  if (!isRecord(value)) return null;
  const version = value.version;
  if (version !== SPLIT_SNAPSHOT_VERSION && version !== LEGACY_COMBINED_SNAPSHOT_VERSION) {
    return null;
  }

  const legacyRender = publicHomepageStoredRenderArtifactSchema.safeParse(value.render);
  return legacyRender.success ? readStoredHomepageSnapshotRender(legacyRender.data) : null;
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

async function readSnapshotRow(
  db: D1Database,
  key: string,
): Promise<{ generated_at: number; updated_at?: number | null; body_json: string } | null> {
  try {
    const cached = readSnapshotStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_SNAPSHOT_SQL);
    if (!cached) {
      readSnapshotStatementByDb.set(db, statement);
    }

    return await statement
      .bind(key)
      .first<{ generated_at: number; updated_at?: number | null; body_json: string }>();
  } catch (err) {
    console.warn('homepage snapshot: read failed', err);
    return null;
  }
}

async function readHomepageSnapshotRow(db: D1Database) {
  return readSnapshotRow(db, SNAPSHOT_KEY);
}

async function readHomepageArtifactSnapshotRow(db: D1Database) {
  return readSnapshotRow(db, SNAPSHOT_ARTIFACT_KEY);
}

async function readSnapshotRowsByPriority(
  db: D1Database,
): Promise<Array<{ generated_at: number; updated_at?: number | null; body_json: string }>> {
  const [artifactRow, homepageRow] = await Promise.all([
    readHomepageArtifactSnapshotRow(db),
    readHomepageSnapshotRow(db),
  ]);

  return [artifactRow, homepageRow].filter(
    (row): row is { generated_at: number; updated_at?: number | null; body_json: string } =>
      row !== null,
  );
}

function normalizeHomepagePayloadBodyJson(bodyJson: string): string | null {
  const parsed = safeJsonParse(bodyJson);
  if (parsed === null) {
    return null;
  }

  const data = readStoredHomepageSnapshotData(parsed);
  return data ? JSON.stringify(data) : null;
}

function normalizeHomepageArtifactBodyJson(bodyJson: string): string | null {
  const parsed = safeJsonParse(bodyJson);
  if (parsed === null) {
    return null;
  }

  const directArtifact = publicHomepageStoredRenderArtifactSchema.safeParse(parsed);
  if (directArtifact.success) {
    if (
      !('snapshot' in directArtifact.data) &&
      !readStoredHomepageSnapshotData(safeJsonParse(directArtifact.data.snapshot_json))
    ) {
      return null;
    }
    return JSON.stringify(directArtifact.data);
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const version = parsed.version;
  if (version !== SPLIT_SNAPSHOT_VERSION && version !== LEGACY_COMBINED_SNAPSHOT_VERSION) {
    return null;
  }

  const legacyArtifact = publicHomepageStoredRenderArtifactSchema.safeParse(parsed.render);
  if (!legacyArtifact.success) {
    return null;
  }
  if (
    !('snapshot' in legacyArtifact.data) &&
    !readStoredHomepageSnapshotData(safeJsonParse(legacyArtifact.data.snapshot_json))
  ) {
    return null;
  }
  return JSON.stringify(legacyArtifact.data);
}

function readSnapshotValueFromRows<T>(opts: {
  rows: ReadonlyArray<{ generated_at: number; updated_at?: number | null; body_json: string }>;
  now: number;
  maxAgeSeconds: number;
  warning: string;
  normalize: (bodyJson: string) => T | null;
  ageFromUpdatedAt?: boolean;
}): { value: T; age: number } | null {
  let freshest: { value: T; age: number } | null = null;

  for (const row of opts.rows) {
    if (row.generated_at > opts.now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS) {
      continue;
    }
    const ageBase =
      opts.ageFromUpdatedAt && typeof row.updated_at === 'number'
        ? row.updated_at
        : row.generated_at;
    const age = Math.max(0, opts.now - ageBase);
    if (age > opts.maxAgeSeconds) {
      continue;
    }

    const value = opts.normalize(row.body_json);
    if (value === null) {
      console.warn(opts.warning);
      continue;
    }

    if (freshest === null || row.generated_at > opts.now - freshest.age) {
      freshest = { value, age };
    }
  }

  return freshest;
}

function isSameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60) === Math.floor(b / 60);
}

export function getHomepageSnapshotKey() {
  return SNAPSHOT_KEY;
}

export function getHomepageSnapshotArtifactKey() {
  return SNAPSHOT_ARTIFACT_KEY;
}

export function getHomepageSnapshotMaxAgeSeconds() {
  return MAX_AGE_SECONDS;
}

export function getHomepageSnapshotMaxStaleSeconds() {
  return MAX_STALE_SECONDS;
}

export async function readHomepageSnapshot(
  db: D1Database,
  now: number,
): Promise<{ data: PublicHomepageResponse; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_AGE_SECONDS,
    warning: 'homepage snapshot: invalid payload',
    normalize: (bodyJson) => {
      const parsed = safeJsonParse(bodyJson);
      if (parsed === null) {
        return null;
      }
      return readStoredHomepageSnapshotData(parsed);
    },
  });
  return snapshot ? { data: snapshot.value, age: snapshot.age } : null;
}

export async function readHomepageSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_AGE_SECONDS,
    warning: 'homepage snapshot: invalid payload',
    normalize: normalizeHomepagePayloadBodyJson,
  });
  return snapshot ? { bodyJson: snapshot.value, age: snapshot.age } : null;
}

export async function readStaleHomepageSnapshot(
  db: D1Database,
  now: number,
): Promise<{ data: PublicHomepageResponse; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_STALE_SECONDS,
    warning: 'homepage snapshot: invalid stale payload',
    normalize: (bodyJson) => {
      const parsed = safeJsonParse(bodyJson);
      if (parsed === null) {
        return null;
      }
      return readStoredHomepageSnapshotData(parsed);
    },
  });
  return snapshot ? { data: snapshot.value, age: snapshot.age } : null;
}

export async function readStaleHomepageSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_STALE_SECONDS,
    warning: 'homepage snapshot: invalid stale payload',
    normalize: normalizeHomepagePayloadBodyJson,
  });
  return snapshot ? { bodyJson: snapshot.value, age: snapshot.age } : null;
}

export async function readHomepageSnapshotArtifact(
  db: D1Database,
  now: number,
): Promise<{ data: PublicHomepageRenderArtifact; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_AGE_SECONDS,
    warning: 'homepage snapshot: invalid render payload',
    normalize: (bodyJson) => {
      const parsed = safeJsonParse(bodyJson);
      if (parsed === null) {
        return null;
      }
      return readStoredHomepageSnapshotRender(parsed);
    },
  });
  return snapshot ? { data: snapshot.value, age: snapshot.age } : null;
}

export async function readHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_AGE_SECONDS,
    warning: 'homepage snapshot: invalid render payload',
    normalize: normalizeHomepageArtifactBodyJson,
    ageFromUpdatedAt: true,
  });
  return snapshot ? { bodyJson: snapshot.value, age: snapshot.age } : null;
}

export async function readStaleHomepageSnapshotArtifact(
  db: D1Database,
  now: number,
): Promise<{ data: PublicHomepageRenderArtifact; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_STALE_SECONDS,
    warning: 'homepage snapshot: invalid stale render payload',
    normalize: (bodyJson) => {
      const parsed = safeJsonParse(bodyJson);
      if (parsed === null) {
        return null;
      }
      return readStoredHomepageSnapshotRender(parsed);
    },
    ageFromUpdatedAt: true,
  });
  return snapshot ? { data: snapshot.value, age: snapshot.age } : null;
}

export async function readStaleHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const rows = await readSnapshotRowsByPriority(db);
  const snapshot = readSnapshotValueFromRows({
    rows,
    now,
    maxAgeSeconds: MAX_STALE_SECONDS,
    warning: 'homepage snapshot: invalid stale render payload',
    normalize: normalizeHomepageArtifactBodyJson,
    ageFromUpdatedAt: true,
  });
  return snapshot ? { bodyJson: snapshot.value, age: snapshot.age } : null;
}

export async function readHomepageSnapshotGeneratedAt(db: D1Database): Promise<number | null> {
  const rows = await readSnapshotRowsByPriority(db);
  let freshest: number | null = null;

  for (const row of rows) {
    if (!normalizeHomepagePayloadBodyJson(row.body_json)) {
      continue;
    }
    if (freshest === null || row.generated_at > freshest) {
      freshest = row.generated_at;
    }
  }

  return freshest;
}

export async function readHomepageArtifactSnapshotGeneratedAt(
  db: D1Database,
): Promise<number | null> {
  const row = await readHomepageArtifactSnapshotRow(db);
  if (!row) {
    return null;
  }

  return normalizeHomepageArtifactBodyJson(row.body_json) ? row.generated_at : null;
}

function homepageSnapshotUpsertStatement(
  db: D1Database,
  key: string,
  generatedAt: number,
  bodyJson: string,
  updatedAt: number,
  futureCutoffAt: number,
  lease?: {
    name: string;
    expiresAt: number;
  },
): D1PreparedStatement {
  const cached = lease
    ? upsertSnapshotWhileLeaseStatementByDb.get(db)
    : upsertSnapshotStatementByDb.get(db);
  const statement =
    cached ?? db.prepare(lease ? UPSERT_SNAPSHOT_WHILE_LEASE_SQL : UPSERT_SNAPSHOT_SQL);
  if (!cached) {
    if (lease) {
      upsertSnapshotWhileLeaseStatementByDb.set(db, statement);
    } else {
      upsertSnapshotStatementByDb.set(db, statement);
    }
  }

  return lease
    ? statement.bind(
        key,
        generatedAt,
        bodyJson,
        updatedAt,
        futureCutoffAt,
        lease.name,
        lease.expiresAt,
      )
    : statement.bind(key, generatedAt, bodyJson, updatedAt, futureCutoffAt);
}

function didApplySnapshotWrite(result: Awaited<ReturnType<D1PreparedStatement['run']>>): boolean {
  const changes = result?.meta?.changes;
  if (typeof changes === 'number' && Number.isFinite(changes)) {
    return changes > 0;
  }
  return true;
}

export function didApplyHomepageSnapshotWrite(
  result: Awaited<ReturnType<D1PreparedStatement['run']>>,
): boolean {
  return didApplySnapshotWrite(result);
}

async function releaseRefreshLease(
  db: D1Database,
  trace: Trace | undefined,
  spanName: string,
  lease: ReturnType<typeof startRenewableLease>,
): Promise<void> {
  try {
    await lease.stop();
  } catch (err) {
    console.warn('homepage snapshot: failed to stop refresh lease renewal', err);
  }

  try {
    await withTraceAsync(
      trace,
      spanName,
      async () => await releaseLease(db, REFRESH_LOCK_NAME, lease.getExpiresAt()),
    );
  } catch (err) {
    console.warn('homepage snapshot: failed to release refresh lease', err);
  }
}

type HomepageRefreshLeaseGuard = Pick<ReturnType<typeof startRenewableLease>, 'assertHeld'>;
type HomepageRefreshLeaseToken = {
  name: string;
  expiresAt: number;
};
type HomepageRefreshLease = HomepageRefreshLeaseGuard & {
  getExpiresAt: () => number;
};

export type PreparedHomepageSnapshotWrite = {
  statement: D1PreparedStatement;
  payloadStatement?: D1PreparedStatement;
  generatedAt: number;
  prime: () => void;
};

export function prepareHomepageSnapshotWrite(
  db: D1Database,
  now: number,
  payload: PublicHomepageResponse,
  trace?: Trace,
  _seedDataSnapshot = false,
  lease?: {
    name: string;
    expiresAt: number;
  },
  writePayloadSnapshot = false,
): PreparedHomepageSnapshotWrite {
  const payloadBodyJson = writePayloadSnapshot
    ? withTraceSync(trace, 'homepage_write_stringify_payload', () => JSON.stringify(payload))
    : null;
  const render = withTraceSync(trace, 'homepage_write_render', () =>
    buildHomepageRenderArtifact(payload),
  );
  const renderBodyJson = withTraceSync(trace, 'homepage_write_stringify_artifact', () =>
    JSON.stringify(render),
  );
  if (trace?.enabled) {
    trace.setLabel('homepage_payload_monitors', payload.monitors.length);
    trace.setLabel('homepage_payload_bytes', payloadBodyJson?.length ?? 0);
    trace.setLabel('homepage_artifact_bytes', renderBodyJson.length);
  }

  return {
    statement: homepageSnapshotUpsertStatement(
      db,
      SNAPSHOT_ARTIFACT_KEY,
      render.generated_at,
      renderBodyJson,
      now,
      now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
      lease,
    ),
    ...(writePayloadSnapshot
      ? {
          payloadStatement: homepageSnapshotUpsertStatement(
            db,
            SNAPSHOT_KEY,
            render.generated_at,
            payloadBodyJson ?? '',
            now,
            now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
            lease,
          ),
        }
      : {}),
    generatedAt: render.generated_at,
    prime: () => {
      primeHomepageRefreshBaseSnapshotCache({
        db,
        generatedAt: render.generated_at,
        updatedAt: now,
        snapshot: payload,
        renderBodyJson,
        payloadBodyJson,
      });
    },
  };
}

export async function writeHomepageSnapshot(
  db: D1Database,
  now: number,
  payload: PublicHomepageResponse,
  trace?: Trace,
  seedDataSnapshot = false,
  lease?: HomepageRefreshLeaseToken,
): Promise<boolean> {
  const prepared = prepareHomepageSnapshotWrite(db, now, payload, trace, seedDataSnapshot, lease);

  const writeResult = await withTraceAsync(
    trace,
    'homepage_write_artifact_run',
    async () => await prepared.statement.run(),
  );
  const wrote = didApplySnapshotWrite(writeResult);
  if (!wrote) {
    return false;
  }

  prepared.prime();
  return true;
}

export async function writeHomepageArtifactSnapshot(
  db: D1Database,
  now: number,
  payload: PublicHomepageResponse,
  trace?: Trace,
  lease?: HomepageRefreshLeaseToken,
): Promise<boolean> {
  const render = withTraceSync(trace, 'homepage_artifact_write_render', () =>
    buildHomepageRenderArtifact(payload),
  );
  const renderBodyJson = withTraceSync(trace, 'homepage_artifact_write_stringify', () =>
    JSON.stringify(render),
  );

  const writeResult = await withTraceAsync(
    trace,
    'homepage_artifact_write_run',
    async () =>
      await homepageSnapshotUpsertStatement(
        db,
        SNAPSHOT_ARTIFACT_KEY,
        render.generated_at,
        renderBodyJson,
        now,
        now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS,
        lease,
      ).run(),
  );
  const wrote = didApplySnapshotWrite(writeResult);
  if (!wrote) {
    return false;
  }

  primeHomepageRefreshBaseSnapshotCache({
    db,
    generatedAt: render.generated_at,
    updatedAt: now,
    snapshot: payload,
    renderBodyJson,
  });
  return true;
}

export function applyHomepageCacheHeaders(res: Response, ageSeconds: number): void {
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(30, remaining);
  const stale = Math.max(0, remaining - maxAge);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
  );
}

export function toHomepageSnapshotPayload(value: unknown): PublicHomepageResponse {
  const parsed = publicHomepageResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, 'INTERNAL', 'Failed to generate homepage snapshot');
  }
  return parsed.data;
}

export async function refreshPublicHomepageSnapshot(opts: {
  db: D1Database;
  now: number;
  compute: () => Promise<unknown>;
  trace?: Trace;
  seedDataSnapshot?: boolean;
  lease?: HomepageRefreshLease;
}): Promise<boolean> {
  opts.lease?.assertHeld('computing homepage snapshot');
  const computed = await withTraceAsync(
    opts.trace,
    'homepage_refresh_compute',
    async () => await opts.compute(),
  );
  const payload = withTraceSync(opts.trace, 'homepage_refresh_validate', () =>
    toHomepageSnapshotPayload(computed),
  );
  opts.lease?.assertHeld('writing homepage snapshot');
  return await writeHomepageSnapshot(
    opts.db,
    opts.now,
    payload,
    opts.trace,
    opts.seedDataSnapshot ?? false,
    opts.lease
      ? {
          name: REFRESH_LOCK_NAME,
          expiresAt: opts.lease.getExpiresAt(),
        }
      : undefined,
  );
}

export async function refreshPublicHomepageArtifactSnapshot(opts: {
  db: D1Database;
  now: number;
  compute: () => Promise<unknown>;
  trace?: Trace;
  lease?: HomepageRefreshLease;
}): Promise<boolean> {
  opts.lease?.assertHeld('computing homepage artifact snapshot');
  const computed = await withTraceAsync(
    opts.trace,
    'homepage_artifact_refresh_compute',
    async () => await opts.compute(),
  );
  const payload = withTraceSync(opts.trace, 'homepage_artifact_refresh_validate', () =>
    toHomepageSnapshotPayload(computed),
  );
  opts.lease?.assertHeld('writing homepage artifact snapshot');
  return await writeHomepageArtifactSnapshot(
    opts.db,
    opts.now,
    payload,
    opts.trace,
    opts.lease
      ? {
          name: REFRESH_LOCK_NAME,
          expiresAt: opts.lease.getExpiresAt(),
        }
      : undefined,
  );
}

export async function refreshPublicHomepageSnapshotIfNeeded(opts: {
  db: D1Database;
  now: number;
  compute: () => Promise<unknown>;
  trace?: Trace;
  force?: boolean;
  seedDataSnapshot?: boolean;
}): Promise<boolean> {
  if (!opts.force) {
    const generatedAt = await withTraceAsync(
      opts.trace,
      'homepage_refresh_read_generated_at_1',
      async () => await readHomepageSnapshotGeneratedAt(opts.db),
    );
    if (generatedAt !== null && isSameMinute(generatedAt, opts.now)) {
      return false;
    }
  }

  const acquired = await withTraceAsync(
    opts.trace,
    'homepage_refresh_lease',
    async () =>
      await acquireLease(opts.db, REFRESH_LOCK_NAME, opts.now, REFRESH_LOCK_LEASE_SECONDS),
  );
  if (!acquired) {
    return false;
  }
  const refreshLease = startRenewableLease({
    db: opts.db,
    name: REFRESH_LOCK_NAME,
    leaseSeconds: REFRESH_LOCK_LEASE_SECONDS,
    initialExpiresAt: opts.now + REFRESH_LOCK_LEASE_SECONDS,
    renewIntervalMs: REFRESH_LOCK_RENEW_INTERVAL_MS,
    renewMinRemainingSeconds: REFRESH_LOCK_RENEW_MIN_REMAINING_SECONDS,
    logPrefix: 'homepage refresh',
  });

  try {
    if (!opts.force) {
      const latestGeneratedAt = await withTraceAsync(
        opts.trace,
        'homepage_refresh_read_generated_at_2',
        async () => await readHomepageSnapshotGeneratedAt(opts.db),
      );
      if (latestGeneratedAt !== null && isSameMinute(latestGeneratedAt, opts.now)) {
        return false;
      }
    }

    const wrote = await withTraceAsync(
      opts.trace,
      'homepage_refresh_write',
      async () =>
        await refreshPublicHomepageSnapshot({
          ...opts,
          lease: refreshLease,
        }),
    );
    return wrote;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      return false;
    }
    throw err;
  } finally {
    await releaseRefreshLease(opts.db, opts.trace, 'homepage_refresh_release_lease', refreshLease);
  }
}

export async function refreshPublicHomepageArtifactSnapshotIfNeeded(opts: {
  db: D1Database;
  now: number;
  compute: () => Promise<unknown>;
  trace?: Trace;
}): Promise<boolean> {
  const generatedAt = await withTraceAsync(
    opts.trace,
    'homepage_artifact_refresh_read_generated_at_1',
    async () => await readHomepageArtifactSnapshotGeneratedAt(opts.db),
  );
  if (generatedAt !== null && isSameMinute(generatedAt, opts.now)) {
    return false;
  }

  const acquired = await withTraceAsync(
    opts.trace,
    'homepage_artifact_refresh_lease',
    async () =>
      await acquireLease(opts.db, REFRESH_LOCK_NAME, opts.now, REFRESH_LOCK_LEASE_SECONDS),
  );
  if (!acquired) {
    return false;
  }
  const refreshLease = startRenewableLease({
    db: opts.db,
    name: REFRESH_LOCK_NAME,
    leaseSeconds: REFRESH_LOCK_LEASE_SECONDS,
    initialExpiresAt: opts.now + REFRESH_LOCK_LEASE_SECONDS,
    renewIntervalMs: REFRESH_LOCK_RENEW_INTERVAL_MS,
    renewMinRemainingSeconds: REFRESH_LOCK_RENEW_MIN_REMAINING_SECONDS,
    logPrefix: 'homepage artifact refresh',
  });

  try {
    const latestGeneratedAt = await withTraceAsync(
      opts.trace,
      'homepage_artifact_refresh_read_generated_at_2',
      async () => await readHomepageArtifactSnapshotGeneratedAt(opts.db),
    );
    if (latestGeneratedAt !== null && isSameMinute(latestGeneratedAt, opts.now)) {
      return false;
    }

    const wrote = await withTraceAsync(
      opts.trace,
      'homepage_artifact_refresh_write',
      async () =>
        await refreshPublicHomepageArtifactSnapshot({
          ...opts,
          lease: refreshLease,
        }),
    );
    return wrote;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      return false;
    }
    throw err;
  } finally {
    await releaseRefreshLease(
      opts.db,
      opts.trace,
      'homepage_artifact_refresh_release_lease',
      refreshLease,
    );
  }
}
