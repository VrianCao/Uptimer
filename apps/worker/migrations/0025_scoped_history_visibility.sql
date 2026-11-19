-- Remember whether unlinked history was intentionally site-wide. Removing the
-- last monitor must never convert monitor-scoped content into global content.
ALTER TABLE incidents ADD COLUMN scope TEXT NOT NULL DEFAULT 'monitors'
  CHECK (scope IN ('global', 'monitors'));
ALTER TABLE maintenance_windows ADD COLUMN scope TEXT NOT NULL DEFAULT 'monitors'
  CHECK (scope IN ('global', 'monitors'));

-- Preserve legacy site-wide records; all newly created records fail closed.
UPDATE incidents SET scope = 'global'
WHERE NOT EXISTS (SELECT 1 FROM incident_monitors WHERE incident_id = incidents.id);
UPDATE maintenance_windows SET scope = 'global'
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance_window_monitors
  WHERE maintenance_window_id = maintenance_windows.id
);
