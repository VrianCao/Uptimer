import { AppError } from '../middleware/errors';

export type PublicStatusPage = {
  id: number;
  slug: string;
  name: string;
  title: string;
  description: string;
  custom_hostname: string | null;
  logo_url: string | null;
};

type StatusPageRow = PublicStatusPage & { is_public: number };

export type AccessibleStatusPage = PublicStatusPage & { is_private: boolean };

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function resolvePublicStatusPage(
  db: D1Database,
  slug: string,
): Promise<PublicStatusPage> {
  if (!slugPattern.test(slug)) {
    throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  }

  const page = await db
    .prepare(
      `
        SELECT id, slug, name, title, description, custom_hostname, logo_url
        FROM status_pages
        WHERE slug = ?1 AND is_public = 1
      `,
    )
    .bind(slug)
    .first<PublicStatusPage>();
  if (!page) throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  return page;
}

export async function resolveAccessibleStatusPage(
  db: D1Database,
  slug: string,
  isAdmin: boolean,
): Promise<AccessibleStatusPage> {
  if (!slugPattern.test(slug)) {
    throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  }

  const row = await db
    .prepare(
      `
        SELECT id, slug, name, title, description, custom_hostname, logo_url, is_public
        FROM status_pages
        WHERE slug = ?1
      `,
    )
    .bind(slug)
    .first<StatusPageRow>();
  if (!row || (row.is_public === 0 && !isAdmin)) {
    throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  }

  const { is_public, ...page } = row;
  return { ...page, is_private: is_public === 0 };
}

export async function resolveOptionalAccessibleStatusPage(
  db: D1Database,
  slug: string | undefined,
  isAdmin: boolean,
): Promise<AccessibleStatusPage | undefined> {
  return slug === undefined ? undefined : await resolveAccessibleStatusPage(db, slug, isAdmin);
}

export async function resolveDefaultPublicStatusPage(db: D1Database): Promise<PublicStatusPage> {
  return await resolvePublicStatusPage(db, 'default');
}

export async function resolveAccessibleStatusPageById(
  db: D1Database,
  id: number,
  isAdmin: boolean,
): Promise<AccessibleStatusPage> {
  const row = await db
    .prepare(
      `
        SELECT id, slug, name, title, description, custom_hostname, logo_url, is_public
        FROM status_pages
        WHERE id = ?1
      `,
    )
    .bind(id)
    .first<StatusPageRow>();
  if (!row || (row.is_public === 0 && !isAdmin)) {
    throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  }

  const { is_public, ...page } = row;
  return { ...page, is_private: is_public === 0 };
}

export async function resolvePublicStatusPageById(
  db: D1Database,
  id: number,
): Promise<PublicStatusPage> {
  const page = await db
    .prepare(
      `
        SELECT id, slug, name, title, description, custom_hostname, logo_url
        FROM status_pages
        WHERE id = ?1 AND is_public = 1
      `,
    )
    .bind(id)
    .first<PublicStatusPage>();
  if (!page) throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  return page;
}

export async function resolveOptionalPublicStatusPage(
  db: D1Database,
  slug: string | undefined,
): Promise<PublicStatusPage | undefined> {
  return slug === undefined ? undefined : await resolvePublicStatusPage(db, slug);
}

export async function listStatusPageMonitorIds(
  db: D1Database,
  statusPageId: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(monitorIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ');
  const { results } = await db
    .prepare(
      `
        SELECT monitor_id
        FROM status_page_monitors
        WHERE status_page_id = ?1
          AND monitor_id IN (${placeholders})
      `,
    )
    .bind(statusPageId, ...ids)
    .all<{ monitor_id: number }>();

  return new Set((results ?? []).map((row) => row.monitor_id));
}

export async function assertStatusPageMonitor(
  db: D1Database,
  statusPageId: number,
  monitorId: number,
): Promise<{ id: number }> {
  const monitor = await db
    .prepare(
      `
        SELECT m.id
        FROM monitors m
        JOIN status_page_monitors spm ON spm.monitor_id = m.id
        WHERE spm.status_page_id = ?1
          AND m.id = ?2
          AND m.is_active = 1
      `,
    )
    .bind(statusPageId, monitorId)
    .first<{ id: number }>();
  if (!monitor) throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  return monitor;
}

/**
 * Resolve a single public status page by its bound custom hostname.
 *
 * Returns only routing-safe public metadata. Throws `NOT_FOUND` for unknown,
 * cleared, or non-public bindings so Pages can fail closed without falling
 * back to the default page.
 */
export async function resolvePublicStatusPageByHostname(
  db: D1Database,
  hostname: string,
): Promise<PublicStatusPage> {
  const page = await db
    .prepare(
      `
        SELECT id, slug, name, title, description, custom_hostname, logo_url
        FROM status_pages
        WHERE custom_hostname = ?1 AND is_public = 1
      `,
    )
    .bind(hostname)
    .first<PublicStatusPage>();
  if (!page) throw new AppError(404, 'NOT_FOUND', 'Status page not found');
  return page;
}
