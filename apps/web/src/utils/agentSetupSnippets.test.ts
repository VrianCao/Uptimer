import { describe, expect, it } from 'vitest';

import {
  ADMIN_TOKEN_PLACEHOLDER,
  DEFAULT_UPTIMER_ORIGIN_PLACEHOLDER,
  buildAgentPromptSnippet,
  buildCliCommandsSnippet,
  buildConnectSnippet,
  buildSkillInstallSnippet,
  isCliSupportedOrigin,
  resolveAgentInstanceOrigin,
  shellQuoteSingle,
} from './agentSetupSnippets';

describe('isCliSupportedOrigin', () => {
  it('accepts HTTPS origins and loopback HTTP origins without credentials or query', () => {
    expect(isCliSupportedOrigin('https://status.example.com')).toBe(true);
    expect(isCliSupportedOrigin('http://localhost:5173')).toBe(true);
    expect(isCliSupportedOrigin('http://127.0.0.1:8787')).toBe(true);
    expect(isCliSupportedOrigin('http://[::1]:8787')).toBe(true);
  });

  it('rejects non-loopback HTTP, non-HTTP schemes, userinfo, query, and fragments', () => {
    expect(isCliSupportedOrigin('http://192.168.1.10:5173')).toBe(false);
    expect(isCliSupportedOrigin('http://status.example.com')).toBe(false);
    expect(isCliSupportedOrigin('ftp://status.example.com')).toBe(false);
    expect(isCliSupportedOrigin('https://user:pass@status.example.com')).toBe(false);
    expect(isCliSupportedOrigin('https://status.example.com?a=1')).toBe(false);
    expect(isCliSupportedOrigin('https://status.example.com#frag')).toBe(false);
    expect(isCliSupportedOrigin('not a url')).toBe(false);
  });
});

describe('resolveAgentInstanceOrigin', () => {
  it('prefers an absolute CLI-supported VITE_API_BASE and strips /api/v1 path', () => {
    expect(
      resolveAgentInstanceOrigin({
        apiBase: 'https://worker.example.com/api/v1',
        windowOrigin: 'https://status.pages.dev',
      }),
    ).toEqual({
      origin: 'https://worker.example.com',
      isPlaceholder: false,
    });
  });

  it('falls back to HTTPS or loopback windowOrigin when apiBase is relative', () => {
    expect(
      resolveAgentInstanceOrigin({
        apiBase: '/api/v1',
        windowOrigin: 'https://status.pages.dev',
      }),
    ).toEqual({
      origin: 'https://status.pages.dev',
      isPlaceholder: false,
    });

    expect(
      resolveAgentInstanceOrigin({
        apiBase: '/api/v1',
        windowOrigin: 'http://localhost:5173',
      }),
    ).toEqual({
      origin: 'http://localhost:5173',
      isPlaceholder: false,
    });

    expect(
      resolveAgentInstanceOrigin({
        apiBase: '/api/v1',
        windowOrigin: 'http://127.0.0.1:8787',
      }),
    ).toEqual({
      origin: 'http://127.0.0.1:8787',
      isPlaceholder: false,
    });

    expect(
      resolveAgentInstanceOrigin({
        apiBase: '/api/v1',
        windowOrigin: 'http://[::1]:8787',
      }),
    ).toEqual({
      origin: 'http://[::1]:8787',
      isPlaceholder: false,
    });
  });

  it('returns placeholder for non-loopback HTTP or malformed inputs', () => {
    expect(
      resolveAgentInstanceOrigin({
        apiBase: '/api/v1',
        windowOrigin: 'http://192.168.1.10:5173',
      }),
    ).toEqual({
      origin: DEFAULT_UPTIMER_ORIGIN_PLACEHOLDER,
      isPlaceholder: true,
    });

    expect(
      resolveAgentInstanceOrigin({
        apiBase: 'not-a-url',
        windowOrigin: 'invalid',
      }),
    ).toEqual({
      origin: DEFAULT_UPTIMER_ORIGIN_PLACEHOLDER,
      isPlaceholder: true,
    });
  });
});

describe('shellQuoteSingle & buildConnectSnippet', () => {
  it('escapes shell metacharacters and strips newlines safely', () => {
    const raw = `tok$VAR\`cmd\`"<> '\n\rnext`;
    expect(shellQuoteSingle(raw)).toBe(`'tok$VAR\`cmd\`"<> '\\''next'`);
  });

  it('uses placeholder by default even when a sessionToken is supplied', () => {
    const snippet = buildConnectSnippet({
      origin: 'https://status.pages.dev',
      includeSessionToken: false,
      sessionToken: 'secret-token-123',
    });
    expect(snippet).toContain(`export UPTIMER_URL='https://status.pages.dev'`);
    expect(snippet).toContain(`export UPTIMER_ADMIN_TOKEN='${ADMIN_TOKEN_PLACEHOLDER}'`);
    expect(snippet).not.toContain('secret-token-123');
    expect(snippet).toContain('uptimer settings get');
  });

  it('falls back to placeholder when includeSessionToken is true but token is missing or blank', () => {
    expect(
      buildConnectSnippet({
        origin: 'https://status.pages.dev',
        includeSessionToken: true,
        sessionToken: null,
      }),
    ).toContain(`export UPTIMER_ADMIN_TOKEN='${ADMIN_TOKEN_PLACEHOLDER}'`);

    expect(
      buildConnectSnippet({
        origin: 'https://status.pages.dev',
        includeSessionToken: true,
        sessionToken: '   ',
      }),
    ).toContain(`export UPTIMER_ADMIN_TOKEN='${ADMIN_TOKEN_PLACEHOLDER}'`);
  });

  it('embeds and single-quotes the session token when opted in', () => {
    const snippet = buildConnectSnippet({
      origin: 'https://status.pages.dev',
      includeSessionToken: true,
      sessionToken: `a'b$c`,
    });
    expect(snippet).toContain(`export UPTIMER_ADMIN_TOKEN='a'\\''b$c'`);
  });
});

describe('buildSkillInstallSnippet, buildCliCommandsSnippet, buildAgentPromptSnippet', () => {
  it('builds install snippets for both cli and skills_cli modes', () => {
    const cliSnippet = buildSkillInstallSnippet('cli');
    expect(cliSnippet).toContain('npm install --global uptimer-cli');
    expect(cliSnippet).toContain('uptimer skill install');

    const npxSnippet = buildSkillInstallSnippet('skills_cli');
    expect(npxSnippet).toContain('npm install --global uptimer-cli');
    expect(npxSnippet).toContain('npx skills add nexttylabs/Uptimer --skill uptimer-cli');
  });

  it('builds CLI command examples with read and --file - write usage', () => {
    const cmd = buildCliCommandsSnippet();
    expect(cmd).toContain('uptimer monitors list --limit 20');
    expect(cmd).toContain('uptimer status-pages list');
    expect(cmd).toContain('uptimer notification-channels list');
    expect(cmd).toContain('uptimer monitors create --file -');
  });

  it('substitutes {origin} in agent prompt without exposing credentials', () => {
    const prompt = buildAgentPromptSnippet(
      'https://status.pages.dev',
      'Inspect {origin} and verify {origin} monitors.',
    );
    expect(prompt).toBe(
      'Inspect https://status.pages.dev and verify https://status.pages.dev monitors.',
    );
  });
});
