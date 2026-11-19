import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() || undefined : value),
  z
    .string()
    .regex(/^[^\r\n]+$/)
    .optional(),
);
const inputSchema = z.object({
  apiBase: optionalText,
  apiOrigin: optionalText,
  workerUrl: optionalText,
});
function absoluteUrl(value) {
  const url = z.string().url().parse(value);
  const parsed = new URL(url);
  if (
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw Error('API URL must be HTTPS (or local HTTP), without credentials, query or fragment');
  return parsed;
}
export function resolvePagesApi(input) {
  const { apiBase, apiOrigin, workerUrl } = inputSchema.parse(input);
  if (apiBase && !apiBase.startsWith('/')) absoluteUrl(apiBase);
  if (apiBase?.startsWith('//')) throw Error('Protocol-relative API base is not supported');
  const explicitOrigin = apiOrigin ? absoluteUrl(apiOrigin) : null;
  const baseOrigin = apiBase && !apiBase.startsWith('/') ? absoluteUrl(apiBase) : null;
  const backend = explicitOrigin ?? baseOrigin ?? (workerUrl ? absoluteUrl(workerUrl) : null);
  if (!backend) throw Error('Pages API proxy requires a known backend origin');
  // Preserve explicit endpoints. The ordinary deployment keeps browser traffic
  // on Pages, avoiding another DNS/TLS connection and workers.dev availability.
  const trimmedOrigin = apiOrigin?.replace(/\/+$/, '');
  const resolvedBase =
    apiBase ??
    (trimmedOrigin
      ? trimmedOrigin.endsWith('/api/v1')
        ? trimmedOrigin
        : `${trimmedOrigin}/api/v1`
      : '/api/v1');
  return { apiBase: resolvedBase.replace(/\/+$/, ''), apiOrigin: backend.origin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = resolvePagesApi({
    apiBase: process.env.UPTIMER_API_BASE,
    apiOrigin: process.env.UPTIMER_API_ORIGIN,
    workerUrl: process.env.WORKER_URL,
  });
  if (!process.env.GITHUB_ENV) throw Error('GITHUB_ENV is required');
  await appendFile(
    process.env.GITHUB_ENV,
    `VITE_API_BASE=${config.apiBase}\nUPTIMER_RESOLVED_API_BASE=${config.apiBase}\nUPTIMER_RESOLVED_API_ORIGIN=${config.apiOrigin}\n`,
  );
  console.log(JSON.stringify(config));
}
