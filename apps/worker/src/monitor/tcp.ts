import { connect } from 'cloudflare:sockets';

import { parseTcpTarget, validateTcpTarget } from './targets';
import type { CheckOutcome } from './types';

export type TcpCheckConfig = {
  target: string;
  timeoutMs: number;
};

const RETRY_DELAYS_MS = [300, 800] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSocketHostname(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function attemptTcpCheck(config: TcpCheckConfig): Promise<Omit<CheckOutcome, 'attempts'>> {
  const parsed = parseTcpTarget(config.target);
  if (!parsed) {
    return { status: 'unknown', latencyMs: null, httpStatus: null, error: 'Invalid target format' };
  }

  const started = performance.now();
  let socket: ReturnType<typeof connect> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    socket = connect({ hostname: toSocketHostname(parsed.host), port: parsed.port });

    const opened = socket.opened.then(() => 'opened' as const).catch((err) => ({ err }));
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), config.timeoutMs);
    });

    const raced = await Promise.race([opened, timedOut]);
    const latencyMs = Math.round(performance.now() - started);

    if (raced === 'timeout') {
      socket.close();
      return {
        status: 'down',
        latencyMs,
        httpStatus: null,
        error: `Timeout after ${config.timeoutMs}ms`,
      };
    }

    if (typeof raced === 'object' && raced && 'err' in raced) {
      return {
        status: 'down',
        latencyMs,
        httpStatus: null,
        error: toErrorMessage((raced as { err: unknown }).err),
      };
    }

    socket.close();
    return { status: 'up', latencyMs, httpStatus: null, error: null };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    return { status: 'down', latencyMs, httpStatus: null, error: toErrorMessage(err) };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      socket?.close();
    } catch {
      // ignore
    }
  }
}

export async function runTcpCheck(config: TcpCheckConfig): Promise<CheckOutcome> {
  const targetErr = validateTcpTarget(config.target);
  if (targetErr) {
    return { status: 'unknown', latencyMs: null, httpStatus: null, error: targetErr, attempts: 1 };
  }

  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let last: CheckOutcome | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await attemptTcpCheck(config);
    const outcome: CheckOutcome = { ...r, attempts: attempt };

    if (outcome.status === 'up') {
      return outcome;
    }
    if (outcome.status === 'unknown') {
      return outcome;
    }

    last = outcome;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay !== undefined) {
      await sleep(delay);
    }
  }

  return (
    last ?? {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: 'No attempts executed',
      attempts: 0,
    }
  );
}
