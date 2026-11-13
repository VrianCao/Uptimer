import { describe, expect, it } from 'vitest';

import { ADMIN_DASHBOARD_TABS, DEFAULT_ADMIN_DASHBOARD_TAB } from './adminNavigation';

describe('ADMIN_DASHBOARD_TABS', () => {
  it('orders tabs by core monitoring/surfaces, operational announcements, notifications, and settings last', () => {
    expect(ADMIN_DASHBOARD_TABS.map((t) => t.key)).toEqual([
      'monitors',
      'status-pages',
      'incidents',
      'maintenance',
      'notifications',
      'settings',
    ]);
  });

  it('starts on the default monitors tab', () => {
    expect(ADMIN_DASHBOARD_TABS[0]?.key).toBe(DEFAULT_ADMIN_DASHBOARD_TAB);
    expect(DEFAULT_ADMIN_DASHBOARD_TAB).toBe('monitors');
  });

  it('places status-pages before incidents/maintenance, keeps incidents & maintenance adjacent, and keeps settings last', () => {
    const keys = ADMIN_DASHBOARD_TABS.map((t) => t.key);
    const statusPagesIdx = keys.indexOf('status-pages');
    const incidentsIdx = keys.indexOf('incidents');
    const maintenanceIdx = keys.indexOf('maintenance');

    expect(statusPagesIdx).toBeGreaterThan(-1);
    expect(statusPagesIdx).toBeLessThan(incidentsIdx);
    expect(statusPagesIdx).toBeLessThan(maintenanceIdx);
    expect(Math.abs(incidentsIdx - maintenanceIdx)).toBe(1);
    expect(keys[keys.length - 1]).toBe('settings');
  });
});
