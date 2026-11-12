-- Multi-monitor time windows and retention must not scan every retained hour.
-- This index is written only when a bucket is created/deleted, never on append.
CREATE INDEX idx_check_result_buckets_time
ON check_result_buckets(bucket_start_at, shard_id);
