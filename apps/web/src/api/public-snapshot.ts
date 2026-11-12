import {
  storedPublicHomepageResponseSchema,
  publicDisplayUrlSchema,
} from '@uptimer/shared/public-homepage-stored';
import { storedPublicStatusResponseSchema } from '@uptimer/shared/public-status-stored';
import type { PublicHomepageResponse, StatusResponse } from './types';

export const LEGACY_STATUS_STORAGE_KEY = 'uptimer_public_status_snapshot_v1';
export const HOMEPAGE_STORAGE_KEY = 'uptimer_public_homepage_snapshot_v2';
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

// Freshness belongs to the data, not to the time a cache happened to read it.
export function snapshotUpdatedAt(value: { generated_at: number }, now = Date.now()): number {
  const at = value.generated_at * 1000;
  return Number.isFinite(at) && at >= 0 && at <= now + 60_000 ? Math.min(at, now) : 0;
}

export function readHomepageSnapshot(now = Date.now()): PublicHomepageResponse | null {
  try {
    const raw = localStorage.getItem(HOMEPAGE_STORAGE_KEY);
    if (!raw) return null;
    const value = parseHomepageSnapshot((JSON.parse(raw) as { value?: unknown })?.value);
    if (!value) return null;
    const at = snapshotUpdatedAt(value, now);
    return at > 0 && now - at <= SNAPSHOT_MAX_AGE_MS ? value : null;
  } catch {
    return null;
  }
}

export function writeHomepageSnapshot(value: PublicHomepageResponse): void {
  try {
    localStorage.setItem(
      HOMEPAGE_STORAGE_KEY,
      JSON.stringify({ at: snapshotUpdatedAt(value), value }),
    );
  } catch {
    // Storage can be unavailable or full; it must never prevent a live update.
  }
}

export function newestHomepageSnapshot(
  ...candidates: unknown[]
): PublicHomepageResponse | undefined {
  return candidates.reduce<PublicHomepageResponse | undefined>((latest, candidate) => {
    const value = parseHomepageSnapshot(candidate);
    if (!value || !snapshotUpdatedAt(value)) return latest;
    return !latest || value.generated_at > latest.generated_at ? value : latest;
  }, undefined);
}

// The stored schemas validate every field without deep-cloning each nested
// heartbeat/day array. Preserve the existing display-URL catch(null) contract.
function normalizeDisplayUrls<T extends { monitors: Array<{ display_url?: string | null }> }>(
  data: T,
): T {
  let changed = false;
  const monitors = data.monitors.map((m) => {
    const url = m.display_url === null ? null : publicDisplayUrlSchema.parse(m.display_url);
    if (url === m.display_url) return m;
    changed = true;
    return { ...m, display_url: url };
  });
  return changed ? { ...data, monitors } : data;
}
export function parseHomepageSnapshot(value: unknown): PublicHomepageResponse | null {
  const parsed = storedPublicHomepageResponseSchema.safeParse(value);
  return parsed.success ? normalizeDisplayUrls(parsed.data) : null;
}
export function parseStatusSnapshot(value: unknown): StatusResponse | null {
  const parsed = storedPublicStatusResponseSchema.safeParse(value);
  return parsed.success ? normalizeDisplayUrls(parsed.data) : null;
}
export function readLegacyStatusSnapshot(
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
  now = Date.now(),
): StatusResponse | null {
  try {
    const raw = localStorage.getItem(LEGACY_STATUS_STORAGE_KEY);
    if (!raw) return null;
    const value = parseStatusSnapshot((JSON.parse(raw) as { value?: unknown })?.value);
    if (!value) return null;
    const at = snapshotUpdatedAt(value, now);
    return at > 0 && now - at <= maxAgeMs ? value : null;
  } catch {
    return null;
  }
}
