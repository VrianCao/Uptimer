import type { Env } from '../env';
import { getSiteCoordinator } from '../coordinator-binding';
import { usesBoundedPublicSeeds, usesCombinedPublicSeeds } from './refresh-profile';

export function queuePublicHomepageSnapshotRefresh(c: {
  env: Env;
  executionCtx: ExecutionContext;
}): void {
  const coordinator = getSiteCoordinator(c.env);
  if (coordinator) {
    c.executionCtx.waitUntil(
      coordinator.refresh().catch((error) => console.warn('public snapshot refresh failed', error)),
    );
    return;
  }
  c.executionCtx.waitUntil(
    (async () => {
      if (usesBoundedPublicSeeds(c.env) && c.env.SELF) {
        const monitorLimit = Math.max(
          1,
          Math.min(
            10,
            Number.parseInt(c.env.UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE ?? '6', 10) || 6,
          ),
        );
        await Promise.all(
          (usesCombinedPublicSeeds(c.env) ? ['homepage'] : ['homepage', 'status']).map(
            async (kind) => {
              const response = await c.env.SELF!.fetch(
                new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${c.env.ADMIN_TOKEN}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    step: 'seed',
                    kind,
                    part: 'envelope',
                    monitor_offset: 0,
                    monitor_limit: monitorLimit,
                  }),
                }),
              );
              await response.body?.cancel();
              if (!response.ok) throw new Error(`public refresh failed: HTTP ${response.status}`);
            },
          ),
        );
        return;
      }
      // Local dev without a SELF binding, and older/custom deployment profiles.
      const [{ refreshPublicHomepageSnapshotIfNeeded }, { computePublicHomepagePayload }] =
        await Promise.all([import('../snapshots'), import('./homepage')]);
      await refreshPublicHomepageSnapshotIfNeeded({
        db: c.env.DB,
        now: Math.floor(Date.now() / 1000),
        force: true,
        seedDataSnapshot: true,
        compute: () => computePublicHomepagePayload(c.env.DB, Math.floor(Date.now() / 1000)),
      });
    })().catch((error) => console.warn('public snapshot refresh failed', error)),
  );
}
