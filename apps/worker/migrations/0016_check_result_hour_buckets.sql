-- Keep every sample and the complete legacy history. Do not copy/rewrite the
-- existing data at deploy time. A rolling upgrade can keep inserting through
-- check_results; the view's triggers preserve the old SQL contract.
ALTER TABLE check_results RENAME TO check_results_legacy;

CREATE TABLE check_result_buckets (
  shard_id INTEGER NOT NULL,
  bucket_start_at INTEGER NOT NULL,
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  PRIMARY KEY (shard_id, bucket_start_at)
);

-- Updating samples_json does not update either indexed column. One append per
-- probe replaces the old table + time index + AUTOINCREMENT sequence writes.
-- Hour-sized buckets of four monitor IDs bound JSON work and permit indexed
-- shard/time reads. The scheduler appends a completed pair in one statement.
CREATE VIEW check_results AS
SELECT id, monitor_id, checked_at, status, latency_ms, http_status, error,
       location, attempt, checked_at AS bucket_start_at,
       CAST((monitor_id - 1) / 4 AS INTEGER) AS storage_shard
FROM check_results_legacy
UNION ALL
SELECT -b.rowid * 100000 + CAST(j.key AS INTEGER) AS id,
       json_extract(j.value, '$[0]') AS monitor_id,
       json_extract(j.value, '$[1]') AS checked_at,
       json_extract(j.value, '$[2]') AS status,
       json_extract(j.value, '$[3]') AS latency_ms,
       json_extract(j.value, '$[4]') AS http_status,
       json_extract(j.value, '$[5]') AS error,
       json_extract(j.value, '$[6]') AS location,
       json_extract(j.value, '$[7]') AS attempt,
       b.bucket_start_at, b.shard_id AS storage_shard
FROM check_result_buckets b, json_each(b.samples_json) j
WHERE j.type = 'array';

CREATE TRIGGER check_results_insert INSTEAD OF INSERT ON check_results
BEGIN
  SELECT CASE WHEN NEW.monitor_id IS NULL OR NEW.checked_at IS NULL
    OR NEW.status IS NULL OR NEW.status NOT IN ('up','down','maintenance','unknown')
    THEN RAISE(ABORT, 'Invalid check result') END;
  INSERT INTO check_result_buckets (shard_id, bucket_start_at, samples_json)
  VALUES (
    CAST((NEW.monitor_id - 1) / 4 AS INTEGER),
    CAST(NEW.checked_at / 3600 AS INTEGER) * 3600,
    json_array(json_array(NEW.monitor_id, NEW.checked_at, NEW.status, NEW.latency_ms,
      NEW.http_status, NEW.error, NEW.location, COALESCE(NEW.attempt, 1)))
  )
  ON CONFLICT(shard_id, bucket_start_at) DO UPDATE SET
    samples_json = json_insert(check_result_buckets.samples_json, '$[#]',
      json_extract(excluded.samples_json, '$[0]'));
END;

-- Compatibility for old retention/delete code during rollout. Null tombstones
-- keep array positions stable while a DELETE visits multiple samples. Current
-- code deletes whole expired buckets / monitor buckets instead.
CREATE TRIGGER check_results_delete INSTEAD OF DELETE ON check_results
BEGIN
  DELETE FROM check_results_legacy WHERE id = OLD.id AND OLD.id > 0;
  UPDATE check_result_buckets
  SET samples_json = json_set(samples_json,
    '$[' || (OLD.id + CAST((-OLD.id + 99999) / 100000 AS INTEGER) * 100000) || ']', NULL)
  WHERE OLD.id < 0
    AND rowid = CAST((-OLD.id + 99999) / 100000 AS INTEGER);
END;
