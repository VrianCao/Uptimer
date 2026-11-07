import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchWebhookToChannel } from '../src/notify/webhook';
import { encryptTelegramBotToken } from '../src/notify/telegram-token';
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

describe('notify/webhook Telegram preset', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends Telegram sendMessage with an encrypted stored token', async () => {
    let finalizeArgs: unknown[] | null = null;
    const encryptedToken = await encryptTelegramBotToken('test-admin-token', '123456:TEST');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('https://api.telegram.org/bot123456:TEST/sendMessage');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: { ADMIN_TOKEN: 'test-admin-token' },
      channel: {
        id: 6,
        name: 'Telegram',
        config: {
          preset: 'telegram',
          bot_token_encrypted: encryptedToken,
          chat_id: '-1001234567890',
        },
      },
      eventType: 'test.ping',
      eventKey: 'test:telegram:6:100',
      payload: { event: 'test.ping' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finalizeArgs).toEqual(['success', 200, null, 'test:telegram:6:100', 6]);
  });

  it('sends Telegram sendMessage through a Worker secret token reference', async () => {
    let finalizeArgs: unknown[] | null = null;
    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('https://api.telegram.org/bot123456:TEST/sendMessage');
      expect(init?.method).toBe('POST');
      expect(init?.cache).toBe('no-store');
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: { UPTIMER_TELEGRAM_BOT_TOKEN: '123456:TEST' },
      channel: {
        id: 7,
        name: 'Telegram',
        config: {
          preset: 'telegram',
          bot_token_secret_ref: 'UPTIMER_TELEGRAM_BOT_TOKEN',
          chat_id: '-1001234567890',
          parse_mode: 'HTML',
          disable_notification: true,
        },
      },
      eventType: 'monitor.down',
      eventKey: 'monitor:1:down:100',
      payload: {
        event: 'monitor.down',
        monitor: { id: 1, name: 'API', type: 'http', target: 'https://api.example.com/health' },
        state: { status: 'down', error: 'Timeout after 10000ms' },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      chat_id: '-1001234567890',
      parse_mode: 'HTML',
      disable_notification: true,
    });
    expect(String(requestBody?.text)).toContain('Monitor DOWN: API');
    expect(String(requestBody?.text)).toContain('Timeout after 10000ms');
    expect(finalizeArgs).toEqual(['success', 200, null, 'monitor:1:down:100', 7]);
  });

  it('skips monitor events outside the configured monitor scope', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await dispatchWebhookToChannel({
      db: notificationDb(() => {
        throw new Error('delivery should not be finalized');
      }),
      env: { UPTIMER_TELEGRAM_BOT_TOKEN: '123456:TEST' },
      channel: {
        id: 70,
        name: 'Scoped Telegram',
        config: {
          preset: 'telegram',
          bot_token_secret_ref: 'UPTIMER_TELEGRAM_BOT_TOKEN',
          chat_id: '-1001234567890',
          monitor_ids: [2, 3],
        },
      },
      eventType: 'monitor.down',
      eventKey: 'monitor:1:down:100',
      payload: {
        event: 'monitor.down',
        monitor: { id: 1, name: 'API', type: 'http', target: 'https://api.example.com' },
      },
    });

    expect(result).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks Telegram ok=false responses as failed deliveries', async () => {
    let finalizeArgs: unknown[] | null = null;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat not found',
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: { UPTIMER_TELEGRAM_BOT_TOKEN: '123456:TEST' },
      channel: {
        id: 8,
        name: 'Telegram',
        config: {
          preset: 'telegram',
          bot_token_secret_ref: 'UPTIMER_TELEGRAM_BOT_TOKEN',
          chat_id: '-1001234567890',
        },
      },
      eventType: 'test.ping',
      eventKey: 'test:telegram:8:100',
      payload: { event: 'test.ping' },
    });

    expect(finalizeArgs).toEqual([
      'failed',
      200,
      'Telegram 400: Bad Request: chat not found',
      'test:telegram:8:100',
      8,
    ]);
  });

  it('fails without calling Telegram when the token secret is missing', async () => {
    let finalizeArgs: unknown[] | null = null;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await dispatchWebhookToChannel({
      db: notificationDb((args) => {
        finalizeArgs = args;
      }),
      env: {},
      channel: {
        id: 9,
        name: 'Telegram',
        config: {
          preset: 'telegram',
          bot_token_secret_ref: 'UPTIMER_TELEGRAM_BOT_TOKEN',
          chat_id: '-1001234567890',
        },
      },
      eventType: 'test.ping',
      eventKey: 'test:telegram:9:100',
      payload: { event: 'test.ping' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalizeArgs).toEqual([
      'failed',
      null,
      'Telegram bot token not configured: UPTIMER_TELEGRAM_BOT_TOKEN',
      'test:telegram:9:100',
      9,
    ]);
  });
});
