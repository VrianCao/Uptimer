import type { PublicMonitorRuntimeSnapshot } from './monitor-runtime';
import type { PublicStatusResponse } from '../schemas/public-status';
import { batchSnapshotReads } from './batched-reads';

import {
  buildPublicMonitorCards,
  buildPublicStatusBanner,
  incidentRowToApi,
  listIncidentUpdatesByIncidentId,
  readVisibleActiveIncidentSummary,
  listVisibleMaintenanceWindows,
  maintenanceWindowRowToApi,
  readPublicSiteSettings,
} from './data';

export type PublicStatusGenerationContext = {
  envelope: Omit<PublicStatusResponse, 'monitors'>;
  maintenanceMonitorIds: number[];
  monitorIds?: number[];
  rangeStart?: number;
};

export async function computePublicStatusPayload(
  db: D1Database,
  now: number,
  opts: {
    includeHiddenMonitors?: boolean;
    monitorSlice?: { offset: number; limit: number };
    onMonitorIds?: (ids: number[]) => void;
    runtimeSnapshot?: PublicMonitorRuntimeSnapshot | null;
    onMaintenanceMonitorIds?: (ids: number[]) => void;
    onRangeStart?: (rangeStart: number) => void;
    generationContext?: PublicStatusGenerationContext;
  } = {},
): Promise<PublicStatusResponse> {
  if (opts.monitorSlice) db = batchSnapshotReads(db);
  const includeHiddenMonitors = opts.includeHiddenMonitors ?? false;

  if (opts.generationContext) {
    const context = opts.generationContext;
    const monitorData = await buildPublicMonitorCards(db, now, {
      ...opts,
      includeHiddenMonitors,
      presentationContext: {
        maintenanceMonitorIds: context.maintenanceMonitorIds,
        uptimeRatingLevel: context.envelope.uptime_rating_level as 1 | 2 | 3 | 4 | 5,
        ...(context.monitorIds && context.rangeStart !== undefined
          ? { monitorIds: context.monitorIds, rangeStart: context.rangeStart }
          : {}),
      },
    });
    return { ...context.envelope, generated_at: now, monitors: monitorData.monitors };
  }

  const [monitorData, activeIncidentSummary, maintenanceWindows, settings] = await Promise.all([
    buildPublicMonitorCards(db, now, { ...opts, includeHiddenMonitors }),
    readVisibleActiveIncidentSummary(db, includeHiddenMonitors),
    listVisibleMaintenanceWindows(db, now, includeHiddenMonitors),
    readPublicSiteSettings(db),
  ]);
  const activeIncidents = activeIncidentSummary.items;

  const incidentUpdatesByIncidentId = await listIncidentUpdatesByIncidentId(
    db,
    activeIncidents.map((entry) => entry.row.id),
  );

  return {
    generated_at: now,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: monitorData.uptimeRatingLevel,
    overall_status: monitorData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: monitorData.summary,
      monitorCount: Object.values(monitorData.summary).reduce((sum, count) => sum + count, 0),
      activeIncidents,
      activeMaintenanceWindows: maintenanceWindows.active,
      bannerIncident: activeIncidentSummary.bannerIncident,
    }),
    summary: monitorData.summary,
    monitors: monitorData.monitors,
    active_incidents: activeIncidents.map(({ row, monitorIds }) =>
      incidentRowToApi(row, incidentUpdatesByIncidentId.get(row.id) ?? [], monitorIds),
    ),
    maintenance_windows: {
      active: maintenanceWindows.active.map(({ row, monitorIds }) =>
        maintenanceWindowRowToApi(row, monitorIds),
      ),
      upcoming: maintenanceWindows.upcoming.map(({ row, monitorIds }) =>
        maintenanceWindowRowToApi(row, monitorIds),
      ),
    },
  };
}
