import type { Env } from '../env';
import { z } from 'zod';
import { buildMonitorStatusBanner } from '../public/data';
import type { PublicStatusResponse } from '../schemas/public-status';
import { readCombinedPublicationFragments } from '../snapshots/public-fragments';
import {
  parseHomepageEnvelopeFragmentRows,
  parseStatusEnvelopeFragmentRows,
} from '../snapshots/public-monitor-fragments';
import { buildHomepageArtifactPresentation } from '../snapshots/public-homepage';

// Full monitor JSON stays in D1. The ordered CTE is shared by all three outputs;
// missing/corrupt pages and a newer publication prevent a partial publication.
const PUBLISH_SQL = `
WITH input AS MATERIALIZED (
  SELECT CAST(key AS INTEGER) AS position,json_extract(value,'$[0]') AS monitor_key,
    json_extract(value,'$[1]') AS expected_status,json_extract(value,'$[2]') AS expected_artifact
  FROM json_each(?9,'$.monitors')
),
fragments AS MATERIALIZED (
  SELECT json_extract(j.value,'$[0]') AS monitor_key,
    json_extract(j.value,'$[1]') AS homepage,
    json_extract(j.value,'$[3]') AS status,
    json_extract(j.value,'$[2]') AS artifact,
    row_number() OVER (PARTITION BY json_extract(j.value,'$[0]')
      ORDER BY f.fragment_key DESC,CAST(j.key AS INTEGER) DESC) AS rn
  FROM public_snapshot_fragments f,
    json_each(CASE WHEN json_valid(f.body_json) THEN f.body_json ELSE '[]' END) j
  WHERE f.snapshot_key='public:monitors' AND f.generated_at=?1
    AND f.fragment_key LIKE 'page:%' AND j.type='array'
    AND json_type(j.value,'$[0]')='text'
    AND json_type(j.value,'$[1]')='text' AND json_type(j.value,'$[3]')='text'
),
ordered AS MATERIALIZED (
  SELECT i.position,f.homepage,f.status
  FROM input i JOIN fragments f ON f.monitor_key=i.monitor_key AND f.rn=1
  WHERE CASE WHEN json_valid(f.homepage) AND json_valid(f.status) THEN
    json_type(f.homepage)='object' AND json_type(f.status)='object'
    AND json_extract(f.homepage,'$.status')=i.expected_status
    AND json_extract(f.status,'$.status')=i.expected_status
    AND 'monitor:' || json_extract(f.homepage,'$.id')=i.monitor_key
    AND 'monitor:' || json_extract(f.status,'$.id')=i.monitor_key
    AND f.artifact=i.expected_artifact ELSE 0 END
  ORDER BY i.position
),
data AS MATERIALIZED (
  SELECT json_set(json(?3),'$.monitors',json_group_array(json(homepage))) AS homepage,
    json_set(json(?4),'$.monitors',json_group_array(json(status))) AS status,count(*) AS n
  FROM ordered
),
snapshots AS (
  SELECT 'homepage' AS key,homepage AS body_json FROM data WHERE n=json_array_length(?5)
  UNION ALL SELECT 'status',status FROM data WHERE n=json_array_length(?5)
  UNION ALL SELECT 'homepage:artifact',json_object('generated_at',?1,'preload_html',?6,
    'snapshot',json(homepage),'meta_title',?7,'meta_description',?8)
    FROM data WHERE n=json_array_length(?5)
)
INSERT INTO public_snapshots(key,generated_at,body_json,updated_at)
SELECT key,?1,body_json,?2 FROM snapshots
WHERE NOT EXISTS (
  SELECT 1 FROM public_snapshots WHERE key IN ('homepage','status','homepage:artifact')
    AND generated_at>?1 AND generated_at<=?2+60
)
AND (SELECT count(*) FROM public_snapshot_fragments e JOIN json_each(?9,'$.envelopes') p
  ON e.snapshot_key=json_extract(p.value,'$[0]') AND e.fragment_key='envelope'
    AND e.generated_at=?1 AND e.body_json=json_extract(p.value,'$[1]'))=2
ON CONFLICT(key) DO UPDATE SET generated_at=excluded.generated_at,
  body_json=excluded.body_json,updated_at=excluded.updated_at
WHERE excluded.generated_at!=public_snapshots.generated_at
  OR excluded.body_json!=public_snapshots.body_json
`;

const statesSchema = z
  .array(
    z.tuple([
      z.string().regex(/^monitor:[1-9]\d*$/),
      z.enum(['up', 'down', 'maintenance', 'paused', 'unknown']),
    ]),
  )
  .max(10);

async function publishAttempt(env: Env, now: number) {
  const rows = await readCombinedPublicationFragments(env.DB, now);
  const home = parseHomepageEnvelopeFragmentRows(rows.homepage);
  const status = parseStatusEnvelopeFragmentRows(rows.status);
  if (!home || !status || home.generatedAt !== now || status.generatedAt !== now)
    return { ok: true, published: false, monitorCount: 0, writeCount: 0, skip: 'missing_envelope' };
  const ids = home.data.monitor_ids;
  if (JSON.stringify(ids) !== JSON.stringify(status.data.monitor_ids))
    return {
      ok: true,
      published: false,
      monitorCount: ids.length,
      writeCount: 0,
      skip: 'mismatched_envelopes',
    };
  const { monitor_ids: _homeIds, ...homeEnvelope } = home.data;
  const { monitor_ids: _statusIds, ...statusEnvelope } = status.data;
  const states = new Map<string, z.infer<typeof statesSchema>[number][1]>();
  for (const row of rows.states) {
    let values: unknown;
    try {
      values = JSON.parse(row.body_json);
    } catch {
      values = null;
    }
    const parsed = statesSchema.safeParse(values);
    if (!parsed.success)
      return {
        ok: true,
        published: false,
        monitorCount: ids.length,
        writeCount: 0,
        skip: 'invalid_monitor_states',
      };
    for (const [key, state] of parsed.data) states.set(key, state);
  }
  if (ids.some((id) => !states.has(`monitor:${id}`)))
    return {
      ok: true,
      published: false,
      monitorCount: ids.length,
      writeCount: 0,
      skip: 'missing_monitor_states',
    };
  const summary: PublicStatusResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };
  for (const id of ids) summary[states.get(`monitor:${id}`)!]++;
  const overallStatus =
    (['down', 'unknown', 'maintenance', 'up', 'paused'] as const).find(
      (status) => summary[status] > 0,
    ) ?? 'unknown';
  const counts = (envelope: typeof statusEnvelope | typeof homeEnvelope) => ({
    summary,
    overall_status: overallStatus,
    banner:
      envelope.banner.source === 'incident'
        ? envelope.banner
        : buildMonitorStatusBanner({
            counts: summary,
            monitorCount: ids.length,
            activeMaintenanceWindows: envelope.maintenance_windows.active,
          }),
  });
  const homepage = { ...homeEnvelope, ...counts(homeEnvelope) };
  const statusPayload = { ...statusEnvelope, ...counts(statusEnvelope) };
  const presentation = buildHomepageArtifactPresentation(homepage, ids, rows.artifacts);
  if (!presentation)
    return {
      ok: true,
      published: false,
      monitorCount: ids.length,
      writeCount: 0,
      skip: 'missing_artifact_fragments',
    };
  // Only compact states and already-required render fragments cross the
  // binding. Compare exactly what presentation used inside the write statement;
  // a same-second overwrite must not mix an old HTML page with newer JSON.
  const artifacts = new Map(rows.artifacts.map((row) => [row.fragment_key, row.body_json]));
  const proof = JSON.stringify({
    monitors: ids.map((id) => {
      const key = `monitor:${id}`;
      return [key, states.get(key), artifacts.get(key)];
    }),
    envelopes: [
      [
        'homepage:envelope',
        rows.homepage.find((row) => row.fragment_key === 'envelope')!.body_json,
      ],
      ['status:envelope', rows.status.find((row) => row.fragment_key === 'envelope')!.body_json],
    ],
  });
  const result = await env.DB.prepare(PUBLISH_SQL)
    .bind(
      now,
      Math.max(now, Math.floor(Date.now() / 1000)),
      JSON.stringify(homepage),
      JSON.stringify(statusPayload),
      JSON.stringify(ids),
      presentation.preload_html,
      presentation.meta_title,
      presentation.meta_description,
      proof,
    )
    .run();
  return {
    ok: true,
    published: (result.meta.changes ?? 0) > 0,
    monitorCount: ids.length,
    writeCount: result.meta.changes ?? 0,
    generatedAt: now,
  };
}

export async function publishCombinedPublicSnapshots(env: Env, now: number) {
  const result = await publishAttempt(env, now);
  // Bounded optimistic retry also handles overlapping admin refreshes. No lock
  // spans network I/O, and repeated no-op publication never writes rows.
  return !result.published && !result.skip ? publishAttempt(env, now) : result;
}
