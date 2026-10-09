import { describe, expect, it } from 'vitest';

import {
  buildPublicStatusBanner,
  listVisibleMaintenanceWindows,
  readVisibleActiveIncidentSummary,
} from '../src/public/data';
import { readHomepageHistoryPreviews } from '../src/public/homepage';
import { createFakeD1Database } from './helpers/fake-d1';

describe('public data consistency', () => {
  it('keeps the full active maintenance monitor set even when the preview list is truncated', async () => {
    const db = createFakeD1Database([
      {
        match: (sql) =>
          sql.includes('from maintenance_windows') &&
          sql.includes('starts_at <= ?1 and ends_at > ?1') &&
          sql.includes('limit ?2'),
        all: () => [
          { id: 1, title: 'mw-1', message: null, starts_at: 0, ends_at: 200, created_at: 0 },
          { id: 2, title: 'mw-2', message: null, starts_at: 0, ends_at: 200, created_at: 0 },
          { id: 3, title: 'mw-3', message: null, starts_at: 0, ends_at: 200, created_at: 0 },
        ],
      },
      {
        match: (sql) => sql.includes('select distinct mwm.monitor_id from maintenance_windows mw'),
        all: () => [{ monitor_id: 11 }, { monitor_id: 12 }, { monitor_id: 13 }, { monitor_id: 14 }],
      },
      {
        match: (sql) => sql.includes('from maintenance_windows') && sql.includes('starts_at > ?1'),
        all: () => [],
      },
      {
        match: (sql) => sql.includes('from maintenance_window_monitors'),
        all: (args) => {
          const ids = new Set(args as number[]);
          return [
            { maintenance_window_id: 1, monitor_id: 11 },
            { maintenance_window_id: 2, monitor_id: 12 },
            { maintenance_window_id: 3, monitor_id: 13 },
            { maintenance_window_id: 4, monitor_id: 14 },
          ].filter((row) => ids.has(row.maintenance_window_id));
        },
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: (args) => (args as number[]).map((id) => ({ id })),
      },
    ]);

    const result = await listVisibleMaintenanceWindows(db, 100, false);

    expect(result.active.map((entry) => entry.row.id)).toEqual([1, 2, 3]);
    expect([...result.activeMonitorIds].sort((a, b) => a - b)).toEqual([11, 12, 13, 14]);
  });

  it('aligns the banner incident with the maximum incident impact', () => {
    const banner = buildPublicStatusBanner({
      counts: {
        up: 0,
        down: 0,
        maintenance: 0,
        paused: 0,
        unknown: 0,
      },
      monitorCount: 2,
      activeIncidents: [
        {
          row: {
            id: 1,
            title: 'Minor incident',
            status: 'investigating',
            impact: 'minor',
            message: null,
            started_at: 100,
            resolved_at: null,
          },
          monitorIds: [1],
        },
        {
          row: {
            id: 2,
            title: 'Critical incident',
            status: 'identified',
            impact: 'critical',
            message: null,
            started_at: 120,
            resolved_at: null,
          },
          monitorIds: [2],
        },
      ],
      activeMaintenanceWindows: [],
    });

    expect(banner.status).toBe('major_outage');
    expect(banner.incident).toMatchObject({
      id: 2,
      impact: 'critical',
    });
  });

  it('keeps the active incident preview capped while selecting the banner from the highest impact incident', async () => {
    const db = createFakeD1Database([
      {
        match: (sql) =>
          sql.includes('from incidents') &&
          sql.includes("where status != 'resolved'") &&
          sql.includes('order by started_at desc, id desc') &&
          sql.includes('limit ?1'),
        all: () =>
          Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            title: `Recent minor ${index + 1}`,
            status: 'investigating',
            impact: 'minor',
            message: null,
            started_at: 500 - index,
            resolved_at: null,
          })),
      },
      {
        match: (sql) =>
          sql.includes('from incidents') &&
          sql.includes("where status != 'resolved'") &&
          sql.includes('case impact') &&
          sql.includes('limit 1'),
        first: () => ({
          id: 99,
          title: 'Older critical incident',
          status: 'identified',
          impact: 'critical',
          message: null,
          started_at: 100,
          resolved_at: null,
        }),
      },
      {
        match: (sql) => sql.includes('from incident_monitors'),
        all: () => [
          { incident_id: 1, monitor_id: 11 },
          { incident_id: 2, monitor_id: 12 },
          { incident_id: 3, monitor_id: 13 },
          { incident_id: 4, monitor_id: 14 },
          { incident_id: 5, monitor_id: 15 },
          { incident_id: 99, monitor_id: 19 },
        ],
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: (args) => [...new Set(args as number[])].map((id) => ({ id })),
      },
    ]);

    const summary = await readVisibleActiveIncidentSummary(db, false);

    expect(summary.items.map((entry) => entry.row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(summary.bannerIncident?.row).toMatchObject({
      id: 99,
      impact: 'critical',
    });
  });

  it('reads homepage history previews by completion time instead of raw id order', async () => {
    const db = createFakeD1Database([
      {
        match: (sql) =>
          sql.includes('from incidents') && sql.includes('order by resolved_at desc, id desc'),
        all: () => [
          {
            id: 5,
            title: 'Newest resolved incident',
            status: 'resolved',
            impact: 'minor',
            message: null,
            started_at: 100,
            resolved_at: 500,
          },
          {
            id: 9,
            title: 'Older resolved incident',
            status: 'resolved',
            impact: 'major',
            message: null,
            started_at: 50,
            resolved_at: 300,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from incident_monitors'),
        all: () => [
          { incident_id: 5, monitor_id: 101 },
          { incident_id: 9, monitor_id: 102 },
        ],
      },
      {
        match: (sql) =>
          sql.includes('from maintenance_windows') &&
          sql.includes('order by ends_at desc, id desc'),
        all: () => [
          {
            id: 4,
            title: 'Newest maintenance',
            message: null,
            starts_at: 200,
            ends_at: 450,
            created_at: 180,
          },
          {
            id: 8,
            title: 'Older maintenance',
            message: null,
            starts_at: 100,
            ends_at: 250,
            created_at: 90,
          },
        ],
      },
      {
        match: (sql) => sql.includes('from maintenance_window_monitors'),
        all: () => [
          { maintenance_window_id: 4, monitor_id: 101 },
          { maintenance_window_id: 8, monitor_id: 102 },
        ],
      },
      {
        match: (sql) => sql.includes('from monitors') && sql.includes('show_on_status_page = 1'),
        all: (args) => [...new Set(args as number[])].map((id) => ({ id })),
      },
    ]);

    const previews = await readHomepageHistoryPreviews(db, 600);

    expect(previews.resolvedIncidentPreview).toMatchObject({
      id: 5,
      title: 'Newest resolved incident',
    });
    expect(previews.maintenanceHistoryPreview).toMatchObject({
      id: 4,
      title: 'Newest maintenance',
    });
  });
});
