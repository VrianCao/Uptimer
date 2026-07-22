import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}));

import { connect } from 'cloudflare:sockets';
import { runTcpCheck } from '../src/monitor/tcp';

function createSocket(opened: Promise<unknown>) {
  return {
    opened,
    close: vi.fn(),
  };
}

describe('monitor/tcp', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rejects invalid targets before opening sockets', async () => {
    const result = await runTcpCheck({ target: 'invalid-target', timeoutMs: 1000 });
    expect(result.status).toBe('unknown');
    expect(result.latencyMs).toBeNull();
    expect(result.httpStatus).toBeNull();
    expect(result.error).toMatch(/host:port format/i);
    expect(result.attempts).toBe(1);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('reports up when TCP handshake succeeds', async () => {
    const socket = createSocket(Promise.resolve());
    vi.mocked(connect).mockReturnValue(socket as never);

    const result = await runTcpCheck({ target: 'example.com:443', timeoutMs: 500 });

    expect(result.status).toBe('up');
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(1);
    expect(socket.close).toHaveBeenCalled();
  });

  it('preserves brackets when connecting to an IPv6 target', async () => {
    const socket = createSocket(Promise.resolve());
    vi.mocked(connect).mockReturnValue(socket as never);

    const result = await runTcpCheck({
      target: '[2001:bc8:1d80:2140::1]:22',
      timeoutMs: 500,
    });

    expect(result.status).toBe('up');
    expect(connect).toHaveBeenCalledWith({
      hostname: '[2001:bc8:1d80:2140::1]',
      port: 22,
    });
  });

  it('retries transient connection failures and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    vi.mocked(connect)
      .mockReturnValueOnce(createSocket(Promise.reject(new Error('ECONNREFUSED'))) as never)
      .mockReturnValueOnce(createSocket(Promise.resolve()) as never);

    const resultPromise = runTcpCheck({ target: 'example.com:443', timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;

    expect(result.status).toBe('up');
    expect(result.attempts).toBe(2);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(2);
  });

  it('returns timeout after exhausting retries', async () => {
    vi.useFakeTimers();
    vi.mocked(connect).mockImplementation(() => createSocket(new Promise(() => {})) as never);

    const resultPromise = runTcpCheck({ target: 'example.com:443', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(result.status).toBe('down');
    expect(result.error).toBe('Timeout after 50ms');
    expect(result.attempts).toBe(3);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(3);
  });

  it('handles synchronous connect failures as down', async () => {
    vi.useFakeTimers();
    vi.mocked(connect).mockImplementation(() => {
      throw new Error('socket api unavailable');
    });

    const resultPromise = runTcpCheck({ target: 'example.com:443', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(result.status).toBe('down');
    expect(result.error).toBe('socket api unavailable');
    expect(result.attempts).toBe(3);
  });
});
