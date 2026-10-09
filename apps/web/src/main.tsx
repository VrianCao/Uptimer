import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { AuthProvider } from './app/AuthContext';
import { I18nProvider } from './app/I18nContext';
import { queryClient } from './app/queryClient';
import { router } from './app/router';
import { ThemeProvider } from './app/ThemeContext';
import type { PublicHomepageResponse, StatusResponse } from './api/types';
import './styles.css';

declare global {
  var __UPTIMER_INITIAL_HOMEPAGE__: PublicHomepageResponse | undefined;
  var __UPTIMER_INITIAL_STATUS__: StatusResponse | undefined;
}

const LS_PUBLIC_HOMEPAGE_KEY = 'uptimer_public_homepage_snapshot_v2';
const LS_PUBLIC_STATUS_KEY = 'uptimer_public_status_snapshot_v1';

type PersistedHomepageCache = {
  at: number;
  value: PublicHomepageResponse;
};

function toHeartbeatStatusCode(
  status: StatusResponse['monitors'][number]['heartbeats'][number]['status'],
) {
  switch (status) {
    case 'up':
      return 'u';
    case 'down':
      return 'd';
    case 'maintenance':
      return 'm';
    case 'unknown':
    default:
      return 'x';
  }
}

function readPersistedHomepageCache(): PublicHomepageResponse | null {
  try {
    const raw = localStorage.getItem(LS_PUBLIC_HOMEPAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const value = (parsed as { value?: unknown }).value;
    if (!value || typeof value !== 'object') return null;
    if (typeof (value as { generated_at?: unknown }).generated_at !== 'number') return null;
    return value as PublicHomepageResponse;
  } catch {
    return null;
  }
}

function readPersistedStatusCache(): StatusResponse | null {
  try {
    const raw = localStorage.getItem(LS_PUBLIC_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const value = (parsed as { value?: unknown }).value;
    if (!value || typeof value !== 'object') return null;

    // Minimal shape check.
    if (typeof (value as { generated_at?: unknown }).generated_at !== 'number') return null;

    return value as StatusResponse;
  } catch {
    return null;
  }
}

function writePersistedHomepageCache(value: PublicHomepageResponse): void {
  try {
    const payload: PersistedHomepageCache = { at: Date.now(), value };
    localStorage.setItem(LS_PUBLIC_HOMEPAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only.
  }
}

function homepageFromStatus(status: StatusResponse): PublicHomepageResponse {
  return {
    generated_at: status.generated_at,
    bootstrap_mode: 'full',
    monitor_count_total: status.monitors.length,
    site_title: status.site_title,
    site_description: status.site_description,
    site_locale: status.site_locale,
    site_timezone: status.site_timezone,
    uptime_rating_level: status.uptime_rating_level,
    overall_status: status.overall_status,
    banner: status.banner,
    summary: status.summary,
    monitors: status.monitors.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      display_url: monitor.display_url ?? null,
      group_name: monitor.group_name,
      status: monitor.status,
      is_stale: monitor.is_stale,
      last_checked_at: monitor.last_checked_at,
      heartbeat_strip: {
        checked_at: monitor.heartbeats.map((heartbeat) => heartbeat.checked_at),
        status_codes: monitor.heartbeats
          .map((heartbeat) => toHeartbeatStatusCode(heartbeat.status))
          .join(''),
        latency_ms: monitor.heartbeats.map((heartbeat) => heartbeat.latency_ms),
      },
      uptime_30d: monitor.uptime_30d ? { uptime_pct: monitor.uptime_30d.uptime_pct } : null,
      uptime_day_strip: {
        day_start_at: monitor.uptime_days.map((day) => day.day_start_at),
        downtime_sec: monitor.uptime_days.map((day) => day.downtime_sec),
        unknown_sec: monitor.uptime_days.map((day) => day.unknown_sec),
        uptime_pct_milli: monitor.uptime_days.map((day) =>
          day.uptime_pct === null ? null : Math.round(day.uptime_pct * 1000),
        ),
      },
    })),
    active_incidents: status.active_incidents.map((incident) => ({
      id: incident.id,
      title: incident.title,
      status: incident.status,
      impact: incident.impact,
      message: incident.message,
      started_at: incident.started_at,
      resolved_at: incident.resolved_at,
    })),
    maintenance_windows: {
      active: status.maintenance_windows.active.map((window) => ({
        id: window.id,
        title: window.title,
        message: window.message,
        starts_at: window.starts_at,
        ends_at: window.ends_at,
        monitor_ids: window.monitor_ids,
      })),
      upcoming: status.maintenance_windows.upcoming.map((window) => ({
        id: window.id,
        title: window.title,
        message: window.message,
        starts_at: window.starts_at,
        ends_at: window.ends_at,
        monitor_ids: window.monitor_ids,
      })),
    },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

const initialHomepage =
  globalThis.__UPTIMER_INITIAL_HOMEPAGE__ ??
  (globalThis.__UPTIMER_INITIAL_STATUS__
    ? homepageFromStatus(globalThis.__UPTIMER_INITIAL_STATUS__)
    : undefined);
const migratedPersistedStatus = initialHomepage ? null : readPersistedStatusCache();
const persistedHomepage = initialHomepage
  ? null
  : (readPersistedHomepageCache() ??
    (migratedPersistedStatus ? homepageFromStatus(migratedPersistedStatus) : null));
const seedHomepage = initialHomepage ?? persistedHomepage;

if (seedHomepage) {
  const updatedAt =
    typeof seedHomepage.generated_at === 'number' ? seedHomepage.generated_at * 1000 : Date.now();

  queryClient.setQueryData<PublicHomepageResponse>(['homepage'], seedHomepage, { updatedAt });
  writePersistedHomepageCache(seedHomepage);
}

function PreloadCleanup() {
  // Remove the server-rendered preload right before the first paint with React,
  // avoiding a flash of duplicated content.
  React.useLayoutEffect(() => {
    document.getElementById('uptimer-preload')?.remove();
  }, []);

  return null;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <PreloadCleanup />
            <RouterProvider
              router={router}
              fallbackElement={<div className="min-h-screen bg-slate-50 dark:bg-slate-900" />}
            />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
