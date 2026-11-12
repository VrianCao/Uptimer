import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { targetInput, migrationFiles } from './release-config.mjs';
import { assertImmutableMigrationDiff } from './release-contract.mjs';
import { preparePackage } from './release-package.mjs';
export function checkMigrationHistory(root, base, head = 'HEAD') {
  const output = execFileSync(
    'git',
    ['diff', '--name-status', '--no-renames', base, head, '--', 'apps/worker/migrations'],
    { cwd: root, encoding: 'utf8' },
  );
  assertImmutableMigrationDiff(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((row) => {
        const [status, path] = row.split('\t');
        return { status, path };
      }),
  );
}
export async function offlineBuild(root, profile, hosting) {
  const temp = await mkdtemp(join(tmpdir(), 'uptimer-release-build-'));
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'ci/uptimer',
    GITHUB_SHA: process.env.GITHUB_SHA || '0'.repeat(40),
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    UPTIMER_D1_ID: '12345678-1234-4123-8123-123456789abc',
    UPTIMER_WORKER_URL: 'https://uptimer.ci.workers.dev',
    UPTIMER_PREFIX: 'uptimer',
    UPTIMER_WORKER_NAME: 'uptimer',
    UPTIMER_D1_NAME: 'uptimer',
    UPTIMER_PAGES_PROJECT: 'uptimer',
    RELEASE_OPERATION: 'upgrade',
    RELEASE_PROFILE: profile,
    RELEASE_HOSTING: hosting,
  };
  for (const key of [
    'UPTIMER_API_BASE',
    'UPTIMER_API_ORIGIN',
    'CLOUDFLARE_API_TOKEN',
    'UPTIMER_ADMIN_TOKEN',
    'GITHUB_TOKEN',
  ])
    delete env[key];
  const target = targetInput(env, 'ci');
  const cloud = {
    target,
    inspect: async () => ({
      databaseId: target.databaseId,
      appliedMigrations: (await migrationFiles(root)).map((m) => m.name),
      emptyProjectDatabase: false,
      worker: null,
      pages: null,
    }),
  };
  try {
    await preparePackage({ root, directory: join(temp, 'package'), cloud, env });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.cwd());
  if (process.argv[2] === 'migrations')
    checkMigrationHistory(root, process.argv[3], process.argv[4]);
  else await offlineBuild(root, process.argv[2], process.argv[3]);
}
