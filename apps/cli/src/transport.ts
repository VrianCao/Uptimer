import { z } from 'zod';
import { CliError } from './errors.ts';
import { redactCredentials } from './redact.ts';

export interface TransportOptions {
  env?: Record<string, string | undefined> | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

export function validateEnvironment(env: Record<string, string | undefined> = process.env): {
  origin: string;
  adminToken: string;
} {
  const rawUrl = env.UPTIMER_URL?.trim();
  if (!rawUrl) {
    throw new CliError(2, 'CONFIGURATION_ERROR', 'UPTIMER_URL environment variable is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(2, 'INVALID_ARGUMENT', `Invalid UPTIMER_URL: ${msg}`);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'UPTIMER_URL must not contain userinfo');
  }

  if (parsedUrl.search) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'UPTIMER_URL must not contain query parameters');
  }

  if (parsedUrl.hash) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'UPTIMER_URL must not contain URL fragments');
  }

  if (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') {
    throw new CliError(2, 'INVALID_ARGUMENT', 'UPTIMER_URL must be a root path without subpaths');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const protocol = parsedUrl.protocol.toLowerCase();

  if (protocol === 'https:') {
    // HTTPS is allowed everywhere
  } else if (protocol === 'http:') {
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1';
    if (!isLoopback) {
      throw new CliError(
        2,
        'INVALID_ARGUMENT',
        'Insecure HTTP origins are only permitted for loopback addresses (localhost, 127.0.0.1, [::1])',
      );
    }
  } else {
    throw new CliError(2, 'INVALID_ARGUMENT', `Unsupported URL protocol: "${protocol}"`);
  }

  const adminToken = env.UPTIMER_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new CliError(2, 'CONFIGURATION_ERROR', 'UPTIMER_ADMIN_TOKEN environment variable is required');
  }

  return {
    origin: parsedUrl.origin,
    adminToken,
  };
}

// Transport failures keep their stable error code and drop the message, which can
// embed request detail; the CLI must never echo transport text verbatim.
function networkError(err: unknown, action: string): CliError {
  const code = (err as { code?: unknown } | null)?.code;
  const reason = typeof code === 'string' ? ` (${code})` : '';
  return new CliError(1, 'NETWORK_ERROR', `${action}${reason}`);
}

function discardBody(response: Response): void {
  // Fire-and-forget: a stream whose cancellation never settles must not block exit.
  void response.body?.cancel().catch(() => {});
}

// Read the body ourselves so a deadline can cancel the stream; `response.text()`
// would keep the reader locked and leak a stalled body.
async function readBody(response: Response, deadline: Promise<never>): Promise<string> {
  if (!response.body) {
    return await Promise.race([response.text(), deadline]);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
}

export async function executeApiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  payload: Record<string, unknown> | undefined,
  envelopeSchema: z.ZodType<T>,
  options: TransportOptions = {},
): Promise<unknown> {
  const { origin, adminToken } = validateEnvironment(options.env);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30000;

  const url = `${origin}/api/v1/admin${path}`;
  const controller = new AbortController();

  // One deadline covers the request and the whole response body; the injected
  // fetch may ignore the signal, so the body read races this promise too.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CliError(1, 'TIMEOUT', 'Request deadline exceeded'));
    }, timeoutMs);
  });
  deadline.catch(() => {
    // The race may settle on another branch first; keep the deadline rejection handled.
  });

  try {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${adminToken}`,
      };
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const init: RequestInit = { method, headers, redirect: 'manual', signal: controller.signal };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = body;
      }

      response = await Promise.race([fetchFn(url, init), deadline]);
    } catch (err: unknown) {
      if (err instanceof CliError) throw err;
      throw networkError(err, 'Network request failed');
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      discardBody(response);
      throw new CliError(1, 'REDIRECT_REJECTED', 'HTTP redirects are not allowed', response.status);
    }

    let text: string;
    try {
      text = await readBody(response, deadline);
    } catch (err: unknown) {
      if (err instanceof CliError) throw err;
      throw networkError(err, 'Failed reading response body');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.status >= 400) {
        throw new CliError(1, 'HTTP_ERROR', response.statusText || `HTTP ${response.status}`, response.status);
      }
      throw new CliError(1, 'INVALID_RESPONSE', 'Response body is not valid JSON', response.status);
    }

    if (response.status >= 400) {
      const errorBody = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (errorBody && typeof errorBody === 'object') {
        const code = typeof errorBody.code === 'string' ? errorBody.code : 'HTTP_ERROR';
        const message =
          typeof errorBody.message === 'string'
            ? errorBody.message
            : response.statusText || `HTTP ${response.status}`;
        throw new CliError(1, code, message, response.status);
      }
      throw new CliError(1, 'HTTP_ERROR', response.statusText || `HTTP ${response.status}`, response.status);
    }

    const envelopeResult = envelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) {
      throw new CliError(1, 'INVALID_RESPONSE', 'Unexpected response envelope from server', response.status);
    }

    return redactCredentials(envelopeResult.data, adminToken);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
