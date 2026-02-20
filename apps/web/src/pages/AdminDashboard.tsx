import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useAuth } from '../app/AuthContext';
import { useI18n, type MessageKey } from '../app/I18nContext';
import { useApplyServerLocaleSetting } from '../app/useApplyServerLocaleSetting';
import { ADMIN_ANALYTICS_PATH } from '../app/adminPaths';
import {
  ApiError,
  fetchAdminMonitors,
  createMonitor,
  assignMonitorsToGroup,
  reorderMonitorGroups,
  updateMonitor,
  deleteMonitor,
  testMonitor,
  pauseMonitor,
  resumeMonitor,
  fetchNotificationChannels,
  createNotificationChannel,
  updateNotificationChannel,
  testNotificationChannel,
  deleteNotificationChannel,
  fetchAdminIncidents,
  createIncident,
  addIncidentUpdate,
  resolveIncident,
  deleteIncident,
  fetchMaintenanceWindows,
  createMaintenanceWindow,
  updateMaintenanceWindow,
  deleteMaintenanceWindow,
  fetchAdminSettings,
  patchAdminSettings,
} from '../api/client';
import type {
  AdminMonitor,
  AdminSettings,
  Incident,
  MaintenanceWindow,
  NotificationChannel,
  StatusResponse,
} from '../api/types';
import { IncidentForm } from '../components/IncidentForm';
import { IncidentUpdateForm } from '../components/IncidentUpdateForm';
import { MaintenanceWindowForm } from '../components/MaintenanceWindowForm';
import { MonitorForm } from '../components/MonitorForm';
import { NotificationChannelForm } from '../components/NotificationChannelForm';
import { ResolveIncidentForm } from '../components/ResolveIncidentForm';
import {
  Badge,
  Button,
  Card,
  MODAL_OVERLAY_CLASS,
  MODAL_PANEL_CLASS,
  TABLE_ACTION_BUTTON_CLASS,
  ThemeToggle,
  cn,
} from '../components/ui';
import { incidentImpactLabel, incidentStatusLabel, statusLabel } from '../i18n/labels';
import { localeLabels, messages } from '../i18n/messages';
import { formatDateTime } from '../utils/datetime';

type Tab = 'monitors' | 'notifications' | 'incidents' | 'maintenance' | 'settings';

type ModalState =
  | { type: 'none' }
  | { type: 'create-monitor' }
  | { type: 'edit-monitor'; monitor: AdminMonitor }
  | { type: 'create-channel' }
  | { type: 'edit-channel'; channel: NotificationChannel }
  | { type: 'create-incident' }
  | { type: 'add-incident-update'; incident: Incident }
  | { type: 'resolve-incident'; incident: Incident }
  | { type: 'create-maintenance' }
  | { type: 'edit-maintenance'; window: MaintenanceWindow };

type MonitorTestFeedback = {
  at: number;
  monitor: Awaited<ReturnType<typeof testMonitor>>['monitor'];
  result: Awaited<ReturnType<typeof testMonitor>>['result'];
};

type MonitorTestErrorState = {
  monitorId: number;
  at: number;
  message: string;
};

type ChannelTestFeedback = {
  at: number;
  channelId: number;
  eventKey: Awaited<ReturnType<typeof testNotificationChannel>>['event_key'];
  delivery: Awaited<ReturnType<typeof testNotificationChannel>>['delivery'];
};

type ChannelTestErrorState = {
  channelId: number;
  at: number;
  message: string;
};

type MonitorSortMode = 'configured' | 'name' | 'status' | 'last_checked_at' | 'created_at';
type MonitorSortDirection = 'asc' | 'desc';
type MonitorGroupMode = 'grouped' | 'flat';
type MonitorGroupMeta = {
  label: string;
  count: number;
  sortOrder: number;
};

const GROUP_ORDER_STEP = 10;
const UNGROUPED_LABEL = 'Ungrouped';
const UNGROUPED_LABEL_ALIASES = [
  UNGROUPED_LABEL,
  ...new Set(
    Object.values(messages).map(
      (localeMessages) =>
        localeMessages['status_page.group_ungrouped'] ?? messages.en['status_page.group_ungrouped'],
    ),
  ),
];
const ALL_GROUPS_FILTER = '__all_groups__';

const navActionClass =
  'flex items-center justify-center h-10 rounded-lg px-3 text-base transition-colors';

const tabContainerClass =
  'flex gap-1 rounded-xl border border-slate-200/70 bg-white/80 p-1 shadow-sm dark:border-slate-700 dark:bg-slate-800/80';

const SETTINGS_ICON_PATH =
  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z';

const tabs: { key: Tab; labelKey: MessageKey; icon: string }[] = [
  {
    key: 'monitors',
    labelKey: 'admin_dashboard.tab.monitors',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    key: 'notifications',
    labelKey: 'admin_dashboard.tab.notifications',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  },
  {
    key: 'incidents',
    labelKey: 'admin_dashboard.tab.incidents',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  {
    key: 'settings',
    labelKey: 'admin_dashboard.tab.settings',
    icon: SETTINGS_ICON_PATH,
  },
  {
    key: 'maintenance',
    labelKey: 'admin_dashboard.tab.maintenance',
    icon: 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
  },
];

function formatError(err: unknown): string | undefined {
  if (!err) return undefined;
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function isUnsupportedSiteLocaleError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code !== 'INVALID_ARGUMENT') return false;
  const m = err.message.toLowerCase();
  return m.includes('site_locale') && m.includes('unrecognized');
}

function sanitizeSiteTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Uptimer';
  return trimmed.slice(0, 100);
}

function sanitizeSiteDescription(value: string): string {
  return value.trim().slice(0, 500);
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function monitorGroupLabel(monitor: Pick<AdminMonitor, 'group_name'>): string {
  const trimmed = monitor.group_name?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : UNGROUPED_LABEL;
}

function displayGroupLabel(groupLabel: string, ungroupedLabel: string): string {
  return groupLabel === UNGROUPED_LABEL ? ungroupedLabel : groupLabel;
}

function normalizeGroupInput(value: string, ungroupedLabel: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const aliases = [ungroupedLabel, ...UNGROUPED_LABEL_ALIASES];
  if (
    aliases.some((alias) => trimmed.localeCompare(alias, undefined, { sensitivity: 'base' }) === 0)
  ) {
    return null;
  }
  return trimmed;
}

function formatMonitorDisplayName(monitor: Pick<AdminMonitor, 'id' | 'name'>): string {
  return `${monitor.name} (#${monitor.id})`;
}

function formatMonitorDisplayNameById(monitorId: number, monitorNameById: Map<number, string>): string {
  const monitorName = monitorNameById.get(monitorId);
  return monitorName ? `${monitorName} (#${monitorId})` : `#${monitorId}`;
}

function monitorStatusRank(status: AdminMonitor['status']): number {
  switch (status) {
    case 'down':
      return 0;
    case 'unknown':
      return 1;
    case 'maintenance':
      return 2;
    case 'paused':
      return 3;
    case 'up':
      return 4;
    default:
      return 5;
  }
}

function compareMonitors(
  a: AdminMonitor,
  b: AdminMonitor,
  mode: MonitorSortMode,
  direction: MonitorSortDirection,
  ungroupedLabel: string,
): number {
  const dir = direction === 'asc' ? 1 : -1;
  let cmp = 0;

  switch (mode) {
    case 'configured':
      cmp = a.group_sort_order - b.group_sort_order;
      if (cmp === 0) {
        cmp = displayGroupLabel(monitorGroupLabel(a), ungroupedLabel).localeCompare(
          displayGroupLabel(monitorGroupLabel(b), ungroupedLabel),
          undefined,
          {
            sensitivity: 'base',
          },
        );
      }
      if (cmp === 0) {
        cmp = a.sort_order - b.sort_order;
      }
      break;
    case 'name':
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      break;
    case 'status':
      cmp = monitorStatusRank(a.status) - monitorStatusRank(b.status);
      break;
    case 'last_checked_at':
      cmp = (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0);
      break;
    case 'created_at':
      cmp = a.created_at - b.created_at;
      break;
    default:
      cmp = 0;
  }

  if (cmp !== 0) return cmp * dir;
  return (a.id - b.id) * dir;
}

export function AdminDashboard() {
  const { logout } = useAuth();
  const { setLocaleSetting, t } = useI18n();
  const queryClient = useQueryClient();
  const ungroupedLabel = t('status_page.group_ungrouped');
  const [tab, setTab] = useState<Tab>('monitors');
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [testingMonitorId, setTestingMonitorId] = useState<number | null>(null);
  const [testingChannelId, setTestingChannelId] = useState<number | null>(null);
  const [monitorTestFeedback, setMonitorTestFeedback] = useState<MonitorTestFeedback | null>(null);
  const [monitorTestError, setMonitorTestError] = useState<MonitorTestErrorState | null>(null);
  const [channelTestFeedback, setChannelTestFeedback] = useState<ChannelTestFeedback | null>(null);
  const [channelTestError, setChannelTestError] = useState<ChannelTestErrorState | null>(null);
  const [monitorGroupReorderError, setMonitorGroupReorderError] = useState<string | null>(null);
  const [monitorGroupManageError, setMonitorGroupManageError] = useState<string | null>(null);
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>([]);
  const [bulkTargetGroup, setBulkTargetGroup] = useState<string>('');
  const [bulkTargetGroupSortOrderInput, setBulkTargetGroupSortOrderInput] = useState<string>('');
  const [monitorSortMode, setMonitorSortMode] = useState<MonitorSortMode>('configured');
  const [monitorSortDirection, setMonitorSortDirection] = useState<MonitorSortDirection>('asc');
  const [monitorGroupMode, setMonitorGroupMode] = useState<MonitorGroupMode>('grouped');
  const [monitorGroupFilter, setMonitorGroupFilter] = useState<string>(ALL_GROUPS_FILTER);
  const [serverLocalePatchSupported, setServerLocalePatchSupported] = useState(true);
  const [localePatchFallbackActive, setLocalePatchFallbackActive] = useState(false);

  const monitorsQuery = useQuery({
    queryKey: ['admin-monitors'],
    queryFn: () => fetchAdminMonitors(),
  });
  const channelsQuery = useQuery({
    queryKey: ['admin-channels'],
    queryFn: () => fetchNotificationChannels(),
  });
  const incidentsQuery = useQuery({
    queryKey: ['admin-incidents'],
    queryFn: () => fetchAdminIncidents(),
  });
  const maintenanceQuery = useQuery({
    queryKey: ['admin-maintenance-windows'],
    queryFn: () => fetchMaintenanceWindows(),
  });

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    queryFn: fetchAdminSettings,
  });

  const settings = settingsQuery.data?.settings;
  useApplyServerLocaleSetting(settings?.site_locale);
  const siteTitle = settings?.site_title?.trim() || 'Uptimer';

  useEffect(() => {
    document.title = `${siteTitle} · ${t('admin_dashboard.document_title_suffix')}`;
  }, [siteTitle, t]);

  const [settingsDraft, setSettingsDraft] = useState<AdminSettings | null>(null);
  const [focusedSetting, setFocusedSetting] = useState<keyof AdminSettings | null>(null);
  const localeOptions: Array<{ value: AdminSettings['site_locale']; label: string }> = [
    { value: 'auto', label: t('admin_settings.locale.option.auto') },
    { value: 'en', label: localeLabels.en },
    { value: 'zh-CN', label: localeLabels['zh-CN'] },
    { value: 'zh-TW', label: localeLabels['zh-TW'] },
    { value: 'ja', label: localeLabels.ja },
    { value: 'es', label: localeLabels.es },
  ];

  useEffect(() => {
    if (!settings) return;

    // Keep draft in sync with server, but don't clobber the field the user is currently editing.
    setSettingsDraft((prev) => {
      if (!prev) return settings;
      if (!focusedSetting) return settings;
      return { ...settings, [focusedSetting]: prev[focusedSetting] };
    });
  }, [settings, focusedSetting]);

  const applyLocaleLocally = (next: AdminSettings['site_locale']) => {
    setSettingsDraft((prev) => (prev ? { ...prev, site_locale: next } : prev));
    setLocaleSetting(next);
    queryClient.setQueryData<{ settings: AdminSettings }>(['admin-settings'], (old) =>
      old ? { settings: { ...old.settings, site_locale: next } } : old,
    );
    queryClient.setQueryData<StatusResponse>(['status'], (old) =>
      old ? { ...old, site_locale: next } : old,
    );
  };

  const patchSettingsMut = useMutation({
    mutationFn: (patch: Partial<AdminSettings>) => patchAdminSettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['admin-settings'] });
      await queryClient.cancelQueries({ queryKey: ['status'] });

      const prevSettings = queryClient.getQueryData<{ settings: AdminSettings }>([
        'admin-settings',
      ]);
      const prevStatus = queryClient.getQueryData<StatusResponse>(['status']);

      if (prevSettings) {
        queryClient.setQueryData<{ settings: AdminSettings }>(['admin-settings'], {
          settings: { ...prevSettings.settings, ...patch },
        });
      }

      // Keep status page data in sync for fields used there (title + uptime rating).
      if (prevStatus) {
        const nextSiteTitle = typeof patch.site_title === 'string' ? patch.site_title : undefined;
        const nextRating = patch.uptime_rating_level as 1 | 2 | 3 | 4 | 5 | undefined;
        const nextLocale = patch.site_locale;

        queryClient.setQueryData<StatusResponse>(['status'], {
          ...prevStatus,
          ...(nextSiteTitle ? { site_title: nextSiteTitle } : {}),
          ...(typeof nextLocale === 'string' ? { site_locale: nextLocale } : {}),
          ...(nextRating
            ? {
                uptime_rating_level: nextRating,
                monitors: prevStatus.monitors.map((m) => ({
                  ...m,
                  uptime_rating_level: nextRating,
                })),
              }
            : {}),
        });

        if (typeof nextLocale === 'string') {
          setLocaleSetting(nextLocale);
        }
      }

      return { prevSettings, prevStatus };
    },
    onError: (err, patch, ctx) => {
      if (typeof patch.site_locale === 'string' && isUnsupportedSiteLocaleError(err)) {
        setServerLocalePatchSupported(false);
        setLocalePatchFallbackActive(true);
        applyLocaleLocally(patch.site_locale);
        return;
      }

      const prevSettings = (ctx as { prevSettings?: { settings: AdminSettings } } | undefined)
        ?.prevSettings;
      const prevStatus = (ctx as { prevStatus?: StatusResponse } | undefined)?.prevStatus;

      if (prevSettings) queryClient.setQueryData(['admin-settings'], prevSettings);
      if (prevStatus) queryClient.setQueryData(['status'], prevStatus);
    },
    onSuccess: (data, patch) => {
      if (patch.site_locale !== undefined) {
        setServerLocalePatchSupported(true);
        setLocalePatchFallbackActive(false);
      }
      queryClient.setQueryData(['admin-settings'], data);

      setSettingsDraft(data.settings);

      // Update status query cache so StatusPage header updates instantly.
      const title = data.settings.site_title;
      const level = data.settings.uptime_rating_level;
      const localeSetting = data.settings.site_locale;
      queryClient.setQueryData<StatusResponse>(['status'], (old) =>
        old
          ? {
              ...old,
              site_title: title,
              site_locale: localeSetting,
              uptime_rating_level: level,
              monitors: old.monitors.map((m) => ({ ...m, uptime_rating_level: level })),
            }
          : old,
      );
      setLocaleSetting(localeSetting);
    },
  });

  const closeModal = () => setModal({ type: 'none' });

  const createMonitorMut = useMutation({
    mutationFn: createMonitor,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-monitors'] });
      closeModal();
    },
  });
  const updateMonitorMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateMonitor>[1] }) =>
      updateMonitor(id, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-monitors'] });
      closeModal();
    },
  });
  const deleteMonitorMut = useMutation({
    mutationFn: deleteMonitor,
    onSuccess: (_data, id) => {
      queryClient.setQueryData(
        ['admin-monitors'],
        (old: { monitors: AdminMonitor[] } | undefined) => ({
          monitors: (old?.monitors ?? []).filter((m) => m.id !== id),
        }),
      );
    },
  });

  const pauseMonitorMut = useMutation({
    mutationFn: pauseMonitor,
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-monitors'],
        (old: { monitors: AdminMonitor[] } | undefined) => ({
          monitors: (old?.monitors ?? []).map((m) => (m.id === data.monitor.id ? data.monitor : m)),
        }),
      );
    },
  });

  const resumeMonitorMut = useMutation({
    mutationFn: resumeMonitor,
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-monitors'],
        (old: { monitors: AdminMonitor[] } | undefined) => ({
          monitors: (old?.monitors ?? []).map((m) => (m.id === data.monitor.id ? data.monitor : m)),
        }),
      );
    },
  });

  const testMonitorMut = useMutation({
    mutationFn: testMonitor,
    onSuccess: (data) => {
      setMonitorTestFeedback({
        at: Math.floor(Date.now() / 1000),
        monitor: data.monitor,
        result: data.result,
      });
      setMonitorTestError(null);
    },
    onError: (err, monitorId) => {
      setMonitorTestError({
        monitorId,
        at: Math.floor(Date.now() / 1000),
        message: formatError(err) ?? t('admin_dashboard.monitor_test_failed_default'),
      });
      setMonitorTestFeedback(null);
    },
    onSettled: () => setTestingMonitorId(null),
  });

  const createChannelMut = useMutation({
    mutationFn: createNotificationChannel,
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-channels'],
        (old: { notification_channels: NotificationChannel[] } | undefined) => ({
          notification_channels: [
            ...(old?.notification_channels ?? []),
            data.notification_channel,
          ].sort((a, b) => a.id - b.id),
        }),
      );
      closeModal();
    },
  });
  const updateChannelMut = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Parameters<typeof updateNotificationChannel>[1];
    }) => updateNotificationChannel(id, data),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-channels'],
        (old: { notification_channels: NotificationChannel[] } | undefined) => ({
          notification_channels: (old?.notification_channels ?? []).map((ch) =>
            ch.id === data.notification_channel.id ? data.notification_channel : ch,
          ),
        }),
      );
      closeModal();
    },
  });
  const testChannelMut = useMutation({
    mutationFn: testNotificationChannel,
    onSuccess: (data, channelId) => {
      setChannelTestFeedback({
        at: Math.floor(Date.now() / 1000),
        channelId,
        eventKey: data.event_key,
        delivery: data.delivery,
      });
      setChannelTestError(null);
    },
    onError: (err, channelId) => {
      setChannelTestError({
        channelId,
        at: Math.floor(Date.now() / 1000),
        message: formatError(err) ?? t('admin_dashboard.webhook_test_failed_default'),
      });
      setChannelTestFeedback(null);
    },
    onSettled: () => setTestingChannelId(null),
  });

  const deleteChannelMut = useMutation({
    mutationFn: deleteNotificationChannel,
    onSuccess: (_data, id) => {
      queryClient.setQueryData(
        ['admin-channels'],
        (old: { notification_channels: NotificationChannel[] } | undefined) => ({
          notification_channels: (old?.notification_channels ?? []).filter((ch) => ch.id !== id),
        }),
      );
    },
  });

  const createIncidentMut = useMutation({
    mutationFn: createIncident,
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-incidents'],
        (old: { incidents: Incident[] } | undefined) => ({
          incidents: [data.incident, ...(old?.incidents ?? [])],
        }),
      );
      closeModal();
    },
  });
  const addIncidentUpdateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof addIncidentUpdate>[1] }) =>
      addIncidentUpdate(id, data),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-incidents'],
        (old: { incidents: Incident[] } | undefined) => ({
          incidents: (old?.incidents ?? []).map((it) =>
            it.id === data.incident.id ? data.incident : it,
          ),
        }),
      );
      closeModal();
    },
  });
  const resolveIncidentMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof resolveIncident>[1] }) =>
      resolveIncident(id, data),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-incidents'],
        (old: { incidents: Incident[] } | undefined) => ({
          incidents: (old?.incidents ?? []).map((it) =>
            it.id === data.incident.id ? data.incident : it,
          ),
        }),
      );
      closeModal();
    },
  });
  const deleteIncidentMut = useMutation({
    mutationFn: deleteIncident,
    onSuccess: (_data, id) => {
      queryClient.setQueryData(
        ['admin-incidents'],
        (old: { incidents: Incident[] } | undefined) => ({
          incidents: (old?.incidents ?? []).filter((it) => it.id !== id),
        }),
      );
    },
  });

  const createMaintenanceMut = useMutation({
    mutationFn: createMaintenanceWindow,
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-maintenance-windows'],
        (old: { maintenance_windows: MaintenanceWindow[] } | undefined) => ({
          maintenance_windows: [data.maintenance_window, ...(old?.maintenance_windows ?? [])],
        }),
      );
      closeModal();
    },
  });
  const updateMaintenanceMut = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Parameters<typeof updateMaintenanceWindow>[1];
    }) => updateMaintenanceWindow(id, data),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['admin-maintenance-windows'],
        (old: { maintenance_windows: MaintenanceWindow[] } | undefined) => ({
          maintenance_windows: (old?.maintenance_windows ?? []).map((w) =>
            w.id === data.maintenance_window.id ? data.maintenance_window : w,
          ),
        }),
      );
      closeModal();
    },
  });
  const deleteMaintenanceMut = useMutation({
    mutationFn: deleteMaintenanceWindow,
    onSuccess: (_data, id) => {
      queryClient.setQueryData(
        ['admin-maintenance-windows'],
        (old: { maintenance_windows: MaintenanceWindow[] } | undefined) => ({
          maintenance_windows: (old?.maintenance_windows ?? []).filter((w) => w.id !== id),
        }),
      );
    },
  });

  const monitorNameById = useMemo(
    () => new Map((monitorsQuery.data?.monitors ?? []).map((m) => [m.id, m.name] as const)),
    [monitorsQuery.data?.monitors],
  );

  const monitorGroupMetaByLabel = useMemo(() => {
    const byLabel = new Map<string, MonitorGroupMeta>();

    for (const monitor of monitorsQuery.data?.monitors ?? []) {
      const label = monitorGroupLabel(monitor);
      const existing = byLabel.get(label);

      if (!existing) {
        byLabel.set(label, {
          label,
          count: 1,
          sortOrder: monitor.group_sort_order,
        });
        continue;
      }

      existing.count += 1;
      if (monitor.group_sort_order < existing.sortOrder) {
        existing.sortOrder = monitor.group_sort_order;
      }
    }

    return byLabel;
  }, [monitorsQuery.data?.monitors]);

  const orderedMonitorGroups = useMemo(() => {
    return [...monitorGroupMetaByLabel.values()].sort((a, b) => {
      const orderCmp = a.sortOrder - b.sortOrder;
      if (orderCmp !== 0) return orderCmp;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
  }, [monitorGroupMetaByLabel]);

  const monitorGroupIndexByLabel = useMemo(
    () => new Map(orderedMonitorGroups.map((group, index) => [group.label, index] as const)),
    [orderedMonitorGroups],
  );

  const monitorGroupLabels = useMemo(
    () => orderedMonitorGroups.map((group) => group.label),
    [orderedMonitorGroups],
  );

  useEffect(() => {
    const available = new Set((monitorsQuery.data?.monitors ?? []).map((m) => m.id));
    setSelectedMonitorIds((prev) => prev.filter((id) => available.has(id)));
  }, [monitorsQuery.data?.monitors]);

  useEffect(() => {
    if (monitorGroupFilter === ALL_GROUPS_FILTER) return;
    if (monitorGroupLabels.includes(monitorGroupFilter)) return;
    setMonitorGroupFilter(ALL_GROUPS_FILTER);
  }, [monitorGroupFilter, monitorGroupLabels]);

  const moveMonitorGroupMut = useMutation({
    mutationFn: async ({ groupLabel, direction }: { groupLabel: string; direction: -1 | 1 }) => {
      const fromIndex = monitorGroupIndexByLabel.get(groupLabel);
      if (fromIndex === undefined) return;

      const toIndex = fromIndex + direction;
      if (toIndex < 0 || toIndex >= orderedMonitorGroups.length) return;

      const reordered = [...orderedMonitorGroups];
      const [movedGroup] = reordered.splice(fromIndex, 1);
      if (!movedGroup) return;
      reordered.splice(toIndex, 0, movedGroup);

      const updates = reordered
        .map((group, index) => ({
          groupName: group.label === UNGROUPED_LABEL ? null : group.label,
          nextSortOrder: index * GROUP_ORDER_STEP,
        }))
        .filter((item, index) => item.nextSortOrder !== reordered[index]?.sortOrder);

      if (updates.length === 0) return;

      await reorderMonitorGroups({
        groups: updates.map((item) => ({
          group_name: item.groupName,
          group_sort_order: item.nextSortOrder,
        })),
      });
    },
    onMutate: () => {
      setMonitorGroupReorderError(null);
    },
    onError: (err) => {
      setMonitorGroupReorderError(formatError(err) ?? t('admin_dashboard.reorder_groups_failed'));
    },
    onSuccess: async () => {
      setMonitorGroupReorderError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-monitors'] });
    },
  });

  const assignSelectedMonitorsMut = useMutation({
    mutationFn: async () => {
      const monitorIds = [...new Set(selectedMonitorIds)];
      if (monitorIds.length === 0) return;

      const targetGroupName = normalizeGroupInput(bulkTargetGroup, ungroupedLabel);
      const sortOrderTrimmed = bulkTargetGroupSortOrderInput.trim();
      const parsedSortOrder =
        sortOrderTrimmed.length > 0 ? Number.parseInt(sortOrderTrimmed, 10) : undefined;
      const groupSortOrder =
        parsedSortOrder !== undefined && Number.isFinite(parsedSortOrder)
          ? parsedSortOrder
          : undefined;

      await assignMonitorsToGroup({
        monitor_ids: monitorIds,
        group_name: targetGroupName,
        ...(groupSortOrder !== undefined ? { group_sort_order: groupSortOrder } : {}),
      });
    },
    onMutate: () => {
      setMonitorGroupManageError(null);
    },
    onError: (err) => {
      setMonitorGroupManageError(formatError(err) ?? t('admin_dashboard.move_selected_failed'));
    },
    onSuccess: async () => {
      setMonitorGroupManageError(null);
      setSelectedMonitorIds([]);
      setBulkTargetGroupSortOrderInput('');
      await queryClient.invalidateQueries({ queryKey: ['admin-monitors'] });
    },
  });

  const sortedMonitors = useMemo(() => {
    const list = [...(monitorsQuery.data?.monitors ?? [])];
    const dir = monitorSortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      if (monitorGroupMode === 'grouped') {
        const groupA = monitorGroupLabel(a);
        const groupB = monitorGroupLabel(b);
        const groupOrderA = monitorGroupMetaByLabel.get(groupA)?.sortOrder ?? 0;
        const groupOrderB = monitorGroupMetaByLabel.get(groupB)?.sortOrder ?? 0;
        const groupOrderCmp = groupOrderA - groupOrderB;
        if (groupOrderCmp !== 0) return groupOrderCmp;

        const groupCmp = groupA.localeCompare(groupB, undefined, {
          sensitivity: 'base',
        });
        if (groupCmp !== 0) return groupCmp;

        if (monitorSortMode === 'configured') {
          const configuredCmp = a.sort_order - b.sort_order;
          if (configuredCmp !== 0) return configuredCmp * dir;
          return (a.id - b.id) * dir;
        }
      }

      return compareMonitors(a, b, monitorSortMode, monitorSortDirection, ungroupedLabel);
    });
    return list;
  }, [
    monitorGroupMetaByLabel,
    monitorGroupMode,
    monitorSortDirection,
    monitorSortMode,
    monitorsQuery.data?.monitors,
    ungroupedLabel,
  ]);

  const filteredMonitors = useMemo(() => {
    if (monitorGroupFilter === ALL_GROUPS_FILTER) return sortedMonitors;
    return sortedMonitors.filter((monitor) => monitorGroupLabel(monitor) === monitorGroupFilter);
  }, [monitorGroupFilter, sortedMonitors]);

  const monitorCountsByGroup = useMemo(() => {
    return new Map(orderedMonitorGroups.map((group) => [group.label, group.count] as const));
  }, [orderedMonitorGroups]);

  const selectedMonitorIdSet = useMemo(() => new Set(selectedMonitorIds), [selectedMonitorIds]);

  const visibleMonitorIds = useMemo(
    () => filteredMonitors.map((monitor) => monitor.id),
    [filteredMonitors],
  );

  const allVisibleMonitorsSelected =
    visibleMonitorIds.length > 0 && visibleMonitorIds.every((id) => selectedMonitorIdSet.has(id));

  const someVisibleMonitorsSelected = visibleMonitorIds.some((id) => selectedMonitorIdSet.has(id));

  const channelNameById = useMemo(
    () =>
      new Map(
        (channelsQuery.data?.notification_channels ?? []).map((ch) => [ch.id, ch.name] as const),
      ),
    [channelsQuery.data?.notification_channels],
  );
  const toUiGroupLabel = (groupLabel: string) => displayGroupLabel(groupLabel, ungroupedLabel);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700">
        <div className="mx-auto max-w-[92rem] px-4 py-3 sm:px-6 sm:py-4 lg:px-8 flex justify-between items-center">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
            {t('admin_dashboard.title')}
          </h1>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Link
              to={ADMIN_ANALYTICS_PATH}
              className={cn(
                navActionClass,
                'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100',
              )}
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
              <span className="hidden sm:inline">{t('admin_analytics.analytics_title')}</span>
            </Link>
            <Link
              to="/"
              className={cn(
                navActionClass,
                'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100',
              )}
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="hidden sm:inline">{t('common.status')}</span>
            </Link>
            <button
              onClick={logout}
              className={cn(
                navActionClass,
                'text-red-500 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300',
              )}
            >
              <svg
                className="w-5 h-5 sm:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
              <span className="hidden sm:inline">{t('common.logout')}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[92rem] px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8">
        <div className={`${tabContainerClass} overflow-x-auto scrollbar-hide`}>
          {tabs.map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              aria-label={t(tabItem.labelKey)}
              title={t(tabItem.labelKey)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-2 text-base font-medium transition-all sm:gap-2 sm:px-4 whitespace-nowrap',
                tab === tabItem.key
                  ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              <svg
                className="w-4 h-4 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={tabItem.icon}
                />
              </svg>
              <span className="hidden sm:inline">{t(tabItem.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-[92rem] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
        {tab === 'monitors' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {t('admin_dashboard.tab.monitors')}
              </h2>
              <Button onClick={() => setModal({ type: 'create-monitor' })}>
                {t('admin_dashboard.create_monitor')}
              </Button>
            </div>
            {testingMonitorId !== null && (
              <Card className="p-3 border-blue-200 bg-blue-50/70 dark:bg-blue-500/10 dark:border-blue-400/30">
                <div className="text-sm text-blue-700 dark:text-blue-300">
                  {t('admin_dashboard.monitor_test_running', {
                    name: formatMonitorDisplayNameById(testingMonitorId, monitorNameById),
                  })}
                </div>
              </Card>
            )}

            {monitorTestFeedback && (
              <Card className="p-3 border-slate-200 dark:border-slate-600">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_dashboard.monitor_test_last', {
                      name: formatMonitorDisplayName(monitorTestFeedback.monitor),
                    })}
                  </div>
                  <Badge
                    variant={
                      monitorTestFeedback.result.status === 'up'
                        ? 'up'
                        : monitorTestFeedback.result.status === 'down'
                          ? 'down'
                          : monitorTestFeedback.result.status === 'maintenance'
                            ? 'maintenance'
                            : 'unknown'
                    }
                  >
                    {statusLabel(monitorTestFeedback.result.status, t)}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(monitorTestFeedback.at, settings?.site_timezone)}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    {t('admin_dashboard.monitor_test_attempts', {
                      value: monitorTestFeedback.result.attempts,
                    })}
                  </span>
                  <span>
                    {t('admin_dashboard.monitor_test_http', {
                      value:
                        monitorTestFeedback.result.http_status !== null
                          ? monitorTestFeedback.result.http_status
                          : '-',
                    })}
                  </span>
                  <span>
                    {t('admin_dashboard.monitor_test_latency', {
                      value:
                        monitorTestFeedback.result.latency_ms !== null
                          ? `${monitorTestFeedback.result.latency_ms}ms`
                          : '-',
                    })}
                  </span>
                </div>
                <div
                  className={`mt-2 text-sm ${
                    monitorTestFeedback.result.error
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {monitorTestFeedback.result.error ?? t('admin_dashboard.monitor_test_no_error')}
                </div>
              </Card>
            )}

            {monitorTestError && (
              <Card className="p-3 border-red-200 bg-red-50/70 dark:bg-red-500/10 dark:border-red-400/30">
                <div className="text-sm font-medium text-red-700 dark:text-red-300">
                  {t('admin_dashboard.monitor_test_failed', {
                    name: formatMonitorDisplayNameById(
                      monitorTestError.monitorId,
                      monitorNameById,
                    ),
                  })}
                </div>
                <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {formatDateTime(monitorTestError.at, settings?.site_timezone)}
                </div>
                <div className="mt-1 text-sm text-red-700 dark:text-red-300">
                  {monitorTestError.message}
                </div>
              </Card>
            )}

            {monitorsQuery.isLoading ? (
              <div className="text-slate-500 dark:text-slate-400">{t('common.loading')}</div>
            ) : !monitorsQuery.data?.monitors.length ? (
              <Card className="p-6 sm:p-8 text-center text-slate-500 dark:text-slate-400">
                {t('admin_dashboard.no_monitors_yet')}
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[18rem,minmax(0,1fr)] 2xl:grid-cols-[21rem,minmax(0,1fr)]">
                <div className="order-2 space-y-4 self-start lg:order-1 lg:sticky lg:top-6">
                  <Card className="p-3 sm:p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {t('admin_dashboard.group_manager_title')}
                      </h3>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t('admin_dashboard.group_manager_count', {
                          count: orderedMonitorGroups.length,
                        })}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2 lg:max-h-[42vh] lg:overflow-y-auto lg:pr-1">
                      <button
                        type="button"
                        onClick={() => setMonitorGroupFilter(ALL_GROUPS_FILTER)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition-colors',
                          monitorGroupFilter === ALL_GROUPS_FILTER
                            ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700',
                        )}
                      >
                        <span>{t('admin_dashboard.group_all')}</span>
                        <span className="tabular-nums">{sortedMonitors.length}</span>
                      </button>
                      {orderedMonitorGroups.map((group, index) => {
                        const active = monitorGroupFilter === group.label;
                        const isFirst = index === 0;
                        const isLast = index === orderedMonitorGroups.length - 1;

                        return (
                          <div key={group.label} className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setMonitorGroupFilter(group.label);
                                setBulkTargetGroup(toUiGroupLabel(group.label));
                              }}
                              className={cn(
                                'flex min-w-0 flex-1 items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition-colors',
                                active
                                  ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                                  : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700',
                              )}
                            >
                              <span className="truncate">{toUiGroupLabel(group.label)}</span>
                              <span className="ml-2 tabular-nums">
                                {group.count} · {group.sortOrder}
                              </span>
                            </button>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                title={t('admin_dashboard.group_move_up')}
                                onClick={() =>
                                  moveMonitorGroupMut.mutate({
                                    groupLabel: group.label,
                                    direction: -1,
                                  })
                                }
                                disabled={isFirst || moveMonitorGroupMut.isPending}
                                className="rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                title={t('admin_dashboard.group_move_down')}
                                onClick={() =>
                                  moveMonitorGroupMut.mutate({
                                    groupLabel: group.label,
                                    direction: 1,
                                  })
                                }
                                disabled={isLast || moveMonitorGroupMut.isPending}
                                className="rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                              >
                                ↓
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                      {t('admin_dashboard.group_tip')}
                    </div>
                  </Card>

                  <Card className="p-3 sm:p-4">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {t('admin_dashboard.bulk_assign_title')}
                    </h3>
                    <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {t('admin_dashboard.bulk_assign_selected', {
                        count: selectedMonitorIds.length,
                      })}
                    </div>
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="text-xs text-slate-500 dark:text-slate-400">
                          {t('admin_dashboard.bulk_assign_target_group')}
                        </label>
                        <input
                          type="text"
                          value={bulkTargetGroup}
                          onChange={(e) => setBulkTargetGroup(e.target.value)}
                          list="monitor-groups-datalist"
                          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                          placeholder={ungroupedLabel}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 dark:text-slate-400">
                          {t('admin_dashboard.bulk_assign_target_group_order')}
                        </label>
                        <input
                          type="number"
                          value={bulkTargetGroupSortOrderInput}
                          onChange={(e) => setBulkTargetGroupSortOrderInput(e.target.value)}
                          min={-100000}
                          max={100000}
                          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                          placeholder={t(
                            'admin_dashboard.bulk_assign_target_group_order_placeholder',
                          )}
                        />
                      </div>
                      <Button
                        type="button"
                        disabled={
                          selectedMonitorIds.length === 0 || assignSelectedMonitorsMut.isPending
                        }
                        onClick={() => assignSelectedMonitorsMut.mutate()}
                        className="w-full"
                      >
                        {assignSelectedMonitorsMut.isPending
                          ? t('admin_dashboard.bulk_assign_apply_pending')
                          : t('admin_dashboard.bulk_assign_apply', {
                              count: selectedMonitorIds.length,
                            })}
                      </Button>
                      {selectedMonitorIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedMonitorIds([])}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                          {t('admin_dashboard.bulk_assign_clear')}
                        </button>
                      )}
                    </div>
                    <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                      {t('admin_dashboard.bulk_assign_help', { label: ungroupedLabel })}
                    </div>
                  </Card>

                  {monitorGroupReorderError && (
                    <Card className="p-3 border-red-200 bg-red-50/70 dark:bg-red-500/10 dark:border-red-400/30">
                      <div className="text-sm text-red-700 dark:text-red-300">
                        {monitorGroupReorderError}
                      </div>
                    </Card>
                  )}
                  {monitorGroupManageError && (
                    <Card className="p-3 border-red-200 bg-red-50/70 dark:bg-red-500/10 dark:border-red-400/30">
                      <div className="text-sm text-red-700 dark:text-red-300">
                        {monitorGroupManageError}
                      </div>
                    </Card>
                  )}

                  <datalist id="monitor-groups-datalist">
                    <option value={ungroupedLabel} />
                    {monitorGroupLabels
                      .filter((label) => label !== UNGROUPED_LABEL)
                      .map((label) => (
                        <option key={label} value={label} />
                      ))}
                  </datalist>
                </div>

                <div className="order-1 min-w-0 space-y-4 lg:order-2">
                  <Card className="p-3 sm:p-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div className="order-1 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <label className="text-xs text-slate-500 dark:text-slate-400">
                          <span className="mb-1 block">{t('common.group')}</span>
                          <select
                            value={monitorGroupMode}
                            onChange={(e) =>
                              setMonitorGroupMode(e.target.value as MonitorGroupMode)
                            }
                            className="ui-select mt-1 block w-full"
                          >
                            <option value="grouped">
                              {t('admin_dashboard.monitor_group_mode_grouped')}
                            </option>
                            <option value="flat">
                              {t('admin_dashboard.monitor_group_mode_flat')}
                            </option>
                          </select>
                        </label>
                        <label className="text-xs text-slate-500 dark:text-slate-400">
                          <span className="mb-1 block">{t('common.sort')}</span>
                          <select
                            value={monitorSortMode}
                            onChange={(e) => setMonitorSortMode(e.target.value as MonitorSortMode)}
                            className="ui-select mt-1 block w-full"
                          >
                            <option value="configured">
                              {t('admin_dashboard.monitor_sort_mode_configured')}
                            </option>
                            <option value="status">{t('common.state')}</option>
                            <option value="name">{t('common.name')}</option>
                            <option value="last_checked_at">
                              {t('admin_dashboard.monitor_sort_mode_last_check')}
                            </option>
                            <option value="created_at">
                              {t('admin_dashboard.monitor_sort_mode_created_time')}
                            </option>
                          </select>
                        </label>
                        <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2 xl:col-span-1">
                          <span className="mb-1 block">{t('common.direction')}</span>
                          <select
                            value={monitorSortDirection}
                            onChange={(e) =>
                              setMonitorSortDirection(e.target.value as MonitorSortDirection)
                            }
                            className="ui-select mt-1 block w-full"
                          >
                            <option value="asc">{t('common.asc')}</option>
                            <option value="desc">{t('common.desc')}</option>
                          </select>
                        </label>
                      </div>
                      <div className="order-2 text-xs text-slate-500 dark:text-slate-400 xl:text-right">
                        {t('admin_dashboard.monitor_list_summary', {
                          filtered: filteredMonitors.length,
                          total: sortedMonitors.length,
                        })}
                        {monitorGroupFilter !== ALL_GROUPS_FILTER && (
                          <>
                            {' '}
                            <span className="font-semibold text-slate-700 dark:text-slate-200">
                              {t('admin_dashboard.monitor_list_summary_in_group', {
                                group: toUiGroupLabel(monitorGroupFilter),
                              })}
                            </span>
                          </>
                        )}
                        {' · '}
                        {t('admin_dashboard.monitor_list_summary_selected', {
                          count: selectedMonitorIds.length,
                        })}
                      </div>
                    </div>
                  </Card>

                  {filteredMonitors.length === 0 ? (
                    <Card className="p-6 sm:p-8 text-center text-slate-500 dark:text-slate-400">
                      {t('admin_dashboard.monitor_empty_in_group')}
                    </Card>
                  ) : (
                    <Card className="overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[860px] lg:min-w-[980px]">
                          <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                            <tr>
                              <th className="px-3 sm:px-4 py-3 text-left">
                                <input
                                  type="checkbox"
                                  checked={allVisibleMonitorsSelected}
                                  ref={(el) => {
                                    if (el)
                                      el.indeterminate =
                                        !allVisibleMonitorsSelected && someVisibleMonitorsSelected;
                                  }}
                                  onChange={() => {
                                    if (allVisibleMonitorsSelected) {
                                      setSelectedMonitorIds((prev) =>
                                        prev.filter((id) => !visibleMonitorIds.includes(id)),
                                      );
                                      return;
                                    }
                                    setSelectedMonitorIds((prev) => {
                                      const next = new Set(prev);
                                      for (const id of visibleMonitorIds) next.add(id);
                                      return [...next];
                                    });
                                  }}
                                  aria-label={t('admin_dashboard.monitor_select_visible')}
                                  className="h-4 w-4 rounded border-slate-300 text-slate-700 focus:ring-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                                />
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.name')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.group')}
                              </th>
                              <th className="hidden px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide lg:table-cell">
                                {t('admin_dashboard.monitor_table_group_order')}
                              </th>
                              <th className="hidden px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide lg:table-cell">
                                {t('admin_dashboard.monitor_table_monitor_order')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.type')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.target')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.state')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('admin_dashboard.monitor_table_last_check')}
                              </th>
                              <th className="hidden px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide xl:table-cell">
                                {t('admin_dashboard.monitor_table_last_error')}
                              </th>
                              <th className="px-3 sm:px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                {t('common.actions')}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {filteredMonitors.map((m, index) => {
                              const groupLabel = monitorGroupLabel(m);
                              const prevMonitor = index > 0 ? filteredMonitors[index - 1] : null;
                              const prevGroupLabel = prevMonitor
                                ? monitorGroupLabel(prevMonitor)
                                : null;
                              const showGroupHeader =
                                monitorGroupMode === 'grouped' && groupLabel !== prevGroupLabel;
                              const groupMeta = monitorGroupMetaByLabel.get(groupLabel);

                              return (
                                <Fragment key={m.id}>
                                  {showGroupHeader && (
                                    <tr className="bg-slate-100/70 dark:bg-slate-800/80">
                                      <td
                                        colSpan={11}
                                        className="px-3 sm:px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300"
                                      >
                                        {t('admin_dashboard.monitor_group_header', {
                                          group: toUiGroupLabel(groupLabel),
                                          count: monitorCountsByGroup.get(groupLabel) ?? 0,
                                          order: groupMeta?.sortOrder ?? 0,
                                        })}
                                      </td>
                                    </tr>
                                  )}
                                  <tr className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                                    <td className="px-3 sm:px-4 py-3">
                                      <input
                                        type="checkbox"
                                        checked={selectedMonitorIdSet.has(m.id)}
                                        onChange={() => {
                                          setSelectedMonitorIds((prev) => {
                                            if (prev.includes(m.id))
                                              return prev.filter((id) => id !== m.id);
                                            return [...prev, m.id];
                                          });
                                        }}
                                        aria-label={t('admin_dashboard.monitor_select_row', {
                                          name: formatMonitorDisplayName(m),
                                        })}
                                        className="h-4 w-4 rounded border-slate-300 text-slate-700 focus:ring-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                                      />
                                    </td>
                                    <td className="px-3 sm:px-4 py-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                                      <div className="flex items-center gap-1.5">
                                        <span className="truncate">{m.name}</span>
                                        <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                                          #{m.id}
                                        </span>
                                      </div>
                                    </td>
                                    <td className="px-3 sm:px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                                      {toUiGroupLabel(groupLabel)}
                                    </td>
                                    <td className="hidden px-3 sm:px-4 py-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums lg:table-cell">
                                      {m.group_sort_order}
                                    </td>
                                    <td className="hidden px-3 sm:px-4 py-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums lg:table-cell">
                                      {m.sort_order}
                                    </td>
                                    <td className="px-3 sm:px-4 py-3">
                                      <Badge variant="info">{m.type}</Badge>
                                    </td>
                                    <td className="max-w-[160px] truncate px-3 py-3 text-sm text-slate-500 dark:text-slate-400 sm:max-w-[220px] sm:px-4">
                                      {m.target}
                                    </td>
                                    <td className="px-3 sm:px-4 py-3">
                                      <div className="flex items-center gap-2">
                                        <Badge
                                          variant={
                                            m.status === 'up'
                                              ? 'up'
                                              : m.status === 'down'
                                                ? 'down'
                                                : m.status === 'maintenance'
                                                  ? 'maintenance'
                                                  : m.status === 'paused'
                                                    ? 'paused'
                                                    : 'unknown'
                                          }
                                        >
                                          {statusLabel(m.status, t)}
                                        </Badge>
                                        {!m.is_active && (
                                          <Badge variant="unknown">{t('common.inactive')}</Badge>
                                        )}
                                      </div>
                                    </td>
                                    <td className="px-3 sm:px-4 py-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                      {m.last_checked_at ? (
                                        <>
                                          {formatDateTime(
                                            m.last_checked_at,
                                            settings?.site_timezone,
                                          )}
                                          {m.last_latency_ms !== null
                                            ? ` (${m.last_latency_ms}ms)`
                                            : ''}
                                        </>
                                      ) : (
                                        '-'
                                      )}
                                    </td>
                                    <td className="hidden max-w-[260px] px-3 sm:px-4 py-3 text-xs text-slate-500 dark:text-slate-400 xl:table-cell">
                                      <span
                                        className="block truncate"
                                        title={m.last_error ?? undefined}
                                      >
                                        {m.last_error ? m.last_error : '-'}
                                      </span>
                                    </td>
                                    <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                                      <div className="flex items-center justify-end gap-1 sm:gap-0">
                                        <button
                                          onClick={() => {
                                            setTestingMonitorId(m.id);
                                            setMonitorTestFeedback(null);
                                            setMonitorTestError(null);
                                            testMonitorMut.mutate(m.id);
                                          }}
                                          disabled={testMonitorMut.isPending}
                                          className={cn(
                                            TABLE_ACTION_BUTTON_CLASS,
                                            'text-blue-600 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20 dark:hover:text-blue-300 disabled:opacity-50',
                                          )}
                                        >
                                          {testingMonitorId === m.id
                                            ? t('common.testing')
                                            : t('common.test')}
                                        </button>
                                        <button
                                          onClick={() => {
                                            if (m.status === 'paused') {
                                              resumeMonitorMut.mutate(m.id);
                                            } else {
                                              pauseMonitorMut.mutate(m.id);
                                            }
                                          }}
                                          disabled={
                                            pauseMonitorMut.isPending ||
                                            resumeMonitorMut.isPending ||
                                            testingMonitorId === m.id
                                          }
                                          className={cn(
                                            TABLE_ACTION_BUTTON_CLASS,
                                            'text-amber-700 hover:bg-amber-50 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-900/20 dark:hover:text-amber-200 disabled:opacity-50',
                                          )}
                                        >
                                          {m.status === 'paused'
                                            ? t('common.resume')
                                            : t('common.pause')}
                                        </button>
                                        <button
                                          onClick={() => {
                                            createMonitorMut.reset();
                                            updateMonitorMut.reset();
                                            setModal({ type: 'edit-monitor', monitor: m });
                                          }}
                                          className={cn(
                                            TABLE_ACTION_BUTTON_CLASS,
                                            'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200',
                                          )}
                                        >
                                          {t('common.edit')}
                                        </button>
                                        <button
                                          onClick={() =>
                                            confirm(`${t('common.delete')}?`) &&
                                            deleteMonitorMut.mutate(m.id)
                                          }
                                          className={cn(
                                            TABLE_ACTION_BUTTON_CLASS,
                                            'text-red-500 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300',
                                          )}
                                        >
                                          {t('common.delete')}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'notifications' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {t('admin_dashboard.notification_channels_title')}
              </h2>
              <Button onClick={() => setModal({ type: 'create-channel' })}>
                {t('admin_dashboard.create_channel')}
              </Button>
            </div>
            {testingChannelId !== null && (
              <Card className="p-3 border-blue-200 bg-blue-50/70 dark:bg-blue-500/10 dark:border-blue-400/30">
                <div className="text-sm text-blue-700 dark:text-blue-300">
                  {t('admin_dashboard.webhook_test_running', {
                    name: channelNameById.get(testingChannelId) ?? `#${testingChannelId}`,
                  })}
                </div>
              </Card>
            )}

            {channelTestFeedback && (
              <Card className="p-3 border-slate-200 dark:border-slate-600">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_dashboard.webhook_test_last', {
                      name:
                        channelNameById.get(channelTestFeedback.channelId) ??
                        `#${channelTestFeedback.channelId}`,
                    })}
                  </div>
                  <Badge
                    variant={
                      channelTestFeedback.delivery?.status === 'success'
                        ? 'up'
                        : channelTestFeedback.delivery?.status === 'failed'
                          ? 'down'
                          : 'unknown'
                    }
                  >
                    {channelTestFeedback.delivery?.status === 'success'
                      ? t('admin_dashboard.webhook_test_status_success')
                      : channelTestFeedback.delivery?.status === 'failed'
                        ? t('admin_dashboard.webhook_test_status_failed')
                        : t('admin_dashboard.webhook_test_unknown')}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(channelTestFeedback.at, settings?.site_timezone)}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    {t('admin_dashboard.webhook_test_http', {
                      value: channelTestFeedback.delivery?.http_status ?? '-',
                    })}
                  </span>
                  <span className="max-w-full truncate" title={channelTestFeedback.eventKey}>
                    {t('admin_dashboard.webhook_test_event_key', {
                      value: channelTestFeedback.eventKey,
                    })}
                  </span>
                </div>
                <div
                  className={`mt-2 text-sm ${
                    channelTestFeedback.delivery?.status === 'success'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {channelTestFeedback.delivery?.error
                    ? channelTestFeedback.delivery.error
                    : channelTestFeedback.delivery
                      ? t('admin_dashboard.webhook_delivery_success')
                      : t('admin_dashboard.webhook_delivery_missing')}
                </div>
              </Card>
            )}

            {channelTestError && (
              <Card className="p-3 border-red-200 bg-red-50/70 dark:bg-red-500/10 dark:border-red-400/30">
                <div className="text-sm font-medium text-red-700 dark:text-red-300">
                  {t('admin_dashboard.webhook_test_failed', {
                    name:
                      channelNameById.get(channelTestError.channelId) ??
                      `#${channelTestError.channelId}`,
                  })}
                </div>
                <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {formatDateTime(channelTestError.at, settings?.site_timezone)}
                </div>
                <div className="mt-1 text-sm text-red-700 dark:text-red-300">
                  {channelTestError.message}
                </div>
              </Card>
            )}

            {channelsQuery.isLoading ? (
              <div className="text-slate-500 dark:text-slate-400">{t('common.loading')}</div>
            ) : !channelsQuery.data?.notification_channels.length ? (
              <Card className="p-6 sm:p-8 text-center text-slate-500 dark:text-slate-400">
                {t('admin_dashboard.no_channels_yet')}
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[500px]">
                    <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                      <tr>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.name')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.type')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.url')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.actions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {channelsQuery.data.notification_channels.map((ch) => (
                        <tr
                          key={ch.id}
                          className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                        >
                          <td className="px-3 sm:px-4 py-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                            {ch.name}
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <Badge variant="info">{ch.type}</Badge>
                          </td>
                          <td className="px-3 sm:px-4 py-3 text-sm text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                            {ch.config_json.url}
                          </td>
                          <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1 sm:gap-0">
                              <button
                                onClick={() => {
                                  setTestingChannelId(ch.id);
                                  setChannelTestFeedback(null);
                                  setChannelTestError(null);
                                  testChannelMut.mutate(ch.id);
                                }}
                                disabled={testChannelMut.isPending}
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-blue-600 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20 dark:hover:text-blue-300 disabled:opacity-50',
                                )}
                              >
                                {testingChannelId === ch.id
                                  ? t('common.testing')
                                  : t('common.test')}
                              </button>
                              <button
                                onClick={() => setModal({ type: 'edit-channel', channel: ch })}
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200',
                                )}
                              >
                                {t('common.edit')}
                              </button>
                              <button
                                onClick={() =>
                                  confirm(`${t('common.delete')} "${ch.name}"?`) &&
                                  deleteChannelMut.mutate(ch.id)
                                }
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-red-500 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300',
                                )}
                              >
                                {t('common.delete')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {t('admin_dashboard.tab.settings')}
              </h2>
            </div>

            <Card className="p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.uptime_rating.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.uptime_rating.help')}
                  </div>
                </div>

                <select
                  value={settingsDraft?.uptime_rating_level ?? 3}
                  onChange={(e) => {
                    const next = Number(e.target.value) as 1 | 2 | 3 | 4 | 5;
                    const cur = settingsDraft?.uptime_rating_level ?? 3;
                    if (next === cur) return;
                    setSettingsDraft((prev) =>
                      prev ? { ...prev, uptime_rating_level: next } : prev,
                    );
                    patchSettingsMut.mutate({ uptime_rating_level: next });
                  }}
                  disabled={settingsQuery.isLoading || !settingsDraft}
                  className="ui-select w-full sm:w-[21rem] disabled:opacity-50"
                >
                  <option value={1}>{t('admin_settings.uptime_rating.level_1')}</option>
                  <option value={2}>{t('admin_settings.uptime_rating.level_2')}</option>
                  <option value={3}>{t('admin_settings.uptime_rating.level_3')}</option>
                  <option value={4}>{t('admin_settings.uptime_rating.level_4')}</option>
                  <option value={5}>{t('admin_settings.uptime_rating.level_5')}</option>
                </select>
              </div>

              {settingsQuery.isError && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {t('admin_dashboard.failed_load_settings')}
                </div>
              )}

              {patchSettingsMut.isError && !localePatchFallbackActive && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {formatError(patchSettingsMut.error) ??
                    t('admin_dashboard.failed_update_settings')}
                </div>
              )}
            </Card>

            <Card className="p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.locale.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.locale.help')}
                  </div>
                </div>

                <select
                  value={settingsDraft?.site_locale ?? 'auto'}
                  onChange={(e) => {
                    const next = e.target.value as AdminSettings['site_locale'];
                    applyLocaleLocally(next);
                    if (serverLocalePatchSupported) {
                      patchSettingsMut.mutate({ site_locale: next });
                    }
                  }}
                  disabled={settingsQuery.isLoading || !settingsDraft}
                  className="ui-select w-full sm:w-[21rem] disabled:opacity-50"
                >
                  {localeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {localePatchFallbackActive && (
                <div className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                  {t('admin_settings.locale.local_only')}
                </div>
              )}
            </Card>

            <Card className="p-4 sm:p-5">
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.branding.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.branding.help')}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.branding.site_title')}
                    </label>
                    <input
                      value={settingsDraft?.site_title ?? ''}
                      aria-label={t('admin_settings.branding.site_title')}
                      onChange={(e) => {
                        const next = e.target.value.slice(0, 100);
                        setSettingsDraft((prev) => (prev ? { ...prev, site_title: next } : prev));
                      }}
                      onFocus={() => setFocusedSetting('site_title')}
                      onBlur={(e) => {
                        setFocusedSetting(null);
                        const next = sanitizeSiteTitle(e.currentTarget.value);
                        setSettingsDraft((prev) => (prev ? { ...prev, site_title: next } : prev));
                        patchSettingsMut.mutate({ site_title: next });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        (e.currentTarget as HTMLInputElement).blur();
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      className="w-full border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.branding.timezone')}
                    </label>
                    <input
                      value={settingsDraft?.site_timezone ?? ''}
                      aria-label={t('admin_settings.branding.timezone')}
                      onChange={(e) => {
                        const next = e.target.value.slice(0, 64);
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, site_timezone: next } : prev,
                        );
                      }}
                      onFocus={() => setFocusedSetting('site_timezone')}
                      onBlur={(e) => {
                        setFocusedSetting(null);
                        const next = e.currentTarget.value.trim().slice(0, 64) || 'UTC';
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, site_timezone: next } : prev,
                        );
                        patchSettingsMut.mutate({ site_timezone: next });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        (e.currentTarget as HTMLInputElement).blur();
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      placeholder="UTC"
                      className="w-full border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                    />
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      {t('admin_settings.branding.timezone_help')}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {t('admin_settings.branding.site_description')}
                  </label>
                  <textarea
                    value={settingsDraft?.site_description ?? ''}
                    aria-label={t('admin_settings.branding.site_description')}
                    onChange={(e) => {
                      const next = e.target.value.slice(0, 500);
                      setSettingsDraft((prev) =>
                        prev ? { ...prev, site_description: next } : prev,
                      );
                    }}
                    onFocus={() => setFocusedSetting('site_description')}
                    onBlur={(e) => {
                      setFocusedSetting(null);
                      const next = sanitizeSiteDescription(e.currentTarget.value);
                      setSettingsDraft((prev) =>
                        prev ? { ...prev, site_description: next } : prev,
                      );
                      patchSettingsMut.mutate({ site_description: next });
                    }}
                    disabled={settingsQuery.isLoading || !settingsDraft}
                    rows={3}
                    className="w-full border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                  />
                </div>
              </div>
            </Card>

            <Card className="p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.retention.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.retention.help')}
                  </div>
                </div>

                <input
                  type="number"
                  min={1}
                  max={365}
                  aria-label={t('admin_settings.retention.days')}
                  value={settingsDraft?.retention_check_results_days ?? 7}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const next = Number.isFinite(raw) ? Math.trunc(raw) : 1;
                    setSettingsDraft((prev) =>
                      prev ? { ...prev, retention_check_results_days: next } : prev,
                    );
                  }}
                  onFocus={() => setFocusedSetting('retention_check_results_days')}
                  onBlur={(e) => {
                    setFocusedSetting(null);
                    const next = clampInt(Number(e.currentTarget.value), 1, 365);
                    setSettingsDraft((prev) =>
                      prev ? { ...prev, retention_check_results_days: next } : prev,
                    );
                    patchSettingsMut.mutate({ retention_check_results_days: next });
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    (e.currentTarget as HTMLInputElement).blur();
                  }}
                  disabled={settingsQuery.isLoading || !settingsDraft}
                  className="w-40 border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                />
              </div>
            </Card>

            <Card className="p-4 sm:p-5">
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.state_machine.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.state_machine.help')}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.state_machine.failures_to_down')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={settingsDraft?.state_failures_to_down_from_up ?? 2}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        const next = Number.isFinite(raw) ? Math.trunc(raw) : 1;
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, state_failures_to_down_from_up: next } : prev,
                        );
                      }}
                      onFocus={() => setFocusedSetting('state_failures_to_down_from_up')}
                      onBlur={(e) => {
                        setFocusedSetting(null);
                        const next = clampInt(Number(e.currentTarget.value), 1, 10);
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, state_failures_to_down_from_up: next } : prev,
                        );
                        patchSettingsMut.mutate({ state_failures_to_down_from_up: next });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        (e.currentTarget as HTMLInputElement).blur();
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      className="w-full border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.state_machine.successes_to_up')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={settingsDraft?.state_successes_to_up_from_down ?? 2}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        const next = Number.isFinite(raw) ? Math.trunc(raw) : 1;
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, state_successes_to_up_from_down: next } : prev,
                        );
                      }}
                      onFocus={() => setFocusedSetting('state_successes_to_up_from_down')}
                      onBlur={(e) => {
                        setFocusedSetting(null);
                        const next = clampInt(Number(e.currentTarget.value), 1, 10);
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, state_successes_to_up_from_down: next } : prev,
                        );
                        patchSettingsMut.mutate({ state_successes_to_up_from_down: next });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        (e.currentTarget as HTMLInputElement).blur();
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      className="w-full border dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                    />
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-4 sm:p-5">
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('admin_settings.defaults.title')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t('admin_settings.defaults.help')}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.defaults.overview_range')}
                    </label>
                    <select
                      value={settingsDraft?.admin_default_overview_range ?? '24h'}
                      onChange={(e) => {
                        const next = e.target.value as '24h' | '7d';
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, admin_default_overview_range: next } : prev,
                        );
                        patchSettingsMut.mutate({ admin_default_overview_range: next });
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      className="ui-select w-full disabled:opacity-50"
                    >
                      <option value="24h">24h</option>
                      <option value="7d">7d</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {t('admin_settings.defaults.monitor_range')}
                    </label>
                    <select
                      value={settingsDraft?.admin_default_monitor_range ?? '24h'}
                      onChange={(e) => {
                        const next = e.target.value as AdminSettings['admin_default_monitor_range'];
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, admin_default_monitor_range: next } : prev,
                        );
                        patchSettingsMut.mutate({ admin_default_monitor_range: next });
                      }}
                      disabled={settingsQuery.isLoading || !settingsDraft}
                      className="ui-select w-full disabled:opacity-50"
                    >
                      <option value="24h">24h</option>
                      <option value="7d">7d</option>
                      <option value="30d">30d</option>
                      <option value="90d">90d</option>
                    </select>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}

        {tab === 'incidents' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {t('admin_dashboard.tab.incidents')}
              </h2>
              <Button onClick={() => setModal({ type: 'create-incident' })}>
                {t('admin_dashboard.create_incident')}
              </Button>
            </div>
            {incidentsQuery.isLoading ? (
              <div className="text-slate-500 dark:text-slate-400">{t('common.loading')}</div>
            ) : !incidentsQuery.data?.incidents.length ? (
              <Card className="p-6 sm:p-8 text-center text-slate-500 dark:text-slate-400">
                {t('admin_dashboard.no_incidents_yet')}
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[650px]">
                    <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                      <tr>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.title_label')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.monitors')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.state')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.impact')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.actions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {incidentsQuery.data.incidents.map((it) => (
                        <tr
                          key={it.id}
                          className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                        >
                          <td className="px-3 sm:px-4 py-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                            {it.title}
                          </td>
                          <td className="px-3 sm:px-4 py-3 text-sm text-slate-500 dark:text-slate-400 truncate max-w-[150px]">
                            {it.monitor_ids
                              .map((id) => formatMonitorDisplayNameById(id, monitorNameById))
                              .join(', ')}
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <Badge variant={it.status === 'resolved' ? 'up' : 'paused'}>
                              {it.status === 'resolved'
                                ? t('incident_status.resolved')
                                : incidentStatusLabel(it.status, t)}
                            </Badge>
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <Badge
                              variant={
                                it.impact === 'critical'
                                  ? 'down'
                                  : it.impact === 'major'
                                    ? 'down'
                                    : 'paused'
                              }
                            >
                              {incidentImpactLabel(it.impact, t)}
                            </Badge>
                          </td>
                          <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1 sm:gap-0">
                              <button
                                onClick={() =>
                                  setModal({ type: 'add-incident-update', incident: it })
                                }
                                disabled={it.status === 'resolved'}
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-blue-600 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20 dark:hover:text-blue-300 disabled:opacity-50',
                                )}
                              >
                                {t('common.update')}
                              </button>
                              <button
                                onClick={() => setModal({ type: 'resolve-incident', incident: it })}
                                disabled={it.status === 'resolved'}
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-900/20 dark:hover:text-emerald-300 disabled:opacity-50',
                                )}
                              >
                                {t('resolve_incident.resolve')}
                              </button>
                              <button
                                onClick={() =>
                                  confirm(`${t('common.delete')} "${it.title}"?`) &&
                                  deleteIncidentMut.mutate(it.id)
                                }
                                className={cn(
                                  TABLE_ACTION_BUTTON_CLASS,
                                  'text-red-500 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300',
                                )}
                              >
                                {t('common.delete')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'maintenance' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {t('admin_dashboard.maintenance_windows_title')}
              </h2>
              <Button onClick={() => setModal({ type: 'create-maintenance' })}>
                {t('admin_dashboard.create_maintenance')}
              </Button>
            </div>
            {maintenanceQuery.isLoading ? (
              <div className="text-slate-500 dark:text-slate-400">{t('common.loading')}</div>
            ) : !maintenanceQuery.data?.maintenance_windows.length ? (
              <Card className="p-6 sm:p-8 text-center text-slate-500 dark:text-slate-400">
                {t('admin_dashboard.no_maintenance_yet')}
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[650px]">
                    <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                      <tr>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.title_label')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.monitors')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.schedule')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.state')}
                        </th>
                        <th className="px-3 sm:px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('common.actions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {maintenanceQuery.data.maintenance_windows.map((w) => {
                        const now = Math.floor(Date.now() / 1000);
                        const state =
                          w.starts_at <= now && w.ends_at > now
                            ? t('common.active')
                            : w.starts_at > now
                              ? t('common.upcoming')
                              : t('common.ended');
                        return (
                          <tr
                            key={w.id}
                            className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                          >
                            <td className="px-3 sm:px-4 py-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                              {w.title}
                            </td>
                            <td className="px-3 sm:px-4 py-3 text-sm text-slate-500 dark:text-slate-400 truncate max-w-[120px]">
                              {w.monitor_ids
                                .map((id) => formatMonitorDisplayNameById(id, monitorNameById))
                                .join(', ')}
                            </td>
                            <td className="px-3 sm:px-4 py-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                              {formatDateTime(w.starts_at, settings?.site_timezone)} –{' '}
                              {formatDateTime(w.ends_at, settings?.site_timezone)}
                            </td>
                            <td className="px-3 sm:px-4 py-3">
                              <Badge
                                variant={
                                  state === t('common.active')
                                    ? 'maintenance'
                                    : state === t('common.upcoming')
                                      ? 'paused'
                                      : 'unknown'
                                }
                              >
                                {state}
                              </Badge>
                            </td>
                            <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1 sm:gap-0">
                                <button
                                  onClick={() => setModal({ type: 'edit-maintenance', window: w })}
                                  className={cn(
                                    TABLE_ACTION_BUTTON_CLASS,
                                    'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200',
                                  )}
                                >
                                  {t('common.edit')}
                                </button>
                                <button
                                  onClick={() =>
                                    confirm(`${t('common.delete')} "${w.title}"?`) &&
                                    deleteMaintenanceMut.mutate(w.id)
                                  }
                                  className={cn(
                                    TABLE_ACTION_BUTTON_CLASS,
                                    'text-red-500 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300',
                                  )}
                                >
                                  {t('common.delete')}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}
      </main>

      {modal.type !== 'none' && (
        <div className={MODAL_OVERLAY_CLASS}>
          <div className={`${MODAL_PANEL_CLASS} sm:max-w-md p-5 sm:p-6`}>
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-5">
              {modal.type === 'create-monitor' && t('admin_dashboard.create_monitor')}
              {modal.type === 'edit-monitor' && t('admin_dashboard.edit_monitor')}
              {modal.type === 'create-channel' && t('admin_dashboard.create_channel')}
              {modal.type === 'edit-channel' && t('admin_dashboard.edit_channel')}
              {modal.type === 'create-incident' && t('admin_dashboard.create_incident')}
              {modal.type === 'add-incident-update' && t('admin_dashboard.post_update')}
              {modal.type === 'resolve-incident' && t('admin_dashboard.resolve_incident')}
              {modal.type === 'create-maintenance' && t('admin_dashboard.create_maintenance')}
              {modal.type === 'edit-maintenance' && t('admin_dashboard.edit_maintenance')}
            </h2>

            {(modal.type === 'create-monitor' || modal.type === 'edit-monitor') && (
              <>
                {modal.type === 'create-monitor' && (
                  <MonitorForm
                    onSubmit={(data) => createMonitorMut.mutate(data)}
                    onCancel={closeModal}
                    isLoading={createMonitorMut.isPending}
                    error={formatError(createMonitorMut.error)}
                    groupOptions={monitorGroupLabels.filter((label) => label !== UNGROUPED_LABEL)}
                  />
                )}
                {modal.type === 'edit-monitor' && (
                  <MonitorForm
                    monitor={modal.monitor}
                    onSubmit={(data) => updateMonitorMut.mutate({ id: modal.monitor.id, data })}
                    onCancel={closeModal}
                    isLoading={updateMonitorMut.isPending}
                    error={formatError(updateMonitorMut.error)}
                    groupOptions={monitorGroupLabels.filter((label) => label !== UNGROUPED_LABEL)}
                  />
                )}
              </>
            )}
            {(modal.type === 'create-channel' || modal.type === 'edit-channel') && (
              <NotificationChannelForm
                channel={modal.type === 'edit-channel' ? modal.channel : undefined}
                onSubmit={(data) =>
                  modal.type === 'edit-channel'
                    ? updateChannelMut.mutate({ id: modal.channel.id, data })
                    : createChannelMut.mutate(data)
                }
                onCancel={closeModal}
                isLoading={createChannelMut.isPending || updateChannelMut.isPending}
                error={
                  modal.type === 'edit-channel'
                    ? formatError(updateChannelMut.error)
                    : formatError(createChannelMut.error)
                }
              />
            )}
            {modal.type === 'create-incident' && (
              <IncidentForm
                monitors={(monitorsQuery.data?.monitors ?? []).map((m) => ({
                  id: m.id,
                  name: formatMonitorDisplayName(m),
                }))}
                onSubmit={(data) => createIncidentMut.mutate(data)}
                onCancel={closeModal}
                isLoading={createIncidentMut.isPending}
              />
            )}
            {modal.type === 'add-incident-update' && (
              <IncidentUpdateForm
                onSubmit={(data) => addIncidentUpdateMut.mutate({ id: modal.incident.id, data })}
                onCancel={closeModal}
                isLoading={addIncidentUpdateMut.isPending}
              />
            )}
            {modal.type === 'resolve-incident' && (
              <ResolveIncidentForm
                onSubmit={(data) => resolveIncidentMut.mutate({ id: modal.incident.id, data })}
                onCancel={closeModal}
                isLoading={resolveIncidentMut.isPending}
              />
            )}
            {modal.type === 'create-maintenance' && (
              <MaintenanceWindowForm
                monitors={(monitorsQuery.data?.monitors ?? []).map((m) => ({
                  id: m.id,
                  name: formatMonitorDisplayName(m),
                }))}
                onSubmit={(data) => createMaintenanceMut.mutate(data)}
                onCancel={closeModal}
                isLoading={createMaintenanceMut.isPending}
              />
            )}
            {modal.type === 'edit-maintenance' && (
              <MaintenanceWindowForm
                monitors={(monitorsQuery.data?.monitors ?? []).map((m) => ({
                  id: m.id,
                  name: formatMonitorDisplayName(m),
                }))}
                window={modal.window}
                onSubmit={(data) => updateMaintenanceMut.mutate({ id: modal.window.id, data })}
                onCancel={closeModal}
                isLoading={updateMaintenanceMut.isPending}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
