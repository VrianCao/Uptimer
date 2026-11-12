import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { configureRuntimeProfile } from './configure-runtime-profile.mjs';
import { resolvePagesApi } from './resolve-pages-api.mjs';
import { assertTarget, sha256, revision } from './release-contract.mjs';
export async function migrationFiles(root) {
  const dir = join(root, 'apps/worker/migrations');
  return Promise.all(
    (await readdir(dir))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .map(async (name) => ({ name, sha256: sha256(await readFile(join(dir, name))) })),
  );
}
export function targetInput(env, subdomain) {
  const repository = env.GITHUB_REPOSITORY,
    slug = repository
      ?.split('/')[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');
  const worker = env.UPTIMER_WORKER_NAME || env.UPTIMER_PREFIX || slug;
  const workerUrl = env.UPTIMER_WORKER_URL || `https://${worker}.${subdomain}.workers.dev`;
  const hosting =
    env.RELEASE_HOSTING === 'auto' || !env.RELEASE_HOSTING
      ? env.UPTIMER_DEPLOY_MODE || 'pages'
      : env.RELEASE_HOSTING;
  const profile =
    env.RELEASE_PROFILE === 'auto' || !env.RELEASE_PROFILE
      ? env.UPTIMER_RUNTIME_PROFILE || 'free'
      : env.RELEASE_PROFILE;
  const api =
    hosting === 'single_worker'
      ? { apiBase: '/api/v1', apiOrigin: workerUrl }
      : resolvePagesApi({
          apiBase: env.UPTIMER_API_BASE,
          apiOrigin: env.UPTIMER_API_ORIGIN,
          workerUrl,
        });
  return assertTarget(
    {
      repository,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      worker,
      database: env.UPTIMER_D1_NAME || env.UPTIMER_PREFIX || slug,
      databaseId: env.UPTIMER_D1_ID || null,
      pages: env.UPTIMER_PAGES_PROJECT || env.UPTIMER_PREFIX || slug,
      hosting,
      profile,
      operation: env.RELEASE_OPERATION || 'upgrade',
      workerUrl,
      ...api,
    },
    repository,
  );
}
export async function deploymentConfig(root, target, sourceSha, databaseId) {
  revision.parse(sourceSha);
  const text = configureRuntimeProfile(
    await readFile(join(root, 'apps/worker/wrangler.toml'), 'utf8'),
    target.profile,
  );
  // Python's standard-library TOML parser avoids a second configuration dependency.
  const cfg = JSON.parse(
    execFileSync(
      'python3',
      ['-c', 'import sys,tomllib,json;json.dump(tomllib.loads(sys.stdin.read()),sys.stdout)'],
      { input: text, encoding: 'utf8' },
    ),
  );
  if (cfg.d1_databases?.length !== 1 || cfg.d1_databases[0].binding !== 'DB')
    throw Error('The application requires its canonical DB binding');
  if (Object.keys(cfg.vars ?? {}).some((k) => /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)/i.test(k)))
    throw Error('Plaintext secrets are not allowed in deployment vars');
  cfg.name = target.worker;
  cfg.account_id = target.accountId;
  cfg.main = join(root, 'apps/worker/src/worker-entry.ts');
  cfg.d1_databases = [
    {
      ...cfg.d1_databases[0],
      database_name: target.database,
      database_id: databaseId || '00000000-0000-4000-8000-000000000000',
      migrations_dir: join(root, 'apps/worker/migrations'),
    },
  ];
  cfg.services = [{ binding: 'SELF', service: target.worker }];
  cfg.vars = { ...cfg.vars, UPTIMER_BUILD_SHA: sourceSha };
  delete cfg.assets;
  if (target.hosting === 'single_worker')
    cfg.assets = {
      directory: '../web',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    };
  if (target.repository === 'VrianCao/UptimerDev' && target.profile === 'free')
    cfg.limits = { ...cfg.limits, cpu_ms: 30000 };
  return cfg;
}
export async function treeHashes(dir, prefix = '') {
  const files = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(dir, item.name),
      key = prefix + item.name;
    if (item.isSymbolicLink()) throw Error('Release artifacts cannot contain symlinks');
    if (item.isDirectory()) Object.assign(files, await treeHashes(p, key + '/'));
    else if (item.isFile()) files[key] = sha256(await readFile(p));
  }
  return files;
}
export async function writeJson(file, value) {
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function verifyPackage(dir, manifest) {
  const actual = await treeHashes(dir);
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || actual[path] !== hash)
      throw Error('Release artifact hash mismatch: ' + path);
  }
  const allowed = new Set([
    ...Object.keys(manifest.files),
    'manifest.json',
    'plan.json',
    'checkpoint.json',
    'verification.json',
  ]);
  if (Object.keys(actual).some((path) => !allowed.has(path)))
    throw Error('Unmanifested release files found');
  return true;
}
export function portableConfig(cfg, dir) {
  return {
    ...cfg,
    main: 'worker-entry.js',
    minify: false,
    d1_databases: cfg.d1_databases.map((db) => ({ ...db, migrations_dir: '../migrations' })),
    ...(cfg.assets
      ? {
          assets: {
            ...cfg.assets,
            directory: relative(join(dir, 'worker'), join(dir, 'web')).replaceAll('\\', '/'),
          },
        }
      : {}),
  };
}
