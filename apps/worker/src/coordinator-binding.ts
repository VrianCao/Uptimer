import type { Env } from './env';
import { runtimeProfile } from './runtime-profile';

export const SITE_COORDINATOR_NAME = 'site';

export function getSiteCoordinator(env: Pick<Env, 'COORDINATOR' | 'UPTIMER_RUNTIME_PROFILE'>) {
  if (runtimeProfile(env.UPTIMER_RUNTIME_PROFILE) === 'paid') return undefined;
  return env.COORDINATOR?.getByName(SITE_COORDINATOR_NAME);
}
