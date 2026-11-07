import { useMemo, useState } from 'react';
import type {
  CreateNotificationChannelInput,
  CustomWebhookChannelConfig,
  NotificationChannel,
  NotificationChannelPreset,
  TelegramChannelConfig,
  TelegramParseMode,
  WebhookChannelConfig,
} from '../api/types';
import { useI18n } from '../app/I18nContext';
import {
  Button,
  FIELD_HELP_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  SELECT_CLASS,
  TEXTAREA_CLASS,
  cn,
} from './ui';

interface NotificationChannelFormProps {
  channel?: NotificationChannel | undefined;
  onSubmit: (data: CreateNotificationChannelInput) => void;
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | undefined;
  monitors?: Array<{ id: number; name: string }> | undefined;
}

const inputClass = INPUT_CLASS;
const selectClass = SELECT_CLASS;
const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;

type NotificationEventType = NonNullable<WebhookChannelConfig['enabled_events']>[number];
type WebhookMethod = NonNullable<CustomWebhookChannelConfig['method']>;
type WebhookPayloadType = NonNullable<CustomWebhookChannelConfig['payload_type']>;
type TelegramParseModeInput = '' | TelegramParseMode;
type TelegramTokenMode = 'token' | 'secret_ref';

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function isTelegramConfig(
  config: WebhookChannelConfig | undefined,
): config is TelegramChannelConfig {
  return config?.preset === 'telegram';
}

function hasAdvancedTelegramConfig(config: TelegramChannelConfig | undefined): boolean {
  if (!config) return false;

  return Boolean(
    config.bot_token_source === 'secret_ref' ||
    config.bot_token_secret_ref ||
    config.message_thread_id !== undefined ||
    config.timeout_ms !== undefined ||
    config.message_template ||
    (config.enabled_events && config.enabled_events.length > 0) ||
    config.parse_mode ||
    config.disable_notification ||
    config.protect_content,
  );
}

function toPreset(value: string): NotificationChannelPreset {
  return value === 'telegram' ? 'telegram' : 'custom';
}

function toMethod(value: string): WebhookMethod {
  switch (value) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return value;
    default:
      return 'POST';
  }
}

function toPayloadType(value: string): WebhookPayloadType {
  switch (value) {
    case 'json':
    case 'param':
    case 'x-www-form-urlencoded':
      return value;
    default:
      return 'json';
  }
}

function toTelegramParseMode(value: string): TelegramParseModeInput {
  switch (value) {
    case 'Markdown':
    case 'MarkdownV2':
    case 'HTML':
      return value;
    default:
      return '';
  }
}

export function NotificationChannelForm({
  channel,
  onSubmit,
  onCancel,
  isLoading,
  error,
  monitors = [],
}: NotificationChannelFormProps) {
  const { t } = useI18n();
  const initialConfig = channel?.config_json;
  const initialIsTelegram = isTelegramConfig(initialConfig);
  const customConfig = initialIsTelegram
    ? undefined
    : (initialConfig as CustomWebhookChannelConfig | undefined);
  const telegramConfig = initialIsTelegram
    ? (initialConfig as TelegramChannelConfig | undefined)
    : undefined;

  const [name, setName] = useState(channel?.name ?? '');
  const [preset, setPreset] = useState<NotificationChannelPreset>(
    initialIsTelegram ? 'telegram' : 'custom',
  );
  const [url, setUrl] = useState(customConfig?.url ?? '');
  const [method, setMethod] = useState<WebhookMethod>(customConfig?.method ?? 'POST');

  const [timeoutMs, setTimeoutMs] = useState<number>(initialConfig?.timeout_ms ?? 5000);
  const [payloadType, setPayloadType] = useState<WebhookPayloadType>(
    customConfig?.payload_type ?? 'json',
  );

  const [headersJson, setHeadersJson] = useState(safeJsonStringify(customConfig?.headers ?? {}));

  const [messageTemplate, setMessageTemplate] = useState(initialConfig?.message_template ?? '');
  const [payloadTemplateJson, setPayloadTemplateJson] = useState(
    customConfig?.payload_template !== undefined
      ? safeJsonStringify(customConfig.payload_template)
      : '',
  );

  const [enabledEvents, setEnabledEvents] = useState<NotificationEventType[]>(
    initialConfig?.enabled_events ?? [],
  );
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>(
    initialConfig?.monitor_ids ?? [],
  );

  const [signingEnabled, setSigningEnabled] = useState<boolean>(
    customConfig?.signing?.enabled ?? false,
  );
  const [signingSecretRef, setSigningSecretRef] = useState<string>(
    customConfig?.signing?.secret_ref ?? '',
  );

  const [showAdvancedTelegram, setShowAdvancedTelegram] = useState<boolean>(() =>
    hasAdvancedTelegramConfig(telegramConfig),
  );
  const [telegramTokenMode, setTelegramTokenMode] = useState<TelegramTokenMode>(
    telegramConfig?.bot_token_source === 'secret_ref' || telegramConfig?.bot_token_secret_ref
      ? 'secret_ref'
      : 'token',
  );
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramBotTokenSecretRef, setTelegramBotTokenSecretRef] = useState(
    telegramConfig?.bot_token_secret_ref ?? 'UPTIMER_TELEGRAM_BOT_TOKEN',
  );
  const [telegramChatId, setTelegramChatId] = useState(telegramConfig?.chat_id ?? '');
  const [telegramMessageThreadId, setTelegramMessageThreadId] = useState(
    telegramConfig?.message_thread_id !== undefined ? String(telegramConfig.message_thread_id) : '',
  );
  const [telegramParseMode, setTelegramParseMode] = useState<TelegramParseModeInput>(
    telegramConfig?.parse_mode ?? '',
  );
  const [telegramDisableNotification, setTelegramDisableNotification] = useState<boolean>(
    telegramConfig?.disable_notification ?? false,
  );
  const [telegramProtectContent, setTelegramProtectContent] = useState<boolean>(
    telegramConfig?.protect_content ?? false,
  );

  const headersParse = useMemo(() => {
    if (preset === 'telegram') return { ok: true as const, value: {} as Record<string, string> };

    const trimmed = headersJson.trim();
    if (!trimmed) return { ok: true as const, value: {} as Record<string, string> };

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false as const, error: t('notification_form.error_headers_invalid_json') };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: t('notification_form.error_headers_must_object'),
      };
    }

    for (const [k, vv] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof vv !== 'string') {
        return {
          ok: false as const,
          error: t('notification_form.error_header_value_string', { key: k }),
        };
      }
    }

    return { ok: true as const, value: parsed as Record<string, string> };
  }, [headersJson, preset, t]);

  const payloadTemplateParse = useMemo(() => {
    if (preset === 'telegram') {
      return { ok: true as const, value: undefined as unknown };
    }

    const trimmed = payloadTemplateJson.trim();
    if (!trimmed) return { ok: true as const, value: undefined as unknown };

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return {
        ok: false as const,
        error: t('notification_form.error_payload_template_invalid_json'),
      };
    }

    return { ok: true as const, value: parsed };
  }, [payloadTemplateJson, preset, t]);

  const telegramHasStoredToken = Boolean(
    telegramConfig?.bot_token_configured ||
    telegramConfig?.bot_token_secret_ref ||
    telegramConfig?.bot_token_source,
  );
  const telegramUsesSecretRef = showAdvancedTelegram && telegramTokenMode === 'secret_ref';
  const telegramHasUsableToken = telegramUsesSecretRef
    ? telegramBotTokenSecretRef.trim().length > 0
    : telegramBotToken.trim().length > 0 || Boolean(channel && telegramHasStoredToken);
  const canSubmit =
    headersParse.ok &&
    payloadTemplateParse.ok &&
    (preset !== 'telegram' || (telegramChatId.trim().length > 0 && telegramHasUsableToken));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    if (preset === 'telegram') {
      const config: TelegramChannelConfig = {
        preset: 'telegram',
        chat_id: telegramChatId.trim(),
      };

      if (telegramUsesSecretRef) {
        config.bot_token_secret_ref = telegramBotTokenSecretRef.trim();
      } else if (telegramBotToken.trim()) {
        config.bot_token = telegramBotToken.trim();
      }
      if (showAdvancedTelegram) {
        if (telegramMessageThreadId.trim()) {
          const parsed = Number(telegramMessageThreadId);
          if (Number.isInteger(parsed) && parsed > 0) {
            config.message_thread_id = parsed;
          }
        }
        if (timeoutMs) {
          config.timeout_ms = timeoutMs;
        }
        if (messageTemplate.trim()) {
          config.message_template = messageTemplate;
        }
        if (enabledEvents.length > 0) {
          config.enabled_events = enabledEvents;
        }
        if (telegramParseMode) {
          config.parse_mode = telegramParseMode;
        }
        if (telegramDisableNotification) {
          config.disable_notification = true;
        }
        if (telegramProtectContent) {
          config.protect_content = true;
        }
      }

      if (selectedMonitorIds.length > 0) {
        config.monitor_ids = selectedMonitorIds;
      }

      onSubmit({ name, type: 'webhook', config_json: config });
      return;
    }

    const config: CustomWebhookChannelConfig = {
      preset: 'custom',
      url,
      method,
      timeout_ms: timeoutMs,
      payload_type: payloadType,
    };

    if (headersParse.ok && Object.keys(headersParse.value).length > 0) {
      config.headers = headersParse.value;
    }

    if (messageTemplate.trim()) {
      config.message_template = messageTemplate;
    }

    if (payloadTemplateParse.ok && payloadTemplateParse.value !== undefined) {
      config.payload_template = payloadTemplateParse.value;
    }

    if (enabledEvents.length > 0) {
      config.enabled_events = enabledEvents;
    }

    if (signingEnabled) {
      config.signing = { enabled: true, secret_ref: signingSecretRef };
    }
    if (selectedMonitorIds.length > 0) {
      config.monitor_ids = selectedMonitorIds;
    }

    onSubmit({ name, type: 'webhook', config_json: config });
  };

  const toggleEnabledEvent = (ev: NotificationEventType) => {
    setEnabledEvents((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));
  };

  const handlePresetChange = (next: NotificationChannelPreset) => {
    setPreset(next);
    if (!channel && !name.trim()) {
      setName(next === 'telegram' ? 'Telegram' : 'Webhook');
    }
  };

  const allEvents: NotificationEventType[] = [
    'monitor.down',
    'monitor.up',
    'incident.created',
    'incident.updated',
    'incident.resolved',
    'maintenance.started',
    'maintenance.ended',
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      <div>
        <label className={labelClass}>{t('notification_form.name')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          required
        />
      </div>

      <div>
        <label className={labelClass}>{t('notification_form.preset')}</label>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800/60">
          {(['custom', 'telegram'] as const).map((item) => {
            const active = preset === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => handlePresetChange(toPreset(item))}
                className={cn(
                  'h-9 rounded-md px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                )}
              >
                {item === 'telegram'
                  ? t('notification_form.preset_telegram')
                  : t('notification_form.preset_custom')}
              </button>
            );
          })}
        </div>
        <div className={FIELD_HELP_CLASS}>
          {preset === 'telegram'
            ? t('notification_form.preset_telegram_help')
            : t('notification_form.preset_custom_help')}
        </div>
      </div>

      {preset === 'custom' ? (
        <>
          <div>
            <label className={labelClass}>{t('notification_form.webhook_url')}</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('notification_form.webhook_url_placeholder')}
              className={inputClass}
              required
            />
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.method')}</label>
            <select
              value={method}
              onChange={(e) => setMethod(toMethod(e.target.value))}
              className={selectClass}
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.payload_type')}</label>
            <select
              value={payloadType}
              onChange={(e) => setPayloadType(toPayloadType(e.target.value))}
              className={selectClass}
            >
              <option value="json">{t('notification_form.payload_type_json')}</option>
              <option value="param">{t('notification_form.payload_type_query')}</option>
              <option value="x-www-form-urlencoded">
                {t('notification_form.payload_type_urlencoded')}
              </option>
            </select>
            <div className={FIELD_HELP_CLASS}>{t('notification_form.payload_type_help')}</div>
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.headers_json')}</label>
            <textarea
              value={headersJson}
              onChange={(e) => setHeadersJson(e.target.value)}
              className={textareaClass}
              rows={4}
              placeholder={t('notification_form.headers_placeholder')}
            />
            {!headersParse.ok && (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                {headersParse.error}
              </div>
            )}
            <div className={FIELD_HELP_CLASS}>{t('notification_form.headers_help')}</div>
          </div>
        </>
      ) : (
        <>
          {!telegramUsesSecretRef && (
            <div>
              <label className={labelClass}>{t('notification_form.telegram_bot_token')}</label>
              <input
                type="password"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                className={inputClass}
                placeholder={t('notification_form.telegram_bot_token_placeholder')}
                required={!channel || !telegramHasStoredToken}
              />
              <div className={FIELD_HELP_CLASS}>
                {channel && telegramHasStoredToken
                  ? t('notification_form.telegram_bot_token_keep_help')
                  : t('notification_form.telegram_bot_token_help')}
              </div>
            </div>
          )}

          <div>
            <label className={labelClass}>{t('notification_form.telegram_chat_id')}</label>
            <input
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              className={inputClass}
              placeholder={t('notification_form.telegram_chat_id_placeholder')}
              required
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={showAdvancedTelegram}
              onChange={(e) => setShowAdvancedTelegram(e.target.checked)}
            />
            <span>{t('notification_form.advanced_options')}</span>
          </label>

          {showAdvancedTelegram && (
            <div className="space-y-4 border-t border-slate-200 dark:border-slate-700 pt-4">
              <div>
                <label className={labelClass}>{t('notification_form.telegram_token_source')}</label>
                <select
                  value={telegramTokenMode}
                  onChange={(e) => setTelegramTokenMode(e.target.value as TelegramTokenMode)}
                  className={selectClass}
                >
                  <option value="token">
                    {t('notification_form.telegram_token_source_encrypted')}
                  </option>
                  <option value="secret_ref">
                    {t('notification_form.telegram_token_source_secret_ref')}
                  </option>
                </select>
                <div className={FIELD_HELP_CLASS}>
                  {t('notification_form.telegram_token_source_help')}
                </div>
              </div>

              {telegramUsesSecretRef ? (
                <div>
                  <label className={labelClass}>
                    {t('notification_form.telegram_bot_token_secret_ref')}
                  </label>
                  <input
                    type="text"
                    value={telegramBotTokenSecretRef}
                    onChange={(e) => setTelegramBotTokenSecretRef(e.target.value)}
                    className={inputClass}
                    placeholder={t('notification_form.telegram_bot_token_secret_ref_placeholder')}
                    required
                  />
                  <div className={FIELD_HELP_CLASS}>
                    {t('notification_form.telegram_bot_token_secret_ref_help')}
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>{t('notification_form.telegram_parse_mode')}</label>
                  <select
                    value={telegramParseMode}
                    onChange={(e) => setTelegramParseMode(toTelegramParseMode(e.target.value))}
                    className={selectClass}
                  >
                    <option value="">{t('notification_form.telegram_parse_mode_none')}</option>
                    <option value="MarkdownV2">MarkdownV2</option>
                    <option value="HTML">HTML</option>
                    <option value="Markdown">Markdown</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>
                    {t('notification_form.telegram_message_thread_id_optional')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={telegramMessageThreadId}
                    onChange={(e) => setTelegramMessageThreadId(e.target.value)}
                    className={inputClass}
                    placeholder={t('notification_form.telegram_message_thread_id_placeholder')}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>{t('notification_form.timeout_ms')}</label>
                <input
                  type="number"
                  min={1}
                  max={60000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>
                  {t('notification_form.message_template_optional')}
                </label>
                <textarea
                  value={messageTemplate}
                  onChange={(e) => setMessageTemplate(e.target.value)}
                  className={textareaClass}
                  rows={3}
                  placeholder={t('notification_form.message_template_placeholder')}
                />
                <div className={FIELD_HELP_CLASS}>
                  {t('notification_form.message_template_help')}
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  {t('notification_form.enabled_events_optional')}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {allEvents.map((ev) => (
                    <label
                      key={ev}
                      className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                    >
                      <input
                        type="checkbox"
                        checked={enabledEvents.includes(ev)}
                        onChange={() => toggleEnabledEvent(ev)}
                      />
                      <span>{ev}</span>
                    </label>
                  ))}
                </div>
                <div className={FIELD_HELP_CLASS}>{t('notification_form.enabled_events_help')}</div>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={telegramDisableNotification}
                    onChange={(e) => setTelegramDisableNotification(e.target.checked)}
                  />
                  <span>{t('notification_form.telegram_disable_notification')}</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={telegramProtectContent}
                    onChange={(e) => setTelegramProtectContent(e.target.checked)}
                  />
                  <span>{t('notification_form.telegram_protect_content')}</span>
                </label>
              </div>
            </div>
          )}
        </>
      )}

      {preset === 'custom' && (
        <>
          <div>
            <label className={labelClass}>{t('notification_form.timeout_ms')}</label>
            <input
              type="number"
              min={1}
              max={60000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.message_template_optional')}</label>
            <textarea
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              className={textareaClass}
              rows={3}
              placeholder={t('notification_form.message_template_placeholder')}
            />
            <div className={FIELD_HELP_CLASS}>{t('notification_form.message_template_help')}</div>
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.payload_template_optional')}</label>
            <textarea
              value={payloadTemplateJson}
              onChange={(e) => setPayloadTemplateJson(e.target.value)}
              className={textareaClass}
              rows={8}
              placeholder={
                payloadType === 'json'
                  ? t('notification_form.payload_template_placeholder_json')
                  : t('notification_form.payload_template_placeholder_flat')
              }
            />
            {!payloadTemplateParse.ok && (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                {payloadTemplateParse.error}
              </div>
            )}
            <div className={FIELD_HELP_CLASS}>{t('notification_form.payload_template_help')}</div>
          </div>

          <div>
            <label className={labelClass}>{t('notification_form.enabled_events_optional')}</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allEvents.map((ev) => (
                <label
                  key={ev}
                  className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                >
                  <input
                    type="checkbox"
                    checked={enabledEvents.includes(ev)}
                    onChange={() => toggleEnabledEvent(ev)}
                  />
                  <span>{ev}</span>
                </label>
              ))}
            </div>
            <div className={FIELD_HELP_CLASS}>{t('notification_form.enabled_events_help')}</div>
          </div>
        </>
      )}

      {preset === 'custom' && (
        <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={signingEnabled}
              onChange={(e) => setSigningEnabled(e.target.checked)}
            />
            <span>{t('notification_form.signing_enable')}</span>
          </label>
          {signingEnabled && (
            <div className="mt-3">
              <label className={labelClass}>{t('notification_form.signing_secret_ref')}</label>
              <input
                type="text"
                value={signingSecretRef}
                onChange={(e) => setSigningSecretRef(e.target.value)}
                className={inputClass}
                placeholder={t('notification_form.signing_secret_ref_placeholder')}
                required
              />
            </div>
          )}
        </div>
      )}

      <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
        <label className={labelClass}>{t('notification_form.monitor_scope')}</label>
        <div className={FIELD_HELP_CLASS}>{t('notification_form.monitor_scope_help')}</div>
        {monitors.length > 0 ? (
          <div className="mt-2 max-h-44 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            {monitors.map((monitor) => (
              <label
                key={monitor.id}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={selectedMonitorIds.includes(monitor.id)}
                  onChange={() =>
                    setSelectedMonitorIds((prev) =>
                      prev.includes(monitor.id)
                        ? prev.filter((id) => id !== monitor.id)
                        : [...prev, monitor.id],
                    )
                  }
                />
                <span>{monitor.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {t('notification_form.monitor_scope_empty')}
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={isLoading || !canSubmit} className="flex-1">
          {isLoading ? t('common.saving') : channel ? t('common.update') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}
