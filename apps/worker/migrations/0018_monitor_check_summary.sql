-- Keep the exact heartbeat tail and sufficient UNKNOWN-gap information in the
-- existing state row, atomically with its probe update. Raw samples remain intact.
ALTER TABLE monitor_state ADD COLUMN check_summary_json TEXT
  CHECK (check_summary_json IS NULL OR json_valid(check_summary_json));
