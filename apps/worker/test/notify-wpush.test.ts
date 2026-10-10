import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchWebhookToChannel } from '../src/notify/webhook';
import { encryptWpushApiKey } from '../src/notify/wpush-token';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

const originalFetch = globalThis.fetch;

function notificationDb(onFinalize: (args: unknown[]) => void): D1Database {
  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'insert or ignore into notification_deliveries',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'update notification_deliveries',
      run: (args) => {
        onFinalize(args);
        return { meta: { changes: 1 } };
      },
    },
  ];
  return createFakeD1Database(handlers);
}

describe('notify/webhook WPush preset', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends form-encoded WPush requests with an encrypted stored API key', async () => {
    let finalizeArgs: unknown[] | null = null;
    const encryptedKey = await encryptWpushApiKey('test-admin-token', 'WPUSH_TEST');
    let form: URLSearchParams | null = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.wpush.cn/api/v1/send');
      expect(init?.method).toBe('POST');
      form = new URLSearchParams(String(init?.body ?? ''));
      return new Response(
        JSON.stringify({ code: 0, message: 'success', data: '123', success: true }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: { ADMIN_TOKEN: 'test-admin-token' },
      channel: {
        id: 20,
        name: 'WPush',
        config: {
          preset: 'wpush',
          api_key_encrypted: encryptedKey,
          channel: 'wechat,app',
          option: 'ops',
          url: 'https://status.example.com',
        },
      },
      eventType: 'monitor.down',
      eventKey: 'monitor:1:down:100',
      payload: {
        event: 'monitor.down',
        monitor: { id: 1, name: 'API', display_url: 'https://status.example.com' },
        state: { status: 'down', error: 'Timeout' },
      },
    });

    expect(form?.get('apikey')).toBe('WPUSH_TEST');
    expect(form?.get('channel')).toBe('wechat,app');
    expect(form?.get('option')).toBe('ops');
    expect(form?.get('url')).toBe('https://status.example.com');
    expect(form?.get('title')).toContain('Uptimer');
    expect(form?.get('content')).toContain('Monitor DOWN: API');
    expect(finalizeArgs).toEqual(['success', 200, null, 'monitor:1:down:100', 20]);
  });

  it('uses a Worker Secret reference and reports API-level failures', async () => {
    let finalizeArgs: unknown[] | null = null;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 1001, message: 'invalid api key', success: false }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: { UPTIMER_WPUSH_API_KEY: 'WPUSH_BAD' },
      channel: {
        id: 21,
        name: 'WPush',
        config: {
          preset: 'wpush',
          api_key_secret_ref: 'UPTIMER_WPUSH_API_KEY',
          channel: 'wechat',
        },
      },
      eventType: 'test.ping',
      eventKey: 'test:wpush:21:100',
      payload: { event: 'test.ping' },
    });

    expect(finalizeArgs).toEqual([
      'failed',
      200,
      'WPush 1001: invalid api key',
      'test:wpush:21:100',
      21,
    ]);
  });

  it('fails before fetch when the configured Worker Secret is missing', async () => {
    let finalizeArgs: unknown[] | null = null;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: {},
      channel: {
        id: 22,
        name: 'WPush',
        config: {
          preset: 'wpush',
          api_key_secret_ref: 'UPTIMER_WPUSH_API_KEY',
          channel: 'wechat',
        },
      },
      eventType: 'test.ping',
      eventKey: 'test:wpush:22:100',
      payload: { event: 'test.ping' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalizeArgs).toEqual([
      'failed',
      null,
      'WPush API key not configured: UPTIMER_WPUSH_API_KEY',
      'test:wpush:22:100',
      22,
    ]);
  });
});
