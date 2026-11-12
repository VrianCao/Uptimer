import type { Env } from '../env';

function enabled(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

export function usesBoundedPublicSeeds(env: Env): boolean {
  return (
    enabled(env.UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH) &&
    enabled(env.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED)
  );
}

export function usesCombinedPublicSeeds(env: Env): boolean {
  return usesBoundedPublicSeeds(env) && enabled(env.UPTIMER_PUBLIC_COMBINED_SEED);
}

export function usesAtomicPublicPublication(env: Env): boolean {
  return (
    usesCombinedPublicSeeds(env) &&
    env.UPTIMER_SHARDED_ASSEMBLER_MODE?.trim().toLowerCase() === 'json' &&
    enabled(env.UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES)
  );
}
