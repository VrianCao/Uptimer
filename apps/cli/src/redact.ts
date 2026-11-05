const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'bot_token',
  'bot_token_encrypted',
  'password',
  'token',
  'secret',
  'api_key',
]);

// Monitor config blobs: arbitrary header/body values can carry credentials.
const REDACT_ENTIRE_VALUE_KEYS = new Set(['http_headers', 'http_headers_json', 'http_body']);

// Notification channel payloads arrive as `config_json` with the same shape as `config`.
const CONFIG_CONTAINER_KEYS = new Set(['config', 'config_json']);

const CONFIG_SENSITIVE_KEYS = new Set(['headers', 'url', 'payload_template']);

function withoutToken(value: string, adminToken: string | undefined): string {
  return adminToken && adminToken.length > 0 ? value.split(adminToken).join('[REDACTED]') : value;
}

export function redactCredentials(value: unknown, adminToken?: string, inConfig = false): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return withoutToken(value, adminToken);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item, adminToken, inConfig));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      // Keys are attacker-controlled too: a reflected token can arrive as a key.
      const key = withoutToken(rawKey, adminToken);
      const lower = key.toLowerCase();
      if (
        REDACT_ENTIRE_VALUE_KEYS.has(lower) ||
        SENSITIVE_KEYS.has(lower) ||
        (inConfig && CONFIG_SENSITIVE_KEYS.has(lower))
      ) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactCredentials(rawValue, adminToken, CONFIG_CONTAINER_KEYS.has(lower));
      }
    }
    return result;
  }

  return value;
}
