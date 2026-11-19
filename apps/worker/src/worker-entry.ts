import app from './index';
import type { Env } from './env';
import { legacyMaintenanceResponse, withLegacyWriter } from './legacy-upgrade';
export { SiteCoordinator } from './coordinator';

export default {
  fetch(request, env, ctx) {
    if (env.UPTIMER_MAINTENANCE === '1') return legacyMaintenanceResponse(request, env);
    return app.fetch(request, withLegacyWriter(env), ctx);
  },
  scheduled(controller, env, ctx) {
    if (env.UPTIMER_MAINTENANCE === '1') return;
    return app.scheduled(controller, withLegacyWriter(env), ctx);
  },
} satisfies ExportedHandler<Env>;
