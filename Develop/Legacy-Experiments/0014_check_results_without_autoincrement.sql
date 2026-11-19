-- Remove AUTOINCREMENT from the high-frequency check_results table.
--
-- SQLite still auto-assigns rowids for INTEGER PRIMARY KEY columns without
-- AUTOINCREMENT, but it no longer updates sqlite_sequence on every insert.
-- This preserves the probe history shape while reducing D1 write amplification.

DROP INDEX IF EXISTS idx_check_results_monitor_time;

CREATE TABLE check_results_without_autoincrement (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down', 'maintenance', 'unknown')),
  latency_ms INTEGER,
  http_status INTEGER,
  error TEXT,
  location TEXT,
  attempt INTEGER NOT NULL DEFAULT 1
);

INSERT INTO check_results_without_autoincrement (
  id,
  monitor_id,
  checked_at,
  status,
  latency_ms,
  http_status,
  error,
  location,
  attempt
)
SELECT
  id,
  monitor_id,
  checked_at,
  status,
  latency_ms,
  http_status,
  error,
  location,
  attempt
FROM check_results;

DROP TABLE check_results;

ALTER TABLE check_results_without_autoincrement RENAME TO check_results;

CREATE INDEX IF NOT EXISTS idx_check_results_monitor_time
  ON check_results(monitor_id, checked_at);

DELETE FROM sqlite_sequence WHERE name = 'check_results';
