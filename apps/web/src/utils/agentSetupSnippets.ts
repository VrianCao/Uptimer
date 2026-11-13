export const ADMIN_TOKEN_PLACEHOLDER = '<YOUR_ADMIN_TOKEN>';
export const DEFAULT_UPTIMER_ORIGIN_PLACEHOLDER = 'https://your-uptimer-worker.workers.dev';

export type SkillInstallMethod = 'cli' | 'skills_cli';
export type UsageExampleMode = 'agent_prompt' | 'cli_commands';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Mirrors `uptimer-cli` origin rules: HTTPS anywhere, or HTTP on loopback hosts only,
 * with no userinfo, query parameters, or fragments.
 */
export function isCliSupportedOrigin(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'https:') {
    return true;
  }
  if (protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return false;
}

/**
 * Resolves the target Uptimer origin for CLI setup snippets, preferring an absolute
 * `VITE_API_BASE`, then the current browser origin if CLI-compatible, otherwise a placeholder.
 */
export function resolveAgentInstanceOrigin(input: {
  apiBase?: string | undefined;
  windowOrigin?: string | undefined;
}): { origin: string; isPlaceholder: boolean } {
  const rawApiBase = input.apiBase?.trim() ?? '';
  if (/^https?:\/\//i.test(rawApiBase)) {
    try {
      const parsed = new URL(rawApiBase);
      if (isCliSupportedOrigin(parsed.origin)) {
        return { origin: parsed.origin, isPlaceholder: false };
      }
    } catch {
      // Fall through to windowOrigin / placeholder.
    }
  }

  const rawWindowOrigin = input.windowOrigin?.trim() ?? '';
  if (rawWindowOrigin && isCliSupportedOrigin(rawWindowOrigin)) {
    return { origin: new URL(rawWindowOrigin).origin, isPlaceholder: false };
  }

  return { origin: DEFAULT_UPTIMER_ORIGIN_PLACEHOLDER, isPlaceholder: true };
}

/**
 * Wraps a value in POSIX single quotes so shell metacharacters are not expanded.
 */
export function shellQuoteSingle(value: string): string {
  const clean = value.replace(/[\r\n]+/g, '');
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds the CLI + Agent Skill installation snippet for the chosen installer mode.
 */
export function buildSkillInstallSnippet(method: SkillInstallMethod): string {
  if (method === 'skills_cli') {
    return [
      'npm install --global uptimer-cli',
      'npx skills add nexttylabs/Uptimer --skill uptimer-cli',
      '# Optional: add -g for global install, or -a <agent> for a specific agent',
    ].join('\n');
  }

  return [
    'npm install --global uptimer-cli',
    'uptimer skill install',
    '# Optional: install into a specific agent directory and overwrite an existing copy',
    '# uptimer skill install --dir ~/.claude/skills --force',
  ].join('\n');
}

/**
 * Builds the environment export and connectivity check snippet.
 */
export function buildConnectSnippet(input: {
  origin: string;
  includeSessionToken: boolean;
  sessionToken?: string | null | undefined;
}): string {
  const trimmedToken = input.sessionToken?.trim() ?? '';
  const tokenValue =
    input.includeSessionToken && trimmedToken.length > 0 ? trimmedToken : ADMIN_TOKEN_PLACEHOLDER;

  return [
    `export UPTIMER_URL=${shellQuoteSingle(input.origin)}`,
    `export UPTIMER_ADMIN_TOKEN=${shellQuoteSingle(tokenValue)}`,
    'uptimer settings get',
  ].join('\n');
}

/**
 * Builds representative terminal CLI read/write commands.
 */
export function buildCliCommandsSnippet(): string {
  return [
    'uptimer monitors list --limit 20',
    'uptimer status-pages list',
    'uptimer notification-channels list',
    `printf '%s\\n' '{"name":"API Health","type":"http","target":"https://api.example.com/health","interval_sec":60}' | uptimer monitors create --file -`,
  ].join('\n');
}

/**
 * Formats an agent chat prompt with `{origin}` substituted and never embeds credentials.
 */
export function buildAgentPromptSnippet(origin: string, promptTemplate: string): string {
  return promptTemplate.replace(/\{origin\}/g, origin);
}
