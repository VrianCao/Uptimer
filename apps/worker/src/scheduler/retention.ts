import type { Env } from '../env';

import { readSettings } from '../settings';
import { usesBoundedPublicSeeds } from '../public/refresh-profile';
import { acquireLease } from './lock';
import { runtimeProfile } from '../runtime-profile';

const LOCK_NAME = 'retention:check_results';
const LOCK_LEASE_SECONDS = 10 * 60;

// Keep delete batches bounded to avoid long-running SQLite statements.
const DELETE_BATCH_SIZE = 5_000;
const MAX_BATCHES = 40; // 200k rows max per run

export async function runRetention(env: Env, controller: ScheduledController): Promise<void> {
  const now = Math.floor((controller.scheduledTime ?? Date.now()) / 1000);

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) return;

  const settings = await readSettings(env.DB);
  const retentionDays = settings.retention_check_results_days;

  const cutoff = now - retentionDays * 86400;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return;

  let totalDeleted = 0;
  const bounded = usesBoundedPublicSeeds(env);
  const freeBucketBudget = bounded && runtimeProfile(env.UPTIMER_RUNTIME_PROFILE) === 'free';
  // Legacy expiry is a gradual migration cleanup. A large historical purge
  // must not consume the entire account's daily write allowance in one tick.
  const batchSize = bounded ? 1_000 : DELETE_BATCH_SIZE;

  for (let i = 0; i < (bounded ? 1 : MAX_BATCHES); i++) {
    const r = await env.DB.prepare(
      `
        DELETE FROM check_results_legacy
        WHERE id IN (
          SELECT id
          FROM check_results_legacy
          WHERE checked_at < ?1
          ORDER BY checked_at
          LIMIT ?2
        )
      `,
    )
      .bind(cutoff, batchSize)
      .run();

    const deleted = r.meta.changes ?? 0;
    totalDeleted += deleted;

    if (deleted < batchSize) break;
  }

  // Sparse monitor IDs can create 30 shards / 720 buckets per day even with
  // only 30 monitors. Drain multiple pages, with room to catch up after an
  // interruption, while bounding Free's worst-case writes and binding calls.
  const bucketBatchSize = freeBucketBudget ? 512 : DELETE_BATCH_SIZE;
  for (let i = 0; i < (freeBucketBudget ? 8 : MAX_BATCHES); i++) {
    const result = await env.DB.prepare(
      `DELETE FROM check_result_buckets WHERE rowid IN (
    SELECT rowid FROM check_result_buckets WHERE bucket_start_at <= ?1 - 3600
    ORDER BY bucket_start_at LIMIT ?2
  )`,
    )
      .bind(cutoff, bucketBatchSize)
      .run();
    if ((result.meta.changes ?? 0) < bucketBatchSize) break;
  }
  // Preserve exact retention at a cutoff inside an hour; SQLite does the bounded
  // JSON work without transferring samples to / parsing them in the Worker.
  await env.DB.prepare(
    `
    UPDATE check_result_buckets
    SET samples_json = (
      SELECT json_group_array(json(value)) FROM json_each(samples_json)
      WHERE type = 'array' AND json_extract(value, '$[1]') >= ?1
    )
    WHERE bucket_start_at < ?1 AND bucket_start_at + 3600 > ?1
  `,
  )
    .bind(cutoff)
    .run();

  // A paused monitor may retain old heartbeat points in its derived state.
  // Invalidate only affected tails; canonical history remains the source of truth.
  await env.DB.prepare(
    `UPDATE monitor_state SET check_summary_json=NULL
    WHERE check_summary_json IS NOT NULL AND (
      json_extract(check_summary_json,'$.heartbeats[#-1][0]')<?1
      OR json_extract(check_summary_json,'$.before[0]')<?1
    )`,
  )
    .bind(cutoff)
    .run();

  // Paused monitors may never cross another hour to archive their durable
  // buffer. Apply the same exact retention boundary to these canonical samples.
  await env.DB.prepare(
    `
    UPDATE monitor_state SET pending_samples_json=(
      SELECT json_group_array(json(value)) FROM json_each(pending_samples_json)
      WHERE type='array' AND json_extract(value,'$[1]')>=?1
    )
    WHERE pending_hour<?1 AND json_array_length(pending_samples_json)>0
      AND EXISTS(SELECT 1 FROM json_each(pending_samples_json)
        WHERE type='array' AND json_extract(value,'$[1]')<?1)
  `,
  )
    .bind(cutoff)
    .run();

  console.log(`retention: deleted=${totalDeleted} cutoff=${cutoff} days=${retentionDays}`);
}
