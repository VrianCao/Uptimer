import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const configSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  projectName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  apiOrigin: z.string().url(),
  apiBase: z.string().min(1),
});
const projectSchema = z.object({
  name: z.string(),
  deployment_configs: z.object({
    production: z.object({ env_vars: z.record(z.unknown()).nullish() }),
  }),
});
export async function configurePagesProxy(input, effects) {
  const config = configSchema.parse(input);
  const origin = new URL(config.apiOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.apiOrigin)
    throw Error('Deployment backend must be an HTTPS origin');
  const project = projectSchema.parse(await effects.readProject(config));
  if (project.name !== config.projectName) throw Error('Pages project mismatch');
  const pinned =
    project.deployment_configs.production.env_vars?.UPTIMER_API_SENSITIVE_ORIGIN != null;
  await effects.putSecret(config, 'UPTIMER_API_ORIGIN', config.apiOrigin);
  if (config.apiBase.startsWith('/') && !pinned)
    await effects.putSecret(config, 'UPTIMER_API_SENSITIVE_ORIGIN', config.apiOrigin);
  return {
    project: config.projectName,
    sameOrigin: config.apiBase.startsWith('/'),
    preservedSensitiveOrigin: pinned,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN);
  const result = await configurePagesProxy(
    {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      projectName: process.env.PAGES_PROJECT,
      apiOrigin: process.env.UPTIMER_RESOLVED_API_ORIGIN,
      apiBase: process.env.UPTIMER_RESOLVED_API_BASE,
    },
    {
      async readProject(config) {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
        );
        const body = await response.json();
        if (!response.ok || !body.success)
          throw Error(`Cannot inspect Pages configuration (${response.status})`);
        return body.result;
      },
      async putSecret(config, name, value) {
        execFileSync(
          'pnpm',
          [
            '-C',
            'apps/worker',
            'exec',
            'wrangler',
            '--cwd',
            '../..',
            'pages',
            'secret',
            'put',
            name,
            '--project-name',
            config.projectName,
          ],
          { input: value, stdio: ['pipe', 'inherit', 'inherit'] },
        );
      },
    },
  );
  console.log(JSON.stringify(result));
}
