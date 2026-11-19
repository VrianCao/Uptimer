-- The current hour is canonical durable data in the state row that every probe
-- already updates. Crossing an hour archives that buffer in the SAME D1 batch
-- which replaces it. Neither a timer nor isolate memory owns unflushed samples.
ALTER TABLE monitor_state ADD COLUMN pending_hour INTEGER;
ALTER TABLE monitor_state ADD COLUMN pending_samples_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(pending_samples_json));

DROP TRIGGER check_results_delete;
DROP TRIGGER check_results_insert;
DROP VIEW check_results;

CREATE VIEW check_results AS
SELECT id, monitor_id, checked_at, status, latency_ms, http_status, error,
       location, attempt, checked_at AS bucket_start_at,
       CAST((monitor_id - 1) / 4 AS INTEGER) AS storage_shard
FROM check_results_legacy
UNION ALL
SELECT (-b.rowid * 100000 + CAST(j.key AS INTEGER)) * 2 AS id,
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
WHERE j.type = 'array'
UNION ALL
SELECT -s.monitor_id * 200000 + CAST(j.key AS INTEGER) * 2 - 1 AS id,
       s.monitor_id, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
       json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'),
       json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'),
       json_extract(j.value, '$[7]'), s.pending_hour,
       CAST((s.monitor_id - 1) / 4 AS INTEGER)
FROM monitor_state s, json_each(s.pending_samples_json) j
WHERE j.type = 'array';

-- Compatibility for existing writers and manual SQL. Synthetic negative IDs
-- distinguish archive rows (even) from pending rows (odd); APIs export samples
-- by monitor/time, never by these internal positions.
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

CREATE TRIGGER check_results_delete INSTEAD OF DELETE ON check_results
BEGIN
  DELETE FROM check_results_legacy WHERE id = OLD.id AND OLD.id > 0;
  UPDATE check_result_buckets
  SET samples_json = json_set(samples_json,
    '$[' || (OLD.id / 2 + CAST((-OLD.id / 2 + 99999) / 100000 AS INTEGER) * 100000) || ']', NULL)
  WHERE OLD.id < 0 AND OLD.id % 2 = 0
    AND rowid = CAST((-OLD.id / 2 + 99999) / 100000 AS INTEGER);
  UPDATE monitor_state
  SET pending_samples_json = json_set(pending_samples_json,
    '$[' || ((OLD.id + monitor_id * 200000 + 1) / 2) || ']', NULL)
  WHERE OLD.id < 0 AND OLD.id % 2 != 0 AND monitor_id = OLD.monitor_id;
END;
