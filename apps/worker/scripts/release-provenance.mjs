import { z } from 'zod';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, revision } from './release-contract.mjs';
export async function checkProvenance(env, request = fetch) {
  z.enum(['plan', 'apply']).parse(env.RELEASE_ACTION);
  z.enum(['upgrade', 'install']).parse(env.RELEASE_OPERATION);
  if (env.RELEASE_ACTION === 'plan') return;
  digest.parse(env.RELEASE_PLAN_SHA);
  z.string()
    .regex(/^[1-9][0-9]*$/)
    .parse(env.RELEASE_PLAN_RUN);
  revision.parse(env.GITHUB_SHA);
  const response = await request(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.RELEASE_PLAN_RUN}`,
    {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw Error('Cannot verify plan workflow provenance');
  const run = await response.json();
  if (
    run.repository?.full_name !== env.GITHUB_REPOSITORY ||
    run.head_sha !== env.GITHUB_SHA ||
    run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/deploy.yml'
  )
    throw Error(
      'Apply needs a successful manual plan from deploy.yml in this repository at the exact same revision',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkProvenance(process.env);
