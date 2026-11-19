import { z } from 'zod';

const UPSERT_FRAGMENT_SQL = `
  INSERT INTO public_snapshot_fragments (
    snapshot_key,
    fragment_key,
    generated_at,
    body_json,
    updated_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(snapshot_key, fragment_key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshot_fragments.generated_at
    AND (
      excluded.generated_at != public_snapshot_fragments.generated_at
      OR excluded.body_json != public_snapshot_fragments.body_json
    )
`;

const READ_FRAGMENTS_SQL = `
  SELECT fragment_key,generated_at,
    CASE WHEN fragment_key LIKE 'page:%' AND json_valid(body_json) THEN (
      SELECT json_group_array(json_array(
        CASE WHEN j.type='array' THEN json_extract(j.value,'$[0]') END,
        CASE WHEN j.type!='array' THEN NULL
          WHEN ?1='homepage:artifact:monitors' THEN json_extract(j.value,
            CASE WHEN f.snapshot_key='homepage:artifact:monitors' THEN '$[1]' ELSE '$[2]' END)
          WHEN f.snapshot_key='public:monitors' AND ?1='status:monitors' THEN json_extract(j.value,'$[3]')
          ELSE json_extract(j.value,'$[1]') END
      )) FROM json_each(f.body_json) j
    ) ELSE body_json END AS body_json,updated_at
  FROM public_snapshot_fragments f
  WHERE (snapshot_key=?1
    OR (?1='homepage:artifact:monitors' AND snapshot_key='homepage:monitors' AND fragment_key LIKE 'page:%')
    OR (?1 IN ('homepage:monitors','status:monitors','homepage:artifact:monitors') AND snapshot_key='public:monitors'))
  ORDER BY fragment_key, CASE WHEN snapshot_key='public:monitors' THEN 1 ELSE 0 END
`;
const READ_CURRENT_FRAGMENTS_SQL = READ_FRAGMENTS_SQL.replace(
  '  ORDER BY fragment_key',
  '  AND generated_at=?2 ORDER BY fragment_key',
);

const READ_FRAGMENTS_PAGE_SQL = `
  SELECT fragment_key, generated_at, body_json, updated_at
  FROM public_snapshot_fragments
  WHERE snapshot_key = ?1
  ORDER BY fragment_key
  LIMIT ?2 OFFSET ?3
`;

const upsertFragmentStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readCurrentFragmentsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsPageStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

export type PublicSnapshotFragmentWrite = {
  snapshotKey: string;
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
};

export type PublicSnapshotFragmentRow = {
  fragment_key: string;
  generated_at: number;
  body_json: string;
  updated_at: number | null;
};

function assertFragmentText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`public snapshot fragment ${label} must not be empty`);
  }
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`public snapshot fragment ${label} must be a non-negative integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`public snapshot fragment ${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`public snapshot fragment ${label} must be a positive integer`);
  }
}

export function preparePublicSnapshotFragmentWrite(
  db: D1Database,
  fragment: PublicSnapshotFragmentWrite,
): D1PreparedStatement {
  assertFragmentText(fragment.snapshotKey, 'snapshotKey');
  assertFragmentText(fragment.fragmentKey, 'fragmentKey');
  assertFragmentText(fragment.bodyJson, 'bodyJson');
  assertFiniteTimestamp(fragment.generatedAt, 'generatedAt');
  assertFiniteTimestamp(fragment.updatedAt, 'updatedAt');

  const cached = upsertFragmentStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_FRAGMENT_SQL);
  if (!cached) {
    upsertFragmentStatementByDb.set(db, statement);
  }

  return statement.bind(
    fragment.snapshotKey,
    fragment.fragmentKey,
    fragment.generatedAt,
    fragment.bodyJson,
    fragment.updatedAt,
  );
}

export async function writePublicSnapshotFragments(
  db: D1Database,
  fragments: PublicSnapshotFragmentWrite[],
  pageOffset?: number,
  combined = false,
): Promise<D1Result[]> {
  if (fragments.length === 0) {
    return [];
  }

  const stored =
    pageOffset === undefined
      ? fragments
      : combined
        ? packCombinedMonitorFragments(fragments, pageOffset)
        : packMonitorFragments(fragments, pageOffset);
  const statements = stored.map((fragment) => preparePublicSnapshotFragmentWrite(db, fragment));
  return await db.batch(statements);
}

const monitorKeySchema = z.string().regex(/^monitor:[1-9]\d*$/);
const pageSchema = z
  .array(
    z.union([
      z.tuple([monitorKeySchema, z.string().min(1)]),
      z.tuple([monitorKeySchema, z.string().min(1), z.string().min(1)]),
      z.tuple([monitorKeySchema, z.string().min(1), z.string(), z.string().min(1)]),
    ]),
  )
  .max(10);

function packCombinedMonitorFragments(
  fragments: PublicSnapshotFragmentWrite[],
  offset: number,
): PublicSnapshotFragmentWrite[] {
  const singles = fragments.filter((fragment) => !fragment.fragmentKey.startsWith('monitor:'));
  const cards = fragments.filter((fragment) => fragment.snapshotKey === 'homepage:monitors');
  if (!cards.length) return singles;
  const byKey = new Map(
    fragments.map((fragment) => [`${fragment.snapshotKey}:${fragment.fragmentKey}`, fragment]),
  );
  const page = cards.map((card) => {
    const status = byKey.get(`status:monitors:${card.fragmentKey}`);
    const artifact = byKey.get(`homepage:artifact:monitors:${card.fragmentKey}`);
    if (!status || status.generatedAt !== card.generatedAt)
      throw new Error('Combined page has mismatched monitors');
    return [card.fragmentKey, card.bodyJson, artifact?.bodyJson ?? '', status.bodyJson];
  });
  singles.push({
    ...cards[0]!,
    snapshotKey: 'public:monitors',
    fragmentKey: `page:${String(offset).padStart(8, '0')}`,
    bodyJson: JSON.stringify(page),
  });
  return singles;
}

// CPU pages and storage rows need not be one row per monitor. Keep runtime update
// fragments unbundled: their paging also bounds the runtime patch CPU.
function packMonitorFragments(
  fragments: PublicSnapshotFragmentWrite[],
  offset: number,
): PublicSnapshotFragmentWrite[] {
  assertNonNegativeInteger(offset, 'pageOffset');
  const singles: PublicSnapshotFragmentWrite[] = [];
  const groups = new Map<string, PublicSnapshotFragmentWrite[]>();
  const artifactByMonitor = new Map(
    fragments
      .filter((fragment) => fragment.snapshotKey === 'homepage:artifact:monitors')
      .map((fragment) => [`${fragment.fragmentKey}:${fragment.generatedAt}`, fragment.bodyJson]),
  );
  for (const fragment of fragments) {
    if (
      fragment.snapshotKey === 'homepage:artifact:monitors' &&
      fragments.some(
        (candidate) =>
          candidate.snapshotKey === 'homepage:monitors' &&
          candidate.fragmentKey === fragment.fragmentKey &&
          candidate.generatedAt === fragment.generatedAt,
      )
    )
      continue;
    if (
      !fragment.fragmentKey.startsWith('monitor:') ||
      fragment.snapshotKey === 'monitor-runtime:updates'
    ) {
      singles.push(fragment);
      continue;
    }
    const key = `${fragment.snapshotKey}:${fragment.generatedAt}:${fragment.updatedAt}`;
    const group = groups.get(key) ?? [];
    group.push(fragment);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > 10) throw new Error('public snapshot page exceeds 10 monitors');
    const first = group[0]!;
    singles.push({
      ...first,
      fragmentKey: `page:${String(offset).padStart(8, '0')}`,
      bodyJson: JSON.stringify(
        group.map((fragment) => {
          const artifact =
            fragment.snapshotKey === 'homepage:monitors'
              ? artifactByMonitor.get(`${fragment.fragmentKey}:${fragment.generatedAt}`)
              : undefined;
          return artifact
            ? [fragment.fragmentKey, fragment.bodyJson, artifact]
            : [fragment.fragmentKey, fragment.bodyJson];
        }),
      ),
    });
  }
  return singles;
}

function expandMonitorPages(
  rows: PublicSnapshotFragmentRow[],
  artifact: boolean,
  status: boolean,
): PublicSnapshotFragmentRow[] {
  return rows.flatMap((row) => {
    if (!row.fragment_key.startsWith('page:')) return [row];
    try {
      const page = pageSchema.safeParse(JSON.parse(row.body_json));
      if (!page.success) return [row]; // Existing validators reject malformed pages.
      return page.data.map(([key, body, html, statusBody]) => ({
        ...row,
        fragment_key: key,
        body_json: artifact ? (html ?? body) : status ? (statusBody ?? body) : body,
      }));
    } catch {
      return [row];
    }
  });
}

export async function readPublicSnapshotFragments(
  db: D1Database,
  snapshotKey: string,
  generatedAt?: number,
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');

  const cache =
    generatedAt === undefined ? readFragmentsStatementByDb : readCurrentFragmentsStatementByDb;
  const cached = cache.get(db);
  const statement =
    cached ??
    db.prepare(generatedAt === undefined ? READ_FRAGMENTS_SQL : READ_CURRENT_FRAGMENTS_SQL);
  if (!cached) cache.set(db, statement);
  const { results } = await statement
    .bind(snapshotKey, ...(generatedAt === undefined ? [] : [generatedAt]))
    .all<PublicSnapshotFragmentRow>();
  return expandMonitorPages(
    results ?? [],
    snapshotKey === 'homepage:artifact:monitors',
    snapshotKey === 'status:monitors',
  );
}

export async function readPublicSnapshotFragmentsPage(
  db: D1Database,
  snapshotKey: string,
  opts: { offset: number; limit: number },
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');
  assertNonNegativeInteger(opts.offset, 'offset');
  assertPositiveInteger(opts.limit, 'limit');

  const cached = readFragmentsPageStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_FRAGMENTS_PAGE_SQL);
  if (!cached) {
    readFragmentsPageStatementByDb.set(db, statement);
  }

  const { results } = await statement
    .bind(snapshotKey, opts.limit, opts.offset)
    .all<PublicSnapshotFragmentRow>();
  return results ?? [];
}

// Publication needs two small envelopes, render fragments and compact states.
// Read them in one transaction / binding call; full homepage/status histories
// stay inside D1, including during the optimistic publication check.
export async function readCombinedPublicationFragments(db: D1Database, generatedAt: number) {
  const statement = db.prepare(READ_CURRENT_FRAGMENTS_SQL);
  const results = await db.batch<PublicSnapshotFragmentRow>([
    statement.bind('homepage:envelope', generatedAt),
    statement.bind('status:envelope', generatedAt),
    statement.bind('homepage:artifact:monitors', generatedAt),
    db
      .prepare(
        `
      SELECT fragment_key,generated_at,updated_at,(
        SELECT json_group_array(json_array(json_extract(j.value,'$[0]'),
          CASE WHEN json_valid(json_extract(j.value,'$[1]'))
            THEN json_extract(json_extract(j.value,'$[1]'),'$.status') END))
        FROM json_each(CASE WHEN json_valid(f.body_json) THEN f.body_json ELSE '[]' END) j
        WHERE j.type='array'
      ) AS body_json
      FROM public_snapshot_fragments f WHERE snapshot_key='public:monitors'
        AND generated_at=?1 AND fragment_key LIKE 'page:%' ORDER BY fragment_key
    `,
      )
      .bind(generatedAt),
  ]);
  return {
    homepage: results[0]?.results ?? [],
    status: results[1]?.results ?? [],
    artifacts: expandMonitorPages(results[2]?.results ?? [], true, false),
    states: results[3]?.results ?? [],
  };
}
