import pLimit from 'p-limit';

import {
  expectedStatusJsonSchema,
  httpHeadersJsonSchema,
  parseDbJson,
  parseDbJsonNullable,
  webhookChannelConfigSchema,
  type HttpResponseMatchMode,
  type MonitorStatus,
} from '@uptimer/db';

import type { Env } from '../env';
import { runHttpCheck } from '../monitor/http';
import {
  computeNextState,
  type MonitorStateSnapshot,
  type NextState,
  type OutageAction,
} from '../monitor/state-machine';
import { runTcpCheck } from '../monitor/tcp';
import type { CheckOutcome } from '../monitor/types';
import { dispatchWebhookToChannels, type WebhookChannel } from '../notify/webhook';
import { computePublicHomepagePayload } from '../public/homepage';
import { refreshPublicHomepageSnapshotIfNeeded } from '../snapshots';
import { readSettings } from '../settings';
import { acquireLease } from './lock';

const LOCK_NAME = 'scheduler:tick';
const LOCK_LEASE_SECONDS = 55;

const CHECK_CONCURRENCY = 5;
const PERSIST_BATCH_SIZE = 25;

// Look back a bit so maintenance start/end notifications are not missed if a tick is delayed.
const MAINTENANCE_EVENT_LOOKBACK_SECONDS = 10 * 60;

type DueMonitorRow = {
  id: number;
  name: string;
  type: string;
  target: string;
  interval_sec: number;
  timeout_ms: number;
  http_method: string | null;
  http_headers_json: string | null;
  http_body: string | null;
  expected_status_json: string | null;
  response_keyword: string | null;
  response_keyword_mode: HttpResponseMatchMode | null;
  response_forbidden_keyword: string | null;
  response_forbidden_keyword_mode: HttpResponseMatchMode | null;
  state_status: string | null;
  state_last_error: string | null;
  last_changed_at: number | null;
  consecutive_failures: number | null;
  consecutive_successes: number | null;
};

type ActiveWebhookChannelRow = {
  id: number;
  name: string;
  config_json: string;
  created_at: number;
};

type WebhookChannelWithMeta = WebhookChannel & { created_at: number };

type NotifyContext = {
  ctx: ExecutionContext;
  envRecord: Record<string, unknown>;
  channels: WebhookChannelWithMeta[];
};

type CompletedDueMonitor = {
  row: DueMonitorRow;
  checkedAt: number;
  prevStatus: MonitorStatus | null;
  outcome: CheckOutcome;
  next: NextState;
  outageAction: OutageAction;
  stateLastError: string | null;
  maintenanceSuppressed: boolean;
};

async function listActiveWebhookChannels(db: D1Database): Promise<WebhookChannelWithMeta[]> {
  const { results } = await db
    .prepare(
      `
      SELECT id, name, config_json, created_at
      FROM notification_channels
      WHERE is_active = 1 AND type = 'webhook'
      ORDER BY id
    `,
    )
    .all<ActiveWebhookChannelRow>();

  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    config: parseDbJson(webhookChannelConfigSchema, r.config_json, { field: 'config_json' }),
    created_at: r.created_at,
  }));
}

async function listMaintenanceSuppressedMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(monitorIds)];
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(', ');
  const sql = `
    SELECT DISTINCT mwm.monitor_id
    FROM maintenance_window_monitors mwm
    JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
    WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
      AND mwm.monitor_id IN (${placeholders})
  `;

  const { results } = await db
    .prepare(sql)
    .bind(at, ...ids)
    .all<{ monitor_id: number }>();
  return new Set((results ?? []).map((r) => r.monitor_id));
}

// Maintenance notification helpers (scheduled emits maintenance.started / maintenance.ended).

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();
  if (windowIds.length === 0) return byWindow;

  const placeholders = windowIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT maintenance_window_id, monitor_id
    FROM maintenance_window_monitors
    WHERE maintenance_window_id IN (${placeholders})
    ORDER BY maintenance_window_id, monitor_id
  `;

  const { results } = await db
    .prepare(sql)
    .bind(...windowIds)
    .all<MaintenanceWindowMonitorLinkRow>();
  for (const r of results ?? []) {
    const existing = byWindow.get(r.maintenance_window_id) ?? [];
    existing.push(r.monitor_id);
    byWindow.set(r.maintenance_window_id, existing);
  }

  return byWindow;
}

async function listMaintenanceWindowsStartedBetween(
  db: D1Database,
  startInclusive: number,
  endInclusive: number,
): Promise<MaintenanceWindowRow[]> {
  if (endInclusive < startInclusive) return [];

  const { results } = await db
    .prepare(
      `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at >= ?1 AND starts_at <= ?2
      ORDER BY starts_at ASC, id ASC
    `,
    )
    .bind(startInclusive, endInclusive)
    .all<MaintenanceWindowRow>();

  return results ?? [];
}

async function listMaintenanceWindowsEndedBetween(
  db: D1Database,
  startInclusive: number,
  endInclusive: number,
): Promise<MaintenanceWindowRow[]> {
  if (endInclusive < startInclusive) return [];

  const { results } = await db
    .prepare(
      `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE ends_at >= ?1 AND ends_at <= ?2
      ORDER BY ends_at ASC, id ASC
    `,
    )
    .bind(startInclusive, endInclusive)
    .all<MaintenanceWindowRow>();

  return results ?? [];
}

function maintenanceWindowRowToPayload(row: MaintenanceWindowRow, monitorIds: number[]) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

function toHttpMethod(
  value: string | null,
): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | null {
  const normalized = (value ?? 'GET').toUpperCase();
  switch (normalized) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return normalized;
    default:
      return null;
  }
}

function toMonitorStatus(value: string | null): MonitorStatus | null {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

async function listDueMonitors(db: D1Database, checkedAt: number): Promise<DueMonitorRow[]> {
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.type,
        m.target,
        m.interval_sec,
        m.timeout_ms,
        m.http_method,
        m.http_headers_json,
        m.http_body,
        m.expected_status_json,
        m.response_keyword,
        m.response_keyword_mode,
        m.response_forbidden_keyword,
        m.response_forbidden_keyword_mode,
        s.status AS state_status,
        s.last_error AS state_last_error,
        s.last_changed_at,
        s.consecutive_failures,
        s.consecutive_successes
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND (s.status IS NULL OR s.status != 'paused')
        AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1 - m.interval_sec)
      ORDER BY m.id
    `,
    )
    .bind(checkedAt)
    .all<DueMonitorRow>();

  return results ?? [];
}

function computeStateLastError(
  nextStatus: MonitorStatus,
  outcome: CheckOutcome,
  prevLastError: string | null,
): string | null {
  if (nextStatus === 'down') {
    return outcome.status === 'up' ? prevLastError : outcome.error;
  }
  if (nextStatus === 'up') {
    return outcome.status === 'up' ? null : outcome.error;
  }
  return outcome.status === 'up' ? null : outcome.error;
}

function buildPersistStatements(completed: CompletedDueMonitor, db: D1Database): D1PreparedStatement[] {
  const {
    row,
    checkedAt,
    outcome,
    next,
    outageAction,
    stateLastError,
  } = completed;
  const checkError = outcome.status === 'up' ? null : outcome.error;

  const statements: D1PreparedStatement[] = [];

  statements.push(
    db.prepare(
      `
      INSERT INTO check_results (
        monitor_id,
        checked_at,
        status,
        latency_ms,
        http_status,
        error,
        location,
        attempt
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `,
    ).bind(
      row.id,
      checkedAt,
      outcome.status,
      outcome.latencyMs,
      outcome.httpStatus,
      checkError,
      null,
      outcome.attempts,
    ),
  );

  statements.push(
    db.prepare(
      `
      INSERT INTO monitor_state (
        monitor_id,
        status,
        last_checked_at,
        last_changed_at,
        last_latency_ms,
        last_error,
        consecutive_failures,
        consecutive_successes
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(monitor_id) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_changed_at = excluded.last_changed_at,
        last_latency_ms = excluded.last_latency_ms,
        last_error = excluded.last_error,
        consecutive_failures = excluded.consecutive_failures,
        consecutive_successes = excluded.consecutive_successes
    `,
    ).bind(
      row.id,
      next.status,
      checkedAt,
      next.lastChangedAt,
      outcome.latencyMs,
      stateLastError,
      next.consecutiveFailures,
      next.consecutiveSuccesses,
    ),
  );

  if (outageAction === 'open') {
    statements.push(
      db.prepare(
        `
        INSERT INTO outages (monitor_id, started_at, ended_at, initial_error, last_error)
        SELECT ?1, ?2, NULL, ?3, ?4
        WHERE NOT EXISTS (
          SELECT 1 FROM outages WHERE monitor_id = ?5 AND ended_at IS NULL
        )
      `,
      ).bind(row.id, checkedAt, checkError ?? 'down', checkError ?? 'down', row.id),
    );
  } else if (outageAction === 'close') {
    statements.push(
      db.prepare(
        `
        UPDATE outages
        SET ended_at = ?1
        WHERE monitor_id = ?2 AND ended_at IS NULL
      `,
      ).bind(checkedAt, row.id),
    );
  } else if (outageAction === 'update' && checkError) {
    statements.push(
      db.prepare(
        `
        UPDATE outages
        SET last_error = ?1
        WHERE monitor_id = ?2 AND ended_at IS NULL
      `,
      ).bind(checkError, row.id),
    );
  }

  return statements;
}

async function runDueMonitor(
  row: DueMonitorRow,
  checkedAt: number,
  maintenanceSuppressed: boolean,
  stateMachineConfig: { failuresToDownFromUp: number; successesToUpFromDown: number },
): Promise<CompletedDueMonitor> {
  const prevStatus = toMonitorStatus(row.state_status);
  const prev: MonitorStateSnapshot | null =
    prevStatus === null
      ? null
      : {
          status: prevStatus,
          lastChangedAt: row.last_changed_at,
          consecutiveFailures: row.consecutive_failures ?? 0,
          consecutiveSuccesses: row.consecutive_successes ?? 0,
        };

  let outcome: CheckOutcome;

  try {
    if (row.type === 'http') {
      const httpMethod = toHttpMethod(row.http_method);
      if (!httpMethod) {
        outcome = {
          status: 'unknown',
          latencyMs: null,
          httpStatus: null,
          error: 'Invalid http_method',
          attempts: 1,
        };
      } else {
        const httpHeaders = parseDbJsonNullable(httpHeadersJsonSchema, row.http_headers_json, {
          field: 'http_headers_json',
        });
        const expectedStatus = parseDbJsonNullable(
          expectedStatusJsonSchema,
          row.expected_status_json,
          {
            field: 'expected_status_json',
          },
        );

        outcome = await runHttpCheck({
          url: row.target,
          timeoutMs: row.timeout_ms,
          method: httpMethod,
          headers: httpHeaders,
          body: row.http_body,
          expectedStatus,
          responseKeyword: row.response_keyword,
          responseKeywordMode: row.response_keyword_mode,
          responseForbiddenKeyword: row.response_forbidden_keyword,
          responseForbiddenKeywordMode: row.response_forbidden_keyword_mode,
        });
      }
    } else if (row.type === 'tcp') {
      outcome = await runTcpCheck({ target: row.target, timeoutMs: row.timeout_ms });
    } else {
      outcome = {
        status: 'unknown',
        latencyMs: null,
        httpStatus: null,
        error: `Unsupported monitor type: ${String(row.type)}`,
        attempts: 1,
      };
    }
  } catch (err) {
    outcome = {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      attempts: 1,
    };
  }

  const { next, outageAction } = computeNextState(prev, outcome, checkedAt, stateMachineConfig);
  const stateLastError = computeStateLastError(next.status, outcome, row.state_last_error);

  return {
    row,
    checkedAt,
    prevStatus,
    outcome,
    next,
    outageAction,
    stateLastError,
    maintenanceSuppressed,
  };
}

async function persistCompletedMonitors(
  db: D1Database,
  completed: CompletedDueMonitor[],
): Promise<void> {
  for (let i = 0; i < completed.length; i += PERSIST_BATCH_SIZE) {
    const chunk = completed.slice(i, i + PERSIST_BATCH_SIZE);
    const statements: D1PreparedStatement[] = [];

    for (const monitor of chunk) {
      statements.push(...buildPersistStatements(monitor, db));
    }

    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
}

function queueMonitorNotification(
  env: Env,
  notify: NotifyContext | null,
  completed: CompletedDueMonitor,
): void {
  if (!notify || completed.maintenanceSuppressed || !completed.next.changed) {
    return;
  }

  const { row, checkedAt, prevStatus, outcome, next } = completed;

  const prevForEvent: MonitorStatus = prevStatus ?? 'unknown';
  let eventType: 'monitor.down' | 'monitor.up' | null = null;

  if ((prevForEvent === 'up' || prevForEvent === 'unknown') && next.status === 'down') {
    eventType = 'monitor.down';
  } else if (prevForEvent === 'down' && next.status === 'up') {
    eventType = 'monitor.up';
  }

  if (!eventType) {
    return;
  }

  const eventSuffix = eventType === 'monitor.down' ? 'down' : 'up';
  const eventKey = `monitor:${row.id}:${eventSuffix}:${checkedAt}`;

  const payload = {
    event: eventType,
    event_id: eventKey,
    timestamp: checkedAt,
    monitor: {
      id: row.id,
      name: row.name,
      type: row.type,
      target: row.target,
    },
    state: {
      status: next.status,
      latency_ms: outcome.latencyMs,
      http_status: outcome.httpStatus,
      error: outcome.error,
      location: null,
    },
  };

  notify.ctx.waitUntil(
    dispatchWebhookToChannels({
      db: env.DB,
      env: notify.envRecord,
      channels: notify.channels,
      eventType,
      eventKey,
      payload,
    }).catch((err) => {
      console.error('notify: failed to dispatch webhooks', err);
    }),
  );
}

export async function runScheduledTick(env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const checkedAt = Math.floor(now / 60) * 60;
  const queueHomepageRefresh = () =>
    refreshPublicHomepageSnapshotIfNeeded({
      db: env.DB,
      now,
      compute: () => computePublicHomepagePayload(env.DB, Math.floor(Date.now() / 1000)),
    }).catch((err) => {
      console.warn('homepage snapshot: refresh failed', err);
    });

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) {
    return;
  }

  const [channels, settings, due] = await Promise.all([
    listActiveWebhookChannels(env.DB),
    readSettings(env.DB),
    listDueMonitors(env.DB, checkedAt),
  ]);

  const notify: NotifyContext | null =
    channels.length === 0
      ? null
      : { ctx, envRecord: env as unknown as Record<string, unknown>, channels };

  const stateMachineConfig = {
    failuresToDownFromUp: settings.state_failures_to_down_from_up,
    successesToUpFromDown: settings.state_successes_to_up_from_down,
  };

  // Emit maintenance start/end notifications. This is best-effort and uses the existing
  // notification_deliveries idempotency key to avoid duplicates.
  if (notify) {
    const lookbackStart = Math.max(0, now - MAINTENANCE_EVENT_LOOKBACK_SECONDS);

    const [started, ended] = await Promise.all([
      listMaintenanceWindowsStartedBetween(env.DB, lookbackStart, now),
      listMaintenanceWindowsEndedBetween(env.DB, lookbackStart, now),
    ]);

    const windowIds = [...new Set([...started.map((w) => w.id), ...ended.map((w) => w.id)])];
    const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(env.DB, windowIds);

    for (const w of started) {
      const channelsForEvent = notify.channels.filter((c) => c.created_at <= w.starts_at);
      if (channelsForEvent.length === 0) continue;

      const eventType = 'maintenance.started';
      const eventKey = `maintenance:${w.id}:started:${w.starts_at}`;
      const payload = {
        event: eventType,
        event_id: eventKey,
        timestamp: w.starts_at,
        maintenance: maintenanceWindowRowToPayload(w, monitorIdsByWindowId.get(w.id) ?? []),
      };

      notify.ctx.waitUntil(
        dispatchWebhookToChannels({
          db: env.DB,
          env: notify.envRecord,
          channels: channelsForEvent,
          eventType,
          eventKey,
          payload,
        }).catch((err) => {
          console.error('notify: failed to dispatch maintenance.started', err);
        }),
      );
    }

    for (const w of ended) {
      const channelsForEvent = notify.channels.filter((c) => c.created_at <= w.ends_at);
      if (channelsForEvent.length === 0) continue;

      const eventType = 'maintenance.ended';
      const eventKey = `maintenance:${w.id}:ended:${w.ends_at}`;
      const payload = {
        event: eventType,
        event_id: eventKey,
        timestamp: w.ends_at,
        maintenance: maintenanceWindowRowToPayload(w, monitorIdsByWindowId.get(w.id) ?? []),
      };

      notify.ctx.waitUntil(
        dispatchWebhookToChannels({
          db: env.DB,
          env: notify.envRecord,
          channels: channelsForEvent,
          eventType,
          eventKey,
          payload,
        }).catch((err) => {
          console.error('notify: failed to dispatch maintenance.ended', err);
        }),
      );
    }
  }

  if (due.length === 0) {
    ctx.waitUntil(queueHomepageRefresh());
    return;
  }

  // Maintenance suppression is monitor-scoped.
  const dueMonitorIds = due.map((m) => m.id);
  const suppressedMonitorIds =
    notify === null
      ? new Set<number>()
      : await listMaintenanceSuppressedMonitorIds(env.DB, now, dueMonitorIds);

  const limit = pLimit(CHECK_CONCURRENCY);
  const settled = await Promise.allSettled(
    due.map((m) =>
      limit(() =>
        runDueMonitor(
          m,
          checkedAt,
          suppressedMonitorIds.has(m.id),
          stateMachineConfig,
        ),
      ),
    ),
  );

  const rejected = settled.filter((r) => r.status === 'rejected');
  const completed = settled
    .filter((r): r is PromiseFulfilledResult<CompletedDueMonitor> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (completed.length > 0) {
    await persistCompletedMonitors(env.DB, completed);

    for (const monitor of completed) {
      queueMonitorNotification(env, notify, monitor);
    }
  }

  if (rejected.length > 0) {
    console.error(`scheduled: ${rejected.length}/${settled.length} monitors failed`, rejected[0]);
  } else {
    console.log(`scheduled: processed ${settled.length} monitors at ${checkedAt}`);
  }

  ctx.waitUntil(queueHomepageRefresh());
}
