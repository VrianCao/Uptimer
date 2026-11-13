import { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../app/AuthContext';
import { useI18n } from '../app/I18nContext';
import {
  buildAgentPromptSnippet,
  buildCliCommandsSnippet,
  buildConnectSnippet,
  buildSkillInstallSnippet,
  resolveAgentInstanceOrigin,
  type SkillInstallMethod,
  type UsageExampleMode,
} from '../utils/agentSetupSnippets';
import { Badge, Button, Card, cn } from './ui';

type GuideSection = 'install' | 'connect' | 'usage';

function fallbackCopyText(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copied;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopyText(text);
    }
  }
  return fallbackCopyText(text);
}

const segmentedTabClass = (active: boolean) =>
  cn(
    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
    active
      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100',
  );

export function AgentSetupGuideCard() {
  const { token } = useAuth();
  const { t } = useI18n();

  const { origin, isPlaceholder } = useMemo(
    () =>
      resolveAgentInstanceOrigin({
        apiBase: import.meta.env.VITE_API_BASE as string | undefined,
        windowOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
      }),
    [],
  );

  const [includeSessionToken, setIncludeSessionToken] = useState(false);
  const [installMethod, setInstallMethod] = useState<SkillInstallMethod>('cli');
  const [usageMode, setUsageMode] = useState<UsageExampleMode>('agent_prompt');
  const [copyState, setCopyState] = useState<{ section: GuideSection; ok: boolean } | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const installSnippet = useMemo(() => buildSkillInstallSnippet(installMethod), [installMethod]);

  const connectSnippet = useMemo(
    () =>
      buildConnectSnippet({
        origin,
        includeSessionToken: Boolean(token) && includeSessionToken,
        sessionToken: token,
      }),
    [includeSessionToken, origin, token],
  );

  const usageSnippet = useMemo(
    () =>
      usageMode === 'agent_prompt'
        ? buildAgentPromptSnippet(origin, t('admin_settings.agent_guide.prompt_template'))
        : buildCliCommandsSnippet(),
    [origin, t, usageMode],
  );

  const handleCopy = async (section: GuideSection, text: string) => {
    const ok = await copyToClipboard(text);
    setCopyState({ section, ok });
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(() => {
      setCopyState(null);
      copyTimerRef.current = null;
    }, 2000);
  };

  const renderCopyLabel = (section: GuideSection) => {
    if (copyState?.section !== section) {
      return t('admin_settings.agent_guide.copy');
    }
    return copyState.ok
      ? t('admin_settings.agent_guide.copied')
      : t('admin_settings.agent_guide.copy_failed');
  };

  const tokenIncluded = Boolean(token) && includeSessionToken;

  return (
    <Card className="p-4 sm:p-5">
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {t('admin_settings.agent_guide.title')}
              </span>
              <Badge variant="info">uptimer-cli</Badge>
              <Badge variant="unknown">{'Node >= 22.14'}</Badge>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t('admin_settings.agent_guide.help')}
            </p>
          </div>

          <label
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200',
              token ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={tokenIncluded}
              disabled={!token}
              onChange={(e) => setIncludeSessionToken(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-blue-500 dark:border-slate-600"
            />
            <span>{t('admin_settings.agent_guide.include_token')}</span>
          </label>
        </div>

        {tokenIncluded && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            {t('admin_settings.agent_guide.token_warning')}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {t('admin_settings.agent_guide.step1_title')}
              </div>
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {t('admin_settings.agent_guide.step1_help')}
              </div>
            </div>

            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setInstallMethod('cli')}
                className={segmentedTabClass(installMethod === 'cli')}
              >
                {t('admin_settings.agent_guide.install_mode_cli')}
              </button>
              <button
                type="button"
                onClick={() => setInstallMethod('skills_cli')}
                className={segmentedTabClass(installMethod === 'skills_cli')}
              >
                {t('admin_settings.agent_guide.install_mode_npx')}
              </button>
            </div>
          </div>

          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 p-3 pr-20 font-mono text-xs leading-relaxed text-slate-100 dark:border-slate-700">
              <code>{installSnippet}</code>
            </pre>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopy('install', installSnippet)}
              className="absolute right-2 top-2 h-7 px-2.5 text-xs"
            >
              {renderCopyLabel('install')}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              {t('admin_settings.agent_guide.step2_title')}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {t('admin_settings.agent_guide.step2_help')}
            </div>
            {isPlaceholder && (
              <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {t('admin_settings.agent_guide.origin_placeholder_hint')}
              </div>
            )}
          </div>

          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 p-3 pr-20 font-mono text-xs leading-relaxed text-slate-100 dark:border-slate-700">
              <code>{connectSnippet}</code>
            </pre>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopy('connect', connectSnippet)}
              className="absolute right-2 top-2 h-7 px-2.5 text-xs"
            >
              {renderCopyLabel('connect')}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              {t('admin_settings.agent_guide.step3_title')}
            </div>

            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setUsageMode('agent_prompt')}
                className={segmentedTabClass(usageMode === 'agent_prompt')}
              >
                {t('admin_settings.agent_guide.usage_mode_prompt')}
              </button>
              <button
                type="button"
                onClick={() => setUsageMode('cli_commands')}
                className={segmentedTabClass(usageMode === 'cli_commands')}
              >
                {t('admin_settings.agent_guide.usage_mode_cli')}
              </button>
            </div>
          </div>

          <div className="relative">
            <pre
              className={cn(
                'rounded-lg border border-slate-200 bg-slate-950 p-3 pr-20 font-mono text-xs leading-relaxed text-slate-100 dark:border-slate-700',
                usageMode === 'agent_prompt'
                  ? 'whitespace-pre-wrap break-words'
                  : 'overflow-x-auto',
              )}
            >
              <code>{usageSnippet}</code>
            </pre>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopy('usage', usageSnippet)}
              className="absolute right-2 top-2 h-7 px-2.5 text-xs"
            >
              {renderCopyLabel('usage')}
            </Button>
          </div>
        </div>

        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          {t('admin_settings.agent_guide.scope_note')}
        </div>
      </div>
    </Card>
  );
}
