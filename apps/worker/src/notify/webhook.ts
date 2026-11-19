import pLimit from 'p-limit';

import type {
  CustomWebhookChannelConfig,
  TelegramChannelConfig,
  WpushChannelConfig,
  WebhookChannelConfig,
} from '@uptimer/db';

import { claimNotificationDelivery, finalizeNotificationDelivery } from './dedupe';
import { decryptTelegramBotToken } from './telegram-token';
import { decryptWpushApiKey } from './wpush-token';
import { defaultMessageForEvent, renderJsonTemplate, renderStringTemplate } from './template';

export type WebhookChannel = {
  id: number;
  name: string;
  config: WebhookChannelConfig;
};

export type WebhookDispatchResult = {
  status: 'success' | 'failed';
  httpStatus: number | null;
  error: string | null;
};

const DEFAULT_TIMEOUT_MS = 5000;
const WEBHOOK_CONCURRENCY = 5;
const TELEGRAM_TEXT_MAX_LENGTH = 4096;

function isAbortError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err) {
    return (err as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

function readEnvSecret(env: Record<string, unknown>, ref: string): string | null {
  const v = env[ref];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readAdminToken(env: Record<string, unknown>): string | null {
  const token = readEnvSecret(env, 'ADMIN_TOKEN');
  return token;
}

function isTelegramChannelConfig(config: WebhookChannelConfig): config is TelegramChannelConfig {
  return config.preset === 'telegram';
}

function isWpushChannelConfig(config: WebhookChannelConfig): config is WpushChannelConfig {
  return config.preset === 'wpush';
}

function shouldSendEvent(config: WebhookChannelConfig, eventType: string): boolean {
  // Always allow test sends so users can validate channel config.
  if (eventType === 'test.ping') return true;

  const enabled = config.enabled_events;
  if (!enabled || enabled.length === 0) return true;
  return enabled.includes(eventType as never);
}

function coerceFlatParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
      continue;
    }

    // Fallback: encode as JSON.
    try {
      out[k] = JSON.stringify(v);
    } catch {
      out[k] = String(v);
    }
  }

  return out;
}

function appendQueryParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.append(k, v);
  }
  return u.toString();
}

function buildTemplateContext(args: {
  channel: WebhookChannel;
  eventType: string;
  eventKey: string;
  payload: unknown;
  now: number;
}): { vars: Record<string, unknown>; message: string; defaultMessage: string } {
  const rawPayloadForVars = args.payload;
  const payloadRecord =
    rawPayloadForVars && typeof rawPayloadForVars === 'object' && !Array.isArray(rawPayloadForVars)
      ? (rawPayloadForVars as Record<string, unknown>)
      : {};

  const baseVars: Record<string, unknown> = {
    ...payloadRecord,
    payload: rawPayloadForVars,
    channel: { id: args.channel.id, name: args.channel.name },
    event: args.eventType,
    event_id: args.eventKey,
    timestamp: args.now,
  };

  const defaultMessage = defaultMessageForEvent(args.eventType, baseVars);

  const message = args.channel.config.message_template
    ? renderStringTemplate(args.channel.config.message_template, {
        ...baseVars,
        message: defaultMessage,
        default_message: defaultMessage,
      })
    : defaultMessage;

  const vars: Record<string, unknown> = {
    ...baseVars,
    message,
    default_message: defaultMessage,
  };

  return { vars, message, defaultMessage };
}

function buildWebhookTemplatePayload(args: {
  channel: WebhookChannel & { config: CustomWebhookChannelConfig };
  eventType: string;
  eventKey: string;
  payload: unknown;
  now: number;
}): { vars: Record<string, unknown>; payload: unknown } {
  const { vars, message } = buildTemplateContext(args);

  let payload: unknown;
  if (args.channel.config.payload_template !== undefined) {
    payload = renderJsonTemplate(args.channel.config.payload_template, vars);
  } else if (args.channel.config.payload_type === 'json') {
    // Default behavior: keep the original payload structure for existing setups.
    payload = args.payload;
  } else {
    // For non-JSON payload types, default to a minimal flat payload.
    payload = {
      event: args.eventType,
      event_id: args.eventKey,
      timestamp: args.now,
      message,
    };
  }

  return { vars, payload };
}

function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_TEXT_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_TEXT_MAX_LENGTH - 3)}...`;
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function describeTelegramFailure(parsed: Record<string, unknown> | null, fallback: string): string {
  if (!parsed) return fallback;

  const description = typeof parsed.description === 'string' ? parsed.description : null;
  const errorCode = typeof parsed.error_code === 'number' ? parsed.error_code : null;
  const parameters =
    parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
      ? (parsed.parameters as Record<string, unknown>)
      : null;
  const retryAfter =
    parameters && typeof parameters.retry_after === 'number' ? parameters.retry_after : null;

  const base =
    description && errorCode !== null
      ? `Telegram ${errorCode}: ${description}`
      : (description ?? fallback);

  return retryAfter === null ? base : `${base} (retry_after=${retryAfter}s)`;
}

async function dispatchCustomWebhookRequest(args: {
  env: Record<string, unknown>;
  channel: WebhookChannel & { config: CustomWebhookChannelConfig };
  eventType: string;
  eventKey: string;
  payload: unknown;
  now: number;
}): Promise<WebhookDispatchResult> {
  const config = args.channel.config;
  const method = config.method.toUpperCase();
  const canHaveBody = method !== 'GET' && method !== 'HEAD';

  const { vars, payload } = buildWebhookTemplatePayload({
    channel: args.channel,
    eventType: args.eventType,
    eventKey: args.eventKey,
    payload: args.payload,
    now: args.now,
  });

  // Allow magic vars in header values.
  const headers = new Headers();
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    headers.set(k, renderStringTemplate(v, vars));
  }

  let url = config.url;
  let rawBody = '';

  switch (config.payload_type) {
    case 'param': {
      const params = coerceFlatParams(payload);
      url = appendQueryParams(url, params);
      break;
    }
    case 'x-www-form-urlencoded': {
      const params = coerceFlatParams(payload);
      if (canHaveBody) {
        rawBody = new URLSearchParams(params).toString();
        if (!headers.has('content-type')) {
          headers.set('Content-Type', 'application/x-www-form-urlencoded');
        }
      } else {
        // Cannot send a body (GET/HEAD). Fall back to query params.
        url = appendQueryParams(url, params);
      }
      break;
    }
    case 'json':
    default: {
      if (canHaveBody) {
        rawBody = JSON.stringify(payload === undefined ? null : payload);
        if (!headers.has('content-type')) {
          // Some webhook receivers (e.g. Apprise wrappers) strictly require an exact content-type value.
          headers.set('Content-Type', 'application/json');
        }
      }
      break;
    }
  }

  if (config.signing?.enabled) {
    const secret = readEnvSecret(args.env, config.signing.secret_ref);
    if (!secret) {
      return {
        status: 'failed',
        httpStatus: null,
        error: `Signing secret not configured: ${config.signing.secret_ref}`,
      };
    }

    const timestamp = args.now;
    const sig = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
    headers.set('X-Uptimer-Timestamp', String(timestamp));
    headers.set('X-Uptimer-Signature', `sha256=${sig}`);
  }

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      cache: 'no-store',
    };

    if (canHaveBody && rawBody) {
      init.body = rawBody;
    }

    const res = await fetch(url, init);
    res.body?.cancel();

    return res.ok
      ? { status: 'success', httpStatus: res.status, error: null }
      : { status: 'failed', httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: 'failed',
      httpStatus: null,
      error: isAbortError(err) ? `Timeout after ${timeoutMs}ms` : toErrorMessage(err),
    };
  } finally {
    clearTimeout(t);
  }
}

async function dispatchTelegramPresetRequest(args: {
  env: Record<string, unknown>;
  channel: WebhookChannel & { config: TelegramChannelConfig };
  eventType: string;
  eventKey: string;
  payload: unknown;
  now: number;
}): Promise<WebhookDispatchResult> {
  const config = args.channel.config;
  let token: string | null = null;

  if (config.bot_token_encrypted) {
    const adminToken = readAdminToken(args.env);
    if (!adminToken) {
      return {
        status: 'failed',
        httpStatus: null,
        error: 'Telegram bot token is encrypted but ADMIN_TOKEN is not configured',
      };
    }

    try {
      token = await decryptTelegramBotToken(adminToken, config.bot_token_encrypted);
    } catch {
      return {
        status: 'failed',
        httpStatus: null,
        error: 'Telegram bot token could not be decrypted',
      };
    }
  } else if (config.bot_token_secret_ref) {
    token = readEnvSecret(args.env, config.bot_token_secret_ref);
  }

  if (!token) {
    const ref = config.bot_token_secret_ref ?? 'bot_token_encrypted';
    return {
      status: 'failed',
      httpStatus: null,
      error: `Telegram bot token not configured: ${ref}`,
    };
  }

  const { message, defaultMessage } = buildTemplateContext({
    channel: args.channel,
    eventType: args.eventType,
    eventKey: args.eventKey,
    payload: args.payload,
    now: args.now,
  });

  const text = truncateTelegramText(message.trim().length > 0 ? message : defaultMessage);
  const body: Record<string, unknown> = {
    chat_id: config.chat_id,
    text,
  };

  if (config.message_thread_id !== undefined) {
    body.message_thread_id = config.message_thread_id;
  }
  if (config.parse_mode) {
    body.parse_mode = config.parse_mode;
  }
  if (config.disable_notification !== undefined) {
    body.disable_notification = config.disable_notification;
  }
  if (config.protect_content !== undefined) {
    body.protect_content = config.protect_content;
  }

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const responseText = await res.text().catch(() => '');
    const parsed = parseJsonObject(responseText);

    if (res.ok && parsed?.ok === true) {
      return { status: 'success', httpStatus: res.status, error: null };
    }

    const fallback = res.ok
      ? 'Telegram API response did not include ok=true'
      : `HTTP ${res.status}`;
    return {
      status: 'failed',
      httpStatus: res.status,
      error: describeTelegramFailure(parsed, fallback),
    };
  } catch (err) {
    const error = isAbortError(err) ? `Timeout after ${timeoutMs}ms` : toErrorMessage(err);
    return {
      status: 'failed',
      httpStatus: null,
      error: redactSecret(error, token),
    };
  } finally {
    clearTimeout(t);
  }
}

function defaultWpushTitle(eventType: string): string {
  switch (eventType) {
    case 'monitor.down':
      return 'Uptimer · 服务异常';
    case 'monitor.up':
      return 'Uptimer · 服务恢复';
    case 'incident.created':
    case 'incident.updated':
      return 'Uptimer · Incident 更新';
    case 'incident.resolved':
      return 'Uptimer · Incident 已解决';
    case 'maintenance.started':
      return 'Uptimer · 维护开始';
    case 'maintenance.ended':
      return 'Uptimer · 维护结束';
    case 'test.ping':
      return 'Uptimer · 测试通知';
    default:
      return 'Uptimer 通知';
  }
}

async function dispatchWpushPresetRequest(args: {
  env: Record<string, unknown>;
  channel: WebhookChannel & { config: WpushChannelConfig };
  eventType: string;
  eventKey: string;
  payload: unknown;
  now: number;
}): Promise<WebhookDispatchResult> {
  const config = args.channel.config;
  let apiKey: string | null = null;

  if (config.api_key_encrypted) {
    const adminToken = readAdminToken(args.env);
    if (!adminToken) {
      return {
        status: 'failed',
        httpStatus: null,
        error: 'WPush API key is encrypted but ADMIN_TOKEN is not configured',
      };
    }
    try {
      apiKey = await decryptWpushApiKey(adminToken, config.api_key_encrypted);
    } catch {
      return {
        status: 'failed',
        httpStatus: null,
        error: 'WPush API key could not be decrypted',
      };
    }
  } else if (config.api_key_secret_ref) {
    apiKey = readEnvSecret(args.env, config.api_key_secret_ref);
  }

  if (!apiKey) {
    const ref = config.api_key_secret_ref ?? 'api_key_encrypted';
    return {
      status: 'failed',
      httpStatus: null,
      error: `WPush API key not configured: ${ref}`,
    };
  }

  const { vars, message, defaultMessage } = buildTemplateContext({
    channel: args.channel,
    eventType: args.eventType,
    eventKey: args.eventKey,
    payload: args.payload,
    now: args.now,
  });

  const title = (
    config.title_template
      ? renderStringTemplate(config.title_template, vars)
      : defaultWpushTitle(args.eventType)
  )
    .trim()
    .slice(0, 255);
  const content = (message.trim().length > 0 ? message : defaultMessage).slice(0, 10_000);

  const form = new URLSearchParams({
    apikey: apiKey,
    title: title || 'Uptimer 通知',
    content,
    channel: config.channel || 'wechat',
  });
  if (config.option) form.set('option', config.option);
  if (config.url) form.set('url', config.url);

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.wpush.cn/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      signal: controller.signal,
      cache: 'no-store',
    });
    const responseText = await res.text().catch(() => '');
    const parsed = parseJsonObject(responseText);
    const code = typeof parsed?.code === 'number' ? parsed.code : null;
    const success = parsed?.success === true || code === 0;
    if (res.ok && success) {
      return { status: 'success', httpStatus: res.status, error: null };
    }

    const messageText =
      typeof parsed?.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : `HTTP ${res.status}`;
    return {
      status: 'failed',
      httpStatus: res.status,
      error: code === null ? `WPush: ${messageText}` : `WPush ${code}: ${messageText}`,
    };
  } catch (err) {
    const error = isAbortError(err) ? `Timeout after ${timeoutMs}ms` : toErrorMessage(err);
    return {
      status: 'failed',
      httpStatus: null,
      error: redactSecret(error, apiKey),
    };
  } finally {
    clearTimeout(t);
  }
}

export async function dispatchWebhookToChannel(args: {
  db: D1Database;
  env: Record<string, unknown>;
  channel: WebhookChannel;
  eventType: string;
  eventKey: string;
  payload: unknown;
}): Promise<'sent' | 'skipped'> {
  if (!shouldSendEvent(args.channel.config, args.eventType)) {
    return 'skipped';
  }

  const now = Math.floor(Date.now() / 1000);
  const claimed = await claimNotificationDelivery(args.db, args.eventKey, args.channel.id, now);
  if (!claimed) {
    return 'skipped';
  }

  const config = args.channel.config;

  let outcome: WebhookDispatchResult;
  try {
    outcome = isTelegramChannelConfig(config)
      ? await dispatchTelegramPresetRequest({
          env: args.env,
          channel: { ...args.channel, config },
          eventType: args.eventType,
          eventKey: args.eventKey,
          payload: args.payload,
          now,
        })
      : isWpushChannelConfig(config)
        ? await dispatchWpushPresetRequest({
            env: args.env,
            channel: { ...args.channel, config },
            eventType: args.eventType,
            eventKey: args.eventKey,
            payload: args.payload,
            now,
          })
        : await dispatchCustomWebhookRequest({
          env: args.env,
          channel: { ...args.channel, config },
          eventType: args.eventType,
          eventKey: args.eventKey,
          payload: args.payload,
          now,
        });
  } catch (err) {
    outcome = { status: 'failed', httpStatus: null, error: toErrorMessage(err) };
  }

  await finalizeNotificationDelivery(args.db, args.eventKey, args.channel.id, outcome);
  return 'sent';
}

// Backward compatible wrapper.
export async function dispatchWebhookToChannelLegacy(args: {
  db: D1Database;
  env: Record<string, unknown>;
  channel: WebhookChannel;
  eventKey: string;
  payload: unknown;
}): Promise<'sent' | 'skipped'> {
  const eventType =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? (args.payload as { event?: unknown }).event
      : undefined;

  return dispatchWebhookToChannel({
    db: args.db,
    env: args.env,
    channel: args.channel,
    eventType: typeof eventType === 'string' ? eventType : 'unknown',
    eventKey: args.eventKey,
    payload: args.payload,
  });
}

export async function dispatchWebhookToChannels(args: {
  db: D1Database;
  env: Record<string, unknown>;
  channels: WebhookChannel[];
  eventType: string;
  eventKey: string;
  payload: unknown;
}): Promise<void> {
  const channels = args.channels.filter((c) => shouldSendEvent(c.config, args.eventType));
  if (channels.length === 0) return;

  const limit = pLimit(WEBHOOK_CONCURRENCY);
  const settled = await Promise.allSettled(
    channels.map((channel) =>
      limit(() =>
        dispatchWebhookToChannel({
          db: args.db,
          env: args.env,
          channel,
          eventType: args.eventType,
          eventKey: args.eventKey,
          payload: args.payload,
        }).catch((err) => Promise.reject({ channel, err })),
      ),
    ),
  );

  const rejected = settled.filter((r) => r.status === 'rejected');
  if (rejected.length > 0) {
    console.error(`notify: ${rejected.length}/${settled.length} webhooks failed`, rejected[0]);
  }
}

// Backward compatible wrapper.
export async function dispatchWebhookToChannelsLegacy(args: {
  db: D1Database;
  env: Record<string, unknown>;
  channels: WebhookChannel[];
  eventKey: string;
  payload: unknown;
}): Promise<void> {
  const eventType =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? (args.payload as { event?: unknown }).event
      : undefined;

  return dispatchWebhookToChannels({
    db: args.db,
    env: args.env,
    channels: args.channels,
    eventType: typeof eventType === 'string' ? eventType : 'unknown',
    eventKey: args.eventKey,
    payload: args.payload,
  });
}
