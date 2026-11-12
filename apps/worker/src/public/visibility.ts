const D1_ID_CHUNK_SIZE = 200;

function normalizePositiveIntegerIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

export function buildNumberedPlaceholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, idx) => `?${idx + startIndex}`).join(', ');
}

export function chunkPositiveIntegerIds(ids: number[], chunkSize = D1_ID_CHUNK_SIZE): number[][] {
  const normalizedIds = normalizePositiveIntegerIds(ids);
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));

  const chunks: number[][] = [];
  for (let idx = 0; idx < normalizedIds.length; idx += safeChunkSize) {
    chunks.push(normalizedIds.slice(idx, idx + safeChunkSize));
  }

  return chunks;
}

export function monitorVisibilityPredicate(includeHiddenMonitors: boolean, alias?: string): string {
  const column = alias ? `${alias}.show_on_status_page` : 'show_on_status_page';
  return includeHiddenMonitors ? '1 = 1' : `${column} = 1`;
}

function statusPageScopedItemVisibilityPredicate(
  includeHiddenMonitors: boolean,
  itemAlias: string,
  linkTable: string,
  linkItemColumn: string,
): string {
  if (includeHiddenMonitors) return '1 = 1';

  return `
    (
      (${itemAlias}.scope = 'global' AND NOT EXISTS (
        SELECT 1
        FROM ${linkTable} scoped_links
        WHERE scoped_links.${linkItemColumn} = ${itemAlias}.id
      ))
      OR EXISTS (
        SELECT 1
        FROM ${linkTable} scoped_links
        JOIN monitors scoped_monitors ON scoped_monitors.id = scoped_links.monitor_id
        WHERE scoped_links.${linkItemColumn} = ${itemAlias}.id
          AND ${monitorVisibilityPredicate(false, 'scoped_monitors')}
      )
    )
  `;
}

export function incidentStatusPageVisibilityPredicate(
  includeHiddenMonitors: boolean,
  alias = 'incidents',
): string {
  return statusPageScopedItemVisibilityPredicate(
    includeHiddenMonitors,
    alias,
    'incident_monitors',
    'incident_id',
  );
}

export function maintenanceWindowStatusPageVisibilityPredicate(
  includeHiddenMonitors: boolean,
  alias = 'maintenance_windows',
): string {
  return statusPageScopedItemVisibilityPredicate(
    includeHiddenMonitors,
    alias,
    'maintenance_window_monitors',
    'maintenance_window_id',
  );
}

export async function listStatusPageVisibleMonitorIds(
  db: D1Database,
  monitorIds: number[],
): Promise<Set<number>> {
  const visibleMonitorIds = new Set<number>();

  for (const ids of chunkPositiveIntegerIds(monitorIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT id
          FROM monitors
          WHERE id IN (${placeholders})
            AND show_on_status_page = 1
        `,
      )
      .bind(...ids)
      .all<{ id: number }>();

    for (const row of results ?? []) {
      visibleMonitorIds.add(row.id);
    }
  }

  return visibleMonitorIds;
}

export function filterStatusPageScopedMonitorIds(
  monitorIds: number[],
  visibleMonitorIds: Set<number>,
  includeHiddenMonitors: boolean,
): number[] {
  return includeHiddenMonitors ? monitorIds : monitorIds.filter((id) => visibleMonitorIds.has(id));
}

export function shouldIncludeStatusPageScopedItem(
  originalMonitorIds: number[],
  visibleMonitorIds: number[],
): boolean {
  return originalMonitorIds.length === 0 || visibleMonitorIds.length > 0;
}
