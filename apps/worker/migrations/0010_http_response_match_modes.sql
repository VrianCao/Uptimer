-- Phase 17: add explicit HTTP response body assertion match modes
-- NOTE: Keep this file append-only.

ALTER TABLE monitors
  ADD COLUMN response_keyword_mode TEXT
  CHECK (response_keyword_mode IN ('contains', 'regex'));

ALTER TABLE monitors
  ADD COLUMN response_forbidden_keyword_mode TEXT
  CHECK (response_forbidden_keyword_mode IN ('contains', 'regex'));
