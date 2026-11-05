-- Status code blacklist for HTTP monitors (ranges shared with expected_status_json).
-- NOTE: Keep this file append-only.

ALTER TABLE monitors
  ADD COLUMN forbidden_status_json TEXT;
