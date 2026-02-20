import { useMemo, useState } from 'react';

import type {
  AdminMonitor,
  CreateMonitorInput,
  MonitorType,
  PatchMonitorInput,
} from '../api/types';
import { useI18n } from '../app/I18nContext';
import {
  Button,
  FIELD_HELP_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from './ui';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

type CommonProps = {
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | undefined;
  groupOptions?: string[];
};

type CreateProps = CommonProps & {
  monitor?: undefined;
  onSubmit: (data: CreateMonitorInput) => void;
};

type EditProps = CommonProps & {
  monitor: AdminMonitor;
  onSubmit: (data: PatchMonitorInput) => void;
};

const inputClass = INPUT_CLASS;
const selectClass = SELECT_CLASS;
const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;
type TranslateFn = ReturnType<typeof useI18n>['t'];

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function toHttpMethod(value: string): HttpMethod {
  switch (value) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return value;
    default:
      return 'GET';
  }
}

function hasAdvancedHttpConfig(monitor: AdminMonitor | undefined): boolean {
  if (!monitor || monitor.type !== 'http') return false;

  const hasHeaders =
    !!monitor.http_headers_json && Object.keys(monitor.http_headers_json).length > 0;
  const hasExpected = !!monitor.expected_status_json && monitor.expected_status_json.length > 0;
  const hasBody = !!monitor.http_body && monitor.http_body.trim().length > 0;
  const hasKw = !!monitor.response_keyword && monitor.response_keyword.trim().length > 0;
  const hasForbiddenKw =
    !!monitor.response_forbidden_keyword && monitor.response_forbidden_keyword.trim().length > 0;

  return hasHeaders || hasExpected || hasBody || hasKw || hasForbiddenKw;
}

function parseHeadersJson(
  text: string,
  t: TranslateFn,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true as const, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return {
      ok: false as const,
      error: t('monitor_form.error_headers_invalid_json'),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false as const, error: t('monitor_form.error_headers_must_object') };
  }

  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return { ok: false as const, error: t('monitor_form.error_header_value_string', { key: k }) };
    }
  }

  return { ok: true as const, value: parsed as Record<string, string> };
}

function parseExpectedStatusInput(
  text: string,
  t: TranslateFn,
): { ok: true; value: number[] | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true as const, value: null };

  const parseList = (parts: string[]) => {
    if (parts.length === 0) {
      return { ok: false as const, error: t('monitor_form.error_expected_status_empty') };
    }

    const out: number[] = [];
    for (const p of parts) {
      const n = Number.parseInt(p, 10);
      if (!Number.isFinite(n) || n < 100 || n > 599) {
        return {
          ok: false as const,
          error: t('monitor_form.error_expected_status_invalid', { value: p }),
        };
      }
      out.push(n);
    }

    return { ok: true as const, value: out };
  };

  // Also accept JSON array input like: [200, 204]
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return {
        ok: false as const,
        error: t('monitor_form.error_expected_status_json_or_list'),
      };
    }

    if (!Array.isArray(parsed)) {
      return { ok: false as const, error: t('monitor_form.error_expected_status_must_array') };
    }

    const parts = parsed.map((x) => String(x));
    return parseList(parts);
  }

  const parts = trimmed
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return parseList(parts);
}

export function MonitorForm(props: CreateProps | EditProps) {
  const { t } = useI18n();
  const monitor = props.monitor;
  const groupOptions = useMemo(
    () =>
      [
        ...new Set(
          (props.groupOptions ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
        ),
      ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [props.groupOptions],
  );

  const [name, setName] = useState(monitor?.name ?? '');
  const [groupName, setGroupName] = useState(monitor?.group_name ?? '');
  const [groupSortOrder, setGroupSortOrder] = useState(monitor?.group_sort_order ?? 0);
  const [sortOrder, setSortOrder] = useState(monitor?.sort_order ?? 0);
  const [type, setType] = useState<MonitorType>(monitor?.type ?? 'http');
  const [target, setTarget] = useState(monitor?.target ?? '');
  const [intervalSec, setIntervalSec] = useState(monitor?.interval_sec ?? 60);
  const [timeoutMs, setTimeoutMs] = useState(monitor?.timeout_ms ?? 10000);

  const [httpMethod, setHttpMethod] = useState<HttpMethod>(
    toHttpMethod(monitor?.http_method ?? 'GET'),
  );

  const [showAdvancedHttp, setShowAdvancedHttp] = useState<boolean>(() =>
    hasAdvancedHttpConfig(monitor),
  );

  const [httpHeadersJson, setHttpHeadersJson] = useState(() => {
    if (!monitor || monitor.type !== 'http') return '';
    if (!monitor.http_headers_json || Object.keys(monitor.http_headers_json).length === 0)
      return '';
    return safeJsonStringify(monitor.http_headers_json);
  });

  const [expectedStatusInput, setExpectedStatusInput] = useState(() => {
    if (!monitor || monitor.type !== 'http') return '';
    if (!monitor.expected_status_json || monitor.expected_status_json.length === 0) return '';
    return monitor.expected_status_json.join(', ');
  });

  const [httpBody, setHttpBody] = useState(() =>
    monitor?.type === 'http' ? (monitor.http_body ?? '') : '',
  );
  const [responseKeyword, setResponseKeyword] = useState(() =>
    monitor?.type === 'http' ? (monitor.response_keyword ?? '') : '',
  );
  const [responseForbiddenKeyword, setResponseForbiddenKeyword] = useState(() =>
    monitor?.type === 'http' ? (monitor.response_forbidden_keyword ?? '') : '',
  );

  const headersParse = useMemo(() => parseHeadersJson(httpHeadersJson, t), [httpHeadersJson, t]);
  const expectedStatusParse = useMemo(
    () => parseExpectedStatusInput(expectedStatusInput, t),
    [expectedStatusInput, t],
  );

  const canSubmit =
    name.trim().length > 0 &&
    target.trim().length > 0 &&
    (type !== 'http' || !showAdvancedHttp || (headersParse.ok && expectedStatusParse.ok));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const normalizedGroupName = groupName.trim();
    const base = {
      name: name.trim(),
      target: target.trim(),
      group_sort_order: groupSortOrder,
      sort_order: sortOrder,
      interval_sec: intervalSec,
      timeout_ms: timeoutMs,
    };

    if (monitor) {
      const data: PatchMonitorInput = {
        ...base,
        group_name: normalizedGroupName.length > 0 ? normalizedGroupName : null,
      };

      if (type === 'http') {
        data.http_method = httpMethod;

        if (showAdvancedHttp) {
          if (headersParse.ok) {
            data.http_headers_json =
              Object.keys(headersParse.value).length > 0 ? headersParse.value : null;
          }

          if (expectedStatusParse.ok) {
            data.expected_status_json = expectedStatusParse.value;
          }

          data.http_body = httpBody.trim().length > 0 ? httpBody : null;
          data.response_keyword = responseKeyword.trim().length > 0 ? responseKeyword.trim() : null;
          data.response_forbidden_keyword =
            responseForbiddenKeyword.trim().length > 0 ? responseForbiddenKeyword.trim() : null;
        } else {
          // In edit mode, hiding advanced options means reset all persisted advanced HTTP settings.
          data.http_headers_json = null;
          data.expected_status_json = null;
          data.http_body = null;
          data.response_keyword = null;
          data.response_forbidden_keyword = null;
        }
      }

      props.onSubmit(data);
      return;
    }

    const data: CreateMonitorInput = { ...base, type };
    if (normalizedGroupName.length > 0) data.group_name = normalizedGroupName;

    if (type === 'http') {
      data.http_method = httpMethod;

      if (showAdvancedHttp) {
        if (headersParse.ok && Object.keys(headersParse.value).length > 0) {
          data.http_headers_json = headersParse.value;
        }

        if (expectedStatusParse.ok && expectedStatusParse.value !== null) {
          data.expected_status_json = expectedStatusParse.value;
        }

        if (httpBody.trim().length > 0) {
          data.http_body = httpBody;
        }

        if (responseKeyword.trim().length > 0) {
          data.response_keyword = responseKeyword.trim();
        }

        if (responseForbiddenKeyword.trim().length > 0) {
          data.response_forbidden_keyword = responseForbiddenKeyword.trim();
        }
      }
    }

    props.onSubmit(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {props.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {props.error}
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className={labelClass}>{t('monitor_form.name')}</label>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {monitor
              ? t('monitor_form.id_inline_edit', { id: `#${monitor.id}` })
              : t('monitor_form.id_inline_create')}
          </span>
        </div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          required
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t('monitor_form.group_optional')}</label>
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            className={inputClass}
            placeholder={t('monitor_form.group_placeholder')}
            list="monitor-group-options"
          />
          {groupOptions.length > 0 && (
            <datalist id="monitor-group-options">
              {groupOptions.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
          )}
        </div>
        <div>
          <label className={labelClass}>{t('monitor_form.group_order')}</label>
          <input
            type="number"
            value={groupSortOrder}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setGroupSortOrder(Number.isFinite(n) ? n : 0);
            }}
            min={-100000}
            max={100000}
            className={inputClass}
          />
          <div className={FIELD_HELP_CLASS}>{t('monitor_form.group_order_help')}</div>
        </div>
        <div>
          <label className={labelClass}>{t('monitor_form.sort_order')}</label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setSortOrder(Number.isFinite(n) ? n : 0);
            }}
            min={-100000}
            max={100000}
            className={inputClass}
          />
          <div className={FIELD_HELP_CLASS}>{t('monitor_form.sort_order_help')}</div>
        </div>
      </div>

      <div>
        <label className={labelClass}>{t('monitor_form.type')}</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MonitorType)}
          className={selectClass}
          disabled={!!monitor}
        >
          <option value="http">{t('monitor_form.type_http')}</option>
          <option value="tcp">{t('monitor_form.type_tcp')}</option>
        </select>
      </div>

      <div>
        <label className={labelClass}>
          {type === 'http' ? t('monitor_form.target_url') : t('monitor_form.target_host_port')}
        </label>
        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={
            type === 'http'
              ? t('monitor_form.target_url_placeholder')
              : t('monitor_form.target_host_port_placeholder')
          }
          className={inputClass}
          required
        />
      </div>

      {type === 'http' && (
        <div>
          <label className={labelClass}>{t('monitor_form.method')}</label>
          <select
            value={httpMethod}
            onChange={(e) => setHttpMethod(toHttpMethod(e.target.value))}
            className={selectClass}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
            <option value="HEAD">HEAD</option>
          </select>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t('monitor_form.interval_sec')}</label>
          <input
            type="number"
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            min={60}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('monitor_form.timeout_ms')}</label>
          <input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            min={1000}
            className={inputClass}
          />
        </div>
      </div>

      {type === 'http' && (
        <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={showAdvancedHttp}
              onChange={(e) => setShowAdvancedHttp(e.target.checked)}
            />
            <span>{t('monitor_form.advanced_http_options')}</span>
          </label>

          {showAdvancedHttp && (
            <div className="mt-4 space-y-4">
              <div>
                <label className={labelClass}>{t('monitor_form.headers_optional')}</label>
                <textarea
                  value={httpHeadersJson}
                  onChange={(e) => setHttpHeadersJson(e.target.value)}
                  className={`${textareaClass} font-mono`}
                  rows={4}
                  placeholder={t('monitor_form.headers_placeholder')}
                />
                {!headersParse.ok && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {headersParse.error}
                  </div>
                )}
                <div className={FIELD_HELP_CLASS}>{t('monitor_form.headers_help')}</div>
              </div>

              <div>
                <label className={labelClass}>{t('monitor_form.expected_status_optional')}</label>
                <input
                  type="text"
                  value={expectedStatusInput}
                  onChange={(e) => setExpectedStatusInput(e.target.value)}
                  className={inputClass}
                  placeholder={t('monitor_form.expected_status_placeholder')}
                />
                {!expectedStatusParse.ok && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {expectedStatusParse.error}
                  </div>
                )}
                <div className={FIELD_HELP_CLASS}>{t('monitor_form.expected_status_help')}</div>
              </div>

              <div>
                <label className={labelClass}>{t('monitor_form.body_optional')}</label>
                <textarea
                  value={httpBody}
                  onChange={(e) => setHttpBody(e.target.value)}
                  className={`${textareaClass} font-mono`}
                  rows={4}
                  placeholder={
                    httpMethod === 'GET' || httpMethod === 'HEAD'
                      ? t('monitor_form.body_placeholder_get_head')
                      : t('monitor_form.body_placeholder_default')
                  }
                />
              </div>

              <div>
                <label className={labelClass}>
                  {t('monitor_form.response_must_contain_optional')}
                </label>
                <input
                  type="text"
                  value={responseKeyword}
                  onChange={(e) => setResponseKeyword(e.target.value)}
                  className={inputClass}
                  placeholder={t('monitor_form.response_must_contain_placeholder')}
                />
              </div>

              <div>
                <label className={labelClass}>
                  {t('monitor_form.response_must_not_contain_optional')}
                </label>
                <input
                  type="text"
                  value={responseForbiddenKeyword}
                  onChange={(e) => setResponseForbiddenKeyword(e.target.value)}
                  className={inputClass}
                  placeholder={t('monitor_form.response_must_not_contain_placeholder')}
                />
              </div>

              {monitor && <div className={FIELD_HELP_CLASS}>{t('monitor_form.clear_help')}</div>}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={props.onCancel} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={props.isLoading || !canSubmit} className="flex-1">
          {props.isLoading ? t('common.saving') : monitor ? t('common.update') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}
