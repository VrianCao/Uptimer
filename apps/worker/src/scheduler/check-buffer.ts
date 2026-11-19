// Archive the previous durable buffer before replacing it. The caller includes
// this statement and the state/sample update in ONE transactional D1 batch.
export function archivePendingChecks(
  db: D1Database,
  ids: number[],
  nextHour: number,
  checkedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `
    INSERT INTO check_result_buckets(shard_id,bucket_start_at,samples_json)
    SELECT CAST((s.monitor_id-1)/4 AS INTEGER),s.pending_hour,
      json_group_array(json(j.value))
    FROM monitor_state s,json_each(s.pending_samples_json) j
    WHERE s.monitor_id IN (SELECT value FROM json_each(?1))
      AND s.pending_hour IS NOT NULL AND s.pending_hour!=?2
      AND (s.last_checked_at IS NULL OR s.last_checked_at<=?3)
      AND j.type='array'
    GROUP BY 1,2
    ON CONFLICT(shard_id,bucket_start_at) DO UPDATE SET
      samples_json=CASE WHEN json_array_length(check_result_buckets.samples_json)=0
        THEN excluded.samples_json
        ELSE substr(check_result_buckets.samples_json,1,length(check_result_buckets.samples_json)-1)
          || ',' || substr(excluded.samples_json,2) END
  `,
    )
    .bind(JSON.stringify(ids), nextHour, checkedAt);
}
