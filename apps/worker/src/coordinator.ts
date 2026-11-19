import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from './env';
import app from './index';
import { legacyMaintenanceResponse, withLegacyWriter } from './legacy-upgrade';
import { SITE_COORDINATOR_NAME } from './coordinator-binding';
import { runCoordinatedInvocation } from './internal/coordinated-execution';
import { queuePublicHomepageSnapshotRefresh } from './public/queue-refresh';

const scheduledSchema = z.object({
  cron: z.string().min(1).max(128),
  scheduledTime: z.number().int().nonnegative(),
});

// One object per single-tenant site's scheduling/publication unit. D1 remains
// canonical storage; no essential state, alarms or extra sample copies live here.
export class SiteCoordinator extends DurableObject<Env> {
  private execute<T>(task: (env: Env, ctx: ExecutionContext) => Promise<T>, drain: boolean) {
    if (!this.env.COORDINATOR) throw new Error('Coordinator binding missing');
    const env: Env = {
      ...this.env,
      SELF: this.env.SELF ?? this.env.COORDINATOR.getByName(SITE_COORDINATOR_NAME),
    };
    return runCoordinatedInvocation(
      {
        env: withLegacyWriter(env),
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        dispatch: (request) => {
          if (!this.env.COORDINATOR) throw new Error('Coordinator binding missing');
          return this.env.COORDINATOR.getByName(SITE_COORDINATOR_NAME).fetch(request);
        },
        fetch: (request, env, ctx) => app.fetch(request, env, ctx),
      },
      task,
      drain,
    );
  }

  async scheduled(input: unknown): Promise<void> {
    if (this.env.UPTIMER_MAINTENANCE === '1') return;
    const controller = scheduledSchema.parse(input);
    await this.execute(
      (env, ctx) => app.scheduled({ ...controller, noRetry() {} }, env, ctx),
      true,
    );
  }

  async refresh(): Promise<void> {
    if (this.env.UPTIMER_MAINTENANCE === '1') return;
    await this.execute(async (env, executionCtx) => {
      queuePublicHomepageSnapshotRefresh({ env, executionCtx });
    }, true);
  }

  async fetch(request: Request): Promise<Response> {
    if (this.env.UPTIMER_MAINTENANCE === '1') return legacyMaintenanceResponse(request, this.env);
    const url = new URL(request.url);
    const internal = url.hostname === 'internal';
    const apiRequest = /^\/api\/v1\/(public|admin)(?:\/|$)/.test(url.pathname);
    if (!internal && !apiRequest) return new Response(null, { status: 404 });
    // Public responses must not wait for cache puts, refreshes or notifications.
    return this.execute((env, ctx) => app.fetch(request, env, ctx), internal);
  }
}
