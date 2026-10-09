import { describe, expect, it } from 'vitest';

import {
  bumpHomepageIncidentGuardVersion,
  bumpHomepageMaintenanceGuardVersion,
  bumpHomepageMonitorGuardVersions,
  bumpHomepageSettingsGuardVersion,
  computeHomepageGuardValidUntil,
  readHomepageGuardCacheState,
  writeHomepageGuardCacheState,
  type HomepageGuardVersions,
} from '../src/public/homepage-guard-state';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function validStateJson(versions: HomepageGuardVersions, validUntil = 1_700_000_060): string {
  return JSON.stringify({
    schema_version: 1,
    include_hidden_monitors: false,
    generated_at: 1_700_000_000,
    valid_until: validUntil,
    versions: {
      settings: versions.settings,
      monitor_metadata: versions.monitorMetadata,
      incidents: versions.incidents,
      maintenance: versions.maintenance,
    },
    guard_state: {
      settings: {
        site_title: 'Uptimer',
        site_description: '',
        site_locale: 'auto',
        site_timezone: 'UTC',
        retention_check_results_days: 7,
        state_failures_to_down_from_up: 2,
        state_successes_to_up_from_down: 2,
        admin_default_overview_range: '24h',
        admin_default_monitor_range: '24h',
        uptime_rating_level: 3,
      },
      monitor_metadata_stamp: {
        monitor_count_total: 26,
        max_updated_at: 1_700_000_000,
      },
      has_active_incidents: false,
      has_active_maintenance: false,
      has_upcoming_maintenance: false,
      has_resolved_incident_preview: false,
      has_maintenance_history_preview: false,
    },
  });
}

describe('homepage guard DB cache state', () => {
  it('uses cached guard state when component versions and valid_until match', async () => {
    const versions = { settings: 1, monitorMetadata: 2, incidents: 3, maintenance: 4 };
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_guard_versions',
        all: () => [
          { key: 'homepage:settings', version: versions.settings, state_json: null },
          { key: 'homepage:monitor-metadata', version: versions.monitorMetadata, state_json: null },
          { key: 'homepage:incidents', version: versions.incidents, state_json: null },
          { key: 'homepage:maintenance', version: versions.maintenance, state_json: null },
          { key: 'homepage:guard', version: 1, state_json: validStateJson(versions) },
        ],
      },
    ]);

    const result = await readHomepageGuardCacheState(db, 1_700_000_001);

    expect(result.source).toBe('db_cache');
    if (result.source === 'db_cache') {
      expect(result.state.monitorMetadataStamp.monitorCountTotal).toBe(26);
      expect(result.versions).toEqual(versions);
    }
  });

  it('rejects invalid cached JSON and falls back to refresh caller', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_guard_versions',
        all: () => [{ key: 'homepage:guard', version: 1, state_json: '{bad json' }],
      },
    ]);

    await expect(readHomepageGuardCacheState(db, 1_700_000_001)).resolves.toMatchObject({
      source: 'invalid',
    });
  });

  it('rejects cached guard state when a component version changed in another isolate', async () => {
    const storedVersions = { settings: 1, monitorMetadata: 2, incidents: 3, maintenance: 4 };
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_guard_versions',
        all: () => [
          { key: 'homepage:settings', version: 2, state_json: null },
          { key: 'homepage:monitor-metadata', version: 2, state_json: null },
          { key: 'homepage:incidents', version: 3, state_json: null },
          { key: 'homepage:maintenance', version: 4, state_json: null },
          { key: 'homepage:guard', version: 1, state_json: validStateJson(storedVersions) },
        ],
      },
    ]);

    await expect(readHomepageGuardCacheState(db, 1_700_000_001)).resolves.toMatchObject({
      source: 'version_mismatch',
    });
  });

  it('expires cached guard state at maintenance time boundaries', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_guard_versions',
        all: () => [
          {
            key: 'homepage:guard',
            version: 1,
            state_json: validStateJson(
              { settings: 0, monitorMetadata: 0, incidents: 0, maintenance: 0 },
              1_700_000_010,
            ),
          },
        ],
      },
    ]);

    await expect(readHomepageGuardCacheState(db, 1_700_000_010)).resolves.toMatchObject({
      source: 'expired',
      validUntil: 1_700_000_010,
    });
  });

  it('computes valid_until from the nearest visible maintenance boundary with a 900s cap', async () => {
    const db = createFakeD1Database([
      {
        match: 'select min(boundary_at)',
        first: () => ({ boundary_at: 1_700_000_030 }),
      },
    ]);

    await expect(computeHomepageGuardValidUntil(db, 1_700_000_000)).resolves.toBe(1_700_000_030);
  });

  it('caps valid_until when there is no nearer maintenance boundary', async () => {
    const db = createFakeD1Database([
      {
        match: 'select min(boundary_at)',
        first: () => ({ boundary_at: 1_700_001_500 }),
      },
    ]);

    await expect(computeHomepageGuardValidUntil(db, 1_700_000_000)).resolves.toBe(1_700_000_900);
  });

  it('bumps component versions with prepared upserts and writes validated guard JSON', async () => {
    const runs: unknown[][] = [];
    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'public_snapshot_guard_versions',
        run: (args) => {
          runs.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ];
    const db = createFakeD1Database(handlers);

    await bumpHomepageSettingsGuardVersion(db, 1_700_000_001);
    await bumpHomepageMonitorGuardVersions(db, 1_700_000_002);
    await bumpHomepageIncidentGuardVersion(db, 1_700_000_003);
    await bumpHomepageMaintenanceGuardVersion(db, 1_700_000_004);
    await writeHomepageGuardCacheState({
      db,
      now: 1_700_000_005,
      validUntil: 1_700_000_060,
      versions: { settings: 1, monitorMetadata: 1, incidents: 1, maintenance: 1 },
      state: {
        settings: {
          site_title: 'Uptimer',
          site_description: '',
          site_locale: 'auto',
          site_timezone: 'UTC',
          retention_check_results_days: 7,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
          admin_default_overview_range: '24h',
          admin_default_monitor_range: '24h',
          uptime_rating_level: 3,
        },
        monitorMetadataStamp: { monitorCountTotal: 0, maxUpdatedAt: null },
        hasActiveIncidents: false,
        hasActiveMaintenance: false,
        hasUpcomingMaintenance: false,
        hasResolvedIncidentPreview: false,
        hasMaintenanceHistoryPreview: false,
      },
    });

    expect(runs.map((args) => args[0])).toEqual([
      'homepage:settings',
      'homepage:monitor-metadata',
      'homepage:incidents',
      'homepage:maintenance',
      'homepage:incidents',
      'homepage:maintenance',
      'homepage:guard',
    ]);
  });
});
