import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHttpCheck } from '../src/monitor/http';

const BASE_CONFIG = {
  url: 'https://example.com/health',
  timeoutMs: 200,
  method: 'GET' as const,
  headers: null,
  body: null,
  expectedStatus: null,
  responseKeyword: null,
  responseKeywordMode: null,
  responseForbiddenKeyword: null,
  responseForbiddenKeywordMode: null,
};

describe('monitor/http', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rejects invalid targets before sending network requests', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await runHttpCheck({ ...BASE_CONFIG, url: 'ftp://example.com' });

    expect(outcome.status).toBe('unknown');
    expect(outcome.latencyMs).toBeNull();
    expect(outcome.httpStatus).toBeNull();
    expect(outcome.error).toMatch(/protocol/i);
    expect(outcome.attempts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no-store requests with default user-agent and reports success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.cache).toBe('no-store');
      expect(headers.get('user-agent')).toBe('Uptimer/0.1');
      expect((init?.cf as { cacheTtlByStatus?: unknown })?.cacheTtlByStatus).toEqual({
        '100-599': -1,
      });
      return new Response('healthy', { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await runHttpCheck(BASE_CONFIG);

    expect(outcome.status).toBe('up');
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.error).toBeNull();
    expect(outcome.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps caller user-agent and request body when provided', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe('CustomAgent/2.0');
      expect(init?.body).toBe('probe=1');
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await runHttpCheck({
      ...BASE_CONFIG,
      method: 'POST',
      headers: { 'User-Agent': 'CustomAgent/2.0' },
      body: 'probe=1',
    });

    expect(outcome.status).toBe('up');
    expect(outcome.attempts).toBe(1);
  });

  it('marks mismatched status codes as down', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => new Response('teapot', { status: 418 })) as unknown as typeof fetch;

    const outcomePromise = runHttpCheck({ ...BASE_CONFIG, expectedStatus: [200] });
    await vi.advanceTimersByTimeAsync(1_200);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe('down');
    expect(outcome.httpStatus).toBe(418);
    expect(outcome.error).toMatch(/Unexpected HTTP status/);
    expect(outcome.attempts).toBe(3);
  });

  it('applies keyword assertions for response bodies', async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn(async () => new Response('all systems nominal', { status: 200 })) as unknown as typeof fetch;
    const missingPromise = runHttpCheck({ ...BASE_CONFIG, responseKeyword: 'incident' });
    await vi.advanceTimersByTimeAsync(1_200);
    const missing = await missingPromise;
    expect(missing.status).toBe('down');
    expect(missing.error).toBe('Response keyword not found');
    expect(missing.attempts).toBe(3);

    globalThis.fetch = vi.fn(async () => new Response('contains secret token', { status: 200 })) as unknown as typeof fetch;
    const forbiddenPromise = runHttpCheck({ ...BASE_CONFIG, responseForbiddenKeyword: 'secret' });
    await vi.advanceTimersByTimeAsync(1_200);
    const forbidden = await forbiddenPromise;
    expect(forbidden.status).toBe('down');
    expect(forbidden.error).toBe('Forbidden response keyword found');
    expect(forbidden.attempts).toBe(3);
  });

  it('supports regex assertions for required and forbidden response bodies', async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn(async () => new Response('status=ready version=42', { status: 200 })) as unknown as typeof fetch;
    const requiredSuccess = await runHttpCheck({
      ...BASE_CONFIG,
      responseKeyword: 'status=ready\\s+version=\\d+',
      responseKeywordMode: 'regex',
    });
    expect(requiredSuccess.status).toBe('up');
    expect(requiredSuccess.error).toBeNull();
    expect(requiredSuccess.attempts).toBe(1);

    globalThis.fetch = vi.fn(async () => new Response('status=starting', { status: 200 })) as unknown as typeof fetch;
    const requiredFailurePromise = runHttpCheck({
      ...BASE_CONFIG,
      responseKeyword: 'status=ready\\s+version=\\d+',
      responseKeywordMode: 'regex',
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const requiredFailure = await requiredFailurePromise;
    expect(requiredFailure.status).toBe('down');
    expect(requiredFailure.error).toBe('Required response regex not matched');
    expect(requiredFailure.attempts).toBe(3);

    globalThis.fetch = vi.fn(async () => new Response('status=ready secret=token-123', { status: 200 })) as unknown as typeof fetch;
    const forbiddenFailurePromise = runHttpCheck({
      ...BASE_CONFIG,
      responseForbiddenKeyword: 'secret=token-\\d+',
      responseForbiddenKeywordMode: 'regex',
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const forbiddenFailure = await forbiddenFailurePromise;
    expect(forbiddenFailure.status).toBe('down');
    expect(forbiddenFailure.error).toBe('Forbidden response regex matched');
    expect(forbiddenFailure.attempts).toBe(3);
  });

  it('returns unknown when body assertions are requested but response has no readable body', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const outcome = await runHttpCheck({ ...BASE_CONFIG, responseKeyword: 'ok' });
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/not readable/i);
    expect(outcome.attempts).toBe(1);
  });

  it('returns unknown when assertions require reading beyond the 1 MiB safety limit', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('a'.repeat(1024 * 1024 + 16));
    const makeLargeResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      );

    globalThis.fetch = vi.fn(async () => makeLargeResponse()) as unknown as typeof fetch;

    const requiredKeyword = await runHttpCheck({ ...BASE_CONFIG, responseKeyword: 'needle' });
    expect(requiredKeyword.status).toBe('unknown');
    expect(requiredKeyword.error).toMatch(/exceeded 1048576 bytes/i);
    expect(requiredKeyword.attempts).toBe(1);

    const forbiddenKeyword = await runHttpCheck({
      ...BASE_CONFIG,
      responseKeyword: null,
      responseForbiddenKeyword: 'forbidden',
    });
    expect(forbiddenKeyword.status).toBe('unknown');
    expect(forbiddenKeyword.error).toMatch(/cannot assert forbidden keyword absence/i);
    expect(forbiddenKeyword.attempts).toBe(1);

    globalThis.fetch = vi.fn(async () => makeLargeResponse()) as unknown as typeof fetch;
    const requiredRegex = await runHttpCheck({
      ...BASE_CONFIG,
      responseKeyword: 'needle-\\d+',
      responseKeywordMode: 'regex',
    });
    expect(requiredRegex.status).toBe('unknown');
    expect(requiredRegex.error).toMatch(/cannot assert required response regex/i);
    expect(requiredRegex.attempts).toBe(1);

    globalThis.fetch = vi.fn(async () => makeLargeResponse()) as unknown as typeof fetch;
    const forbiddenRegex = await runHttpCheck({
      ...BASE_CONFIG,
      responseForbiddenKeyword: 'forbidden-\\d+',
      responseForbiddenKeywordMode: 'regex',
    });
    expect(forbiddenRegex.status).toBe('unknown');
    expect(forbiddenRegex.error).toMatch(/cannot assert forbidden response regex absence/i);
    expect(forbiddenRegex.attempts).toBe(1);
  });

  it('fails safely when runtime regex compilation is invalid', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await runHttpCheck({
      ...BASE_CONFIG,
      responseKeyword: '(',
      responseKeywordMode: 'regex',
    });

    expect(outcome.status).toBe('unknown');
    expect(outcome.latencyMs).toBeNull();
    expect(outcome.httpStatus).toBeNull();
    expect(outcome.error).toMatch(/invalid regex/i);
    expect(outcome.attempts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries transient failures and returns success when a later attempt passes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary dns error'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcomePromise = runHttpCheck(BASE_CONFIG);
    await vi.advanceTimersByTimeAsync(400);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe('up');
    expect(outcome.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports timeout after exhausting retry budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as { name: string }).name = 'AbortError';
          reject(err);
        });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcomePromise = runHttpCheck({ ...BASE_CONFIG, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe('down');
    expect(outcome.error).toBe('Timeout after 50ms');
    expect(outcome.attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
