import { z } from 'zod';
import { assertTarget } from './release-contract.mjs';
export class ReleaseCloud {
  constructor(target, token, { readOnly = true } = {}) {
    this.readOnly = readOnly;
    this.target = assertTarget(target, target.repository);
    this.token = z.string().min(1).parse(token);
  }
  async request(path, { method = 'GET', body, missing = false, raw = false } = {}) {
    const t = this.target,
      base = `https://api.cloudflare.com/client/v4/accounts/${t.accountId}`;
    const allowed =
      path === '/workers/subdomain' ||
      path === '/d1/database' ||
      path === `/d1/database?name=${t.database}&per_page=100` ||
      path === `/pages/projects/${t.pages}` ||
      path === '/pages/projects' ||
      new RegExp(
        `^/workers/scripts/${t.worker}/(?:settings|deployments|versions(?:/[a-f0-9-]{36})?|schedules|tails(?:/[a-f0-9-]{32,36})?)$`,
      ).test(path) ||
      new RegExp('^/d1/database/[a-f0-9-]{36}(?:/query|/time_travel/bookmark)?$').test(path);
    if (!allowed) throw Error('Release API scope guard failed');
    const queryPath = /^\/d1\/database\/[a-f0-9-]{36}\/query$/.test(path);
    const supportedMutation =
      (method === 'POST' &&
        queryPath &&
        /^\s*(SELECT|WITH)\b/i.test(body?.sql ?? '') &&
        !/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA)\b/i.test(body.sql)) ||
      (method === 'POST' &&
        path === '/d1/database' &&
        t.operation === 'install' &&
        body?.name === t.database) ||
      (method === 'POST' && path === '/pages/projects' && body?.name === t.pages);
    if (this.readOnly && method !== 'GET' && !queryPath)
      throw Error('Plan cannot mutate Cloudflare');
    if (method !== 'GET' && !supportedMutation) throw Error('Release mutation guard failed');

    if (
      path.startsWith('/d1/database/') &&
      this.target.databaseId &&
      !path.startsWith('/d1/database/' + t.databaseId)
    )
      throw Error('D1 identity guard failed');
    const r = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    if (raw) {
      if (!r.ok) throw Error('Cannot read the existing Worker bundle');
      return r;
    }
    if (missing && r.status === 404) return null;
    const b = await r.json();
    if (!r.ok || !b.success)
      throw Error(
        `Scoped Cloudflare API failed: ${r.status} ${b.errors?.map((e) => e.code).join(',') ?? ''}`,
      );
    return b.result;
  }
  async sql(text, params = []) {
    if (!this.target.databaseId) throw Error('Missing exact database ID');
    if (
      !/^\s*(SELECT|WITH)/i.test(text) ||
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA)\b/i.test(text)
    )
      throw Error('Read-only SQL guard');
    const result = (
      await this.request(`/d1/database/${this.target.databaseId}/query`, {
        method: 'POST',
        body: { sql: text, params },
      })
    )[0];
    if (result.meta.rows_written !== 0) throw Error('Unexpected SQL write');
    return result;
  }
  async inspect() {
    const t = this.target;
    const databases = t.databaseId
      ? [await this.request('/d1/database/' + t.databaseId)]
      : await this.request(`/d1/database?name=${t.database}&per_page=100`);
    if (!Array.isArray(databases)) throw Error('Unexpected D1 metadata');
    const matches = databases.filter((db) => db.name === t.database);
    if (matches.length > 1) throw Error('Ambiguous database name');
    const db = matches[0] ?? null,
      id = db?.uuid ?? db?.id ?? null;
    if (t.databaseId && id !== t.databaseId) throw Error('Configured D1 ID/name does not match');
    if (id) this.target.databaseId = id;
    const workerInfo = await this.request(`/workers/scripts/${t.worker}/settings`, {
      missing: true,
    });
    let worker = null;
    if (workerInfo) {
      const deps = await this.request(`/workers/scripts/${t.worker}/deployments`),
        active = deps.deployments[0];
      if (active.versions.length !== 1 || active.versions[0].percentage !== 100)
        throw Error('Gradual deployments must be resolved before upgrading');
      const versions = await this.request(`/workers/scripts/${t.worker}/versions`);
      if (versions.items?.[0]?.id !== active.versions[0].version_id)
        throw Error('An undeployed Worker version exists; resolve it before release');
      const versionId = active.versions[0].version_id,
        v = await this.request(`/workers/scripts/${t.worker}/versions/${versionId}`),
        bindings = v.resources.bindings,
        value = (n) => bindings.find((b) => b.name === n)?.text;
      if (bindings.find((b) => b.name === 'DB')?.id !== id)
        throw Error('Worker is attached to a different database');
      const crons = (await this.request(`/workers/scripts/${t.worker}/schedules`)).schedules
        .map((s) => s.cron)
        .sort();
      worker = {
        versionId,
        sourceSha: value('UPTIMER_BUILD_SHA') ?? null,
        fingerprint: value('UPTIMER_RELEASE_FINGERPRINT') ?? null,
        profile: value('UPTIMER_RUNTIME_PROFILE') ?? 'free',
        databaseId: id,
        hosting: bindings.some((b) => b.name === 'ASSETS') ? 'single_worker' : 'pages',
        secretNames: bindings
          .filter((b) => b.type === 'secret_text')
          .map((b) => b.name)
          .sort(),
        configuration: {
          vars: Object.fromEntries(
            bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]),
          ),
          selfService: bindings.find((b) => b.name === 'SELF')?.service,
          coordinatorBound: bindings.some((b) => b.name === 'COORDINATOR'),
          assetsBound: bindings.some((b) => b.name === 'ASSETS'),
          cpuMs: v.resources.script_runtime.limits?.cpu_ms,
          crons,
        },
      };
    }
    const project =
      t.hosting === 'pages'
        ? await this.request(`/pages/projects/${t.pages}`, { missing: true })
        : null;
    const pages = project
      ? {
          projectId: z.string().min(1).parse(project.id),
          deploymentId: project.canonical_deployment?.id ?? null,
          sourceSha:
            project.canonical_deployment?.deployment_trigger?.metadata?.commit_hash ?? null,
          fingerprint:
            project.canonical_deployment?.deployment_trigger?.metadata?.commit_message?.startsWith(
              'uptimer-release:',
            )
              ? project.canonical_deployment.deployment_trigger.metadata.commit_message.slice(
                  'uptimer-release:'.length,
                )
              : null,
          productionBranch: project.production_branch,
          project,
        }
      : null;
    let appliedMigrations = [],
      emptyProjectDatabase = true;
    if (id) {
      const tables = (
        await this.sql(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
      ).results;
      if (tables.some((row) => row.name === 'd1_migrations'))
        appliedMigrations = (
          await this.sql('SELECT name FROM d1_migrations ORDER BY id')
        ).results.map((row) => row.name);
      const hasMonitors = tables.some((row) => row.name === 'monitors');
      if (hasMonitors && !tables.some((row) => row.name === 'd1_migrations'))
        throw Error('Recognized migration tracker is required for an existing application schema');
      if (hasMonitors) {
        // A zero monitor count alone does not prove the absence of user data.
        // The finite allowlist keeps table names out of interpolated SQL.
        const dataQueries = {
          monitors: 'SELECT 1 n FROM monitors LIMIT 1',
          monitor_state: 'SELECT 1 n FROM monitor_state LIMIT 1',
          check_results: 'SELECT 1 n FROM check_results LIMIT 1',
          check_result_buckets: 'SELECT 1 n FROM check_result_buckets LIMIT 1',
          monitor_daily_rollups: 'SELECT 1 n FROM monitor_daily_rollups LIMIT 1',
          incidents: 'SELECT 1 n FROM incidents LIMIT 1',
          maintenance_windows: 'SELECT 1 n FROM maintenance_windows LIMIT 1',
          notification_channels: 'SELECT 1 n FROM notification_channels LIMIT 1',
          notification_deliveries: 'SELECT 1 n FROM notification_deliveries LIMIT 1',
          outages: 'SELECT 1 n FROM outages LIMIT 1',
        };
        for (const [table, query] of Object.entries(dataQueries)) {
          if (tables.some((row) => row.name === table) && (await this.sql(query)).results.length) {
            emptyProjectDatabase = false;
            break;
          }
        }
      } else if (tables.some((row) => row.name !== 'd1_migrations'))
        throw Error('Existing database is not an empty or recognized Uptimer schema');
    }
    return { databaseId: id, appliedMigrations, emptyProjectDatabase, worker, pages };
  }
}
