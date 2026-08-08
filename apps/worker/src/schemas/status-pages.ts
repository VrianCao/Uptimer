import { z } from 'zod';

const slugSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
// Empty array is valid: means "unlink all monitors from this page".
const idListSchema = z.array(z.number().int().positive()).max(500);

// ponytail: hostname is validated by parsing, not by hand-rolled regex. A bare
// hostname with no scheme parses under a synthetic http URL; anything with a
// scheme/path/port/wildcard/IP literal/localhost/punycode-failure is rejected.
const CUSTOM_HOSTNAME_MAX_LENGTH = 253;

const RESERVED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.test', '.example', '.invalid'];
const RESERVED_HOSTNAME_EXACT = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  'local',
  'internal',
]);

function isIpLiteral(hostname: string): boolean {
  // IPv4: dotted quad of 0-255.
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255);
  }
  // IPv6: anything wrapped in brackets or containing a colon is treated as an IP literal.
  return hostname.startsWith('[') || hostname.includes(':');
}

export function normalizeCustomHostname(value: string): string | null {
  const trimmed = String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed || trimmed.length > CUSTOM_HOSTNAME_MAX_LENGTH) return null;

  // Reject anything that looks like a URL (scheme, path, query, fragment, port, auth).
  if (/[/?#]/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) return null;
  if (trimmed.includes('@')) return null;
  if (trimmed.includes(' ')) return null;
  if (trimmed.includes('*')) return null;

  if (isIpLiteral(trimmed)) return null;

  if (RESERVED_HOSTNAME_EXACT.has(trimmed)) return null;
  if (RESERVED_HOSTNAME_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))) return null;

  // Validate as a hostname by parsing under a synthetic http URL. This rejects
  // invalid characters, empty labels, and structural issues. We do NOT require
  // URL round-trip equality because the URL parser decodes punycode (xn--...)
  // to Unicode; valid punycode labels are accepted as-is.
  try {
    new URL(`http://${trimmed}`);
  } catch {
    return null;
  }
  // Reject labels that are empty or over 63 chars.
  const labels = trimmed.split('.');
  if (labels.some((label) => !label || label.length > 63)) return null;
  // Each label must be alphanumeric/hyphen, not start/end with hyphen.
  // Punycode labels (xn--) and plain ASCII labels both pass this.
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  // Reject any non-ASCII characters; only canonical ASCII/punycode is stored.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Parse a raw `custom_hostname` input into a canonical stored value.
 *
 * - `null` / `undefined` / `''` -> `null` (clears the binding)
 * - valid hostname -> canonical lowercase ASCII string
 * - anything else -> throws a Zod error
 */
export function parseCustomHostnameInput(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizeCustomHostname(String(value));
}

export const CUSTOM_HOSTNAME_ERROR = 'custom_hostname must be a bare ASCII hostname (no scheme, path, port, wildcard, IP, or localhost)';

const LOGO_URL_MAX_LENGTH = 2048;

/**
 * Parse a raw `logo_url` input into a canonical stored value.
 *
 * - `null` / `undefined` / `''` -> `null` (clears the logo)
 * - absolute `http:` / `https:` URL with no credentials and <= 2048 chars -> the trimmed URL
 * - anything else -> `null` (caller surfaces the error as a 400)
 *
 * The Worker never fetches this URL; it is rendered only by visitors' browsers.
 */
export function parseLogoUrlInput(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0 || trimmed.length > LOGO_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (!parsed.hostname) return null;
  return trimmed;
}

export const LOGO_URL_ERROR = 'logo_url must be an absolute http(s) URL of at most 2048 characters';

export const createStatusPageInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  is_public: z.boolean().optional().default(true),
  custom_hostname: z.union([z.string(), z.null()]).optional().default(null),
  logo_url: z.union([z.string(), z.null()]).optional().default(null),
  monitor_ids: idListSchema.optional().default([]),
});

export const patchStatusPageInputSchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    is_public: z.boolean().optional(),
    custom_hostname: z.union([z.string(), z.null()]).optional(),
    logo_url: z.union([z.string(), z.null()]).optional(),
    monitor_ids: idListSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided' });
