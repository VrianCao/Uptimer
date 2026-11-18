import { appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { targetInput, writeJson } from './release-config.mjs';
import { ReleaseCloud } from './release-cloud.mjs';
import { preparePackage, readJson } from './release-package.mjs';
import { applyRelease } from './release-apply.mjs';

export async function releaseMain(action, env = process.env) {
  if (!['plan', 'apply'].includes(action)) throw Error('Usage: release.mjs plan|apply');
  const root = resolve(env.GITHUB_WORKSPACE || process.cwd());
  const directory = resolve(
    env.RELEASE_DIRECTORY || join(env.RUNNER_TEMP || '/tmp', 'uptimer-release'),
  );
  const releaseEnv = { ...env, RELEASE_ROOT: root };
  let target = targetInput(releaseEnv, 'pending');
  const cloud = new ReleaseCloud(target, env.CLOUDFLARE_API_TOKEN, { readOnly: action === 'plan' });
  if (!env.UPTIMER_WORKER_URL) {
    const domain = await cloud.request('/workers/subdomain');
    if (!domain.subdomain)
      throw Error('Enable a workers.dev subdomain or configure UPTIMER_WORKER_URL');
    target = targetInput(releaseEnv, domain.subdomain);
    cloud.target = target;
  }
  if (action === 'plan') {
    const plan = await preparePackage({ root, directory, cloud, env: releaseEnv });
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `plan_hash=${plan.hash}\nblocked=${plan.blockers.length > 0}\n`,
      );
    const summary = [
      '### Reviewed release plan',
      '',
      `Source: \`${plan.sourceSha}\``,
      `Plan SHA-256: \`${plan.hash}\``,
      `Target: ${target.worker} / ${target.hosting} / ${target.profile}`,
      `Pending migrations: ${plan.steps.pendingMigrations.join(', ') || 'none'}`,
      'Remote mutations: **0** (metadata and read-only D1 queries only).',
      ...plan.blockers.map((b) => `- BLOCKED: ${b}`),
      '',
      'Inspect plan.json and manifest.json before applying. Apply requires this exact source revision and plan hash.',
      '',
    ].join('\n');
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
    return plan;
  }
  const [plan, manifest] = await Promise.all([
    readJson(join(directory, 'plan.json')),
    readJson(join(directory, 'manifest.json')),
  ]);
  if (!env.UPTIMER_ADMIN_TOKEN)
    throw Error('Admin credential is required before applying for read-only smoke verification');
  const checkpoint = await applyRelease({
    root,
    directory,
    plan,
    manifest,
    cloud,
    env: releaseEnv,
  });
  try {
    const smoke = await verifyRelease(plan, env.UPTIMER_ADMIN_TOKEN);
    await writeJson(join(directory, 'verification.json'), smoke);
  } catch (error) {
    await writeJson(join(directory, 'verification.json'), {
      passed: false,
      message: String(error.message).slice(0, 500),
      observedAt: new Date().toISOString(),
    });
    throw error;
  }
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### Release verification\n\nWorker: \`${checkpoint.after.worker.versionId}\`\n\nPages: \`${checkpoint.after.pages?.deploymentId ?? 'not used'}\`\n\nDeployment no-op: **${checkpoint.idempotentNoop}**. Public/auth/routing checks and two advancing publications passed.\n`,
    );
  return checkpoint;
}

const snapshot = z.object({ generated_at: z.number().int().nonnegative() }).passthrough();
export async function verifyRelease(
  plan,
  adminToken,
  {
    request = fetch,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    timeoutMs = 210000,
  } = {},
) {
  const t = plan.target;
  if (!adminToken)
    throw Error('UPTIMER_ADMIN_TOKEN is required for authenticated read-only verification');
  const app = t.hosting === 'pages' ? `https://${t.pages}.pages.dev` : t.workerUrl;
  async function read(url, expected = 200, headers = {}) {
    const r = await request(url, {
      headers: { 'Cache-Control': 'no-cache', ...headers },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (r.status !== expected) {
      await r.body?.cancel();
      const error = Error(
        `Release smoke failed (${r.status}, expected ${expected}) at ${new URL(url).pathname}`,
      );
      error.status = r.status;
      throw error;
    }
    return r;
  }
  const api = t.apiBase.startsWith('/') ? app + t.apiBase : t.apiBase;
  const html = await (await read(app + '/')).text();
  if (!html.includes('<div id="root"')) throw Error('Frontend root missing');
  const asset = html.match(/<script[^>]+src="([^"]+\.js)"/);
  if (!asset) throw Error('Built frontend entry missing');
  const assetUrl = new URL(asset[1], app);
  if (assetUrl.origin !== app) throw Error('Unexpected frontend entry origin');
  await read(assetUrl.href);
  await read(api + '/admin/monitors', 401);
  await read(app + '/api/v1/internal/scheduled', 404);
  // Never send an admin token through a proxy whose pre-existing trust pin is unknown.
  await read(t.workerUrl + '/api/v1/admin/monitors', 200, {
    Authorization: `Bearer ${adminToken}`,
  });
  const observations = [];
  let previous,
    warmedAt,
    advances = 0;
  const started = now();
  const warmupMs = plan.before?.worker === null ? 900000 : 0;
  while (now() - started <= warmupMs + timeoutMs) {
    if (warmedAt !== undefined && now() - warmedAt > timeoutMs) break;
    const round = {};
    try {
      for (const path of ['homepage', 'status', 'homepage-artifact']) {
        const body = snapshot.parse(await (await read(api + '/public/' + path)).json());
        const age = now() / 1000 - body.generated_at;
        if (age < -60 || age > 120) throw Error('Public data is stale or future-dated');
        round[path] = body.generated_at;
      }
    } catch (error) {
      // New Cron registrations can take up to 15 minutes to propagate. Only
      // an initial 502/503 during first install is retried, and never stale 200s.
      if (
        warmedAt === undefined &&
        now() - started < warmupMs &&
        [502, 503].includes(error.status)
      ) {
        await wait(15000);
        continue;
      }
      throw error;
    }
    if (warmedAt === undefined) warmedAt = now();
    // Requests can straddle a publication; one minute of skew is acceptable.
    if (Math.max(...Object.values(round)) - Math.min(...Object.values(round)) > 60)
      throw Error('Public representations diverged');
    const timestamp = Math.min(...Object.values(round));
    if (previous !== undefined && timestamp < previous) throw Error('Public data moved backwards');
    if (previous !== undefined && timestamp > previous) advances++;
    previous = timestamp;
    observations.push(round);
    if (advances >= 2)
      return {
        passed: true,
        observedAt: new Date(now()).toISOString(),
        advancingPublications: advances,
        initialWarmupMs: warmedAt - started,
        observations,
        adminViaWorker: true,
        adminViaPages: 'not exercised; validate trusted proxy separately',
      };
    await wait(15000);
  }
  throw Error('Two advancing public publications were not observed; do not expand release');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await releaseMain(process.argv[2]);
  } catch (error) {
    // API/CLI helpers deliberately avoid raw credentials and response bodies.
    console.error(error.message);
    process.exitCode = 1;
  }
}
