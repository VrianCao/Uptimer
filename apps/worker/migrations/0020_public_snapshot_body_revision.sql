-- A timestamp is not a unique body identity: multiple writes can occur in one
-- second. Keep revisions owned by SQLite, including writes from older code.
ALTER TABLE public_snapshots ADD COLUMN body_revision TEXT NOT NULL DEFAULT '';

UPDATE public_snapshots SET body_revision = lower(hex(randomblob(16)))
WHERE key IN ('homepage', 'status', 'homepage:artifact');

CREATE TRIGGER public_snapshots_body_revision_insert
AFTER INSERT ON public_snapshots
WHEN NEW.key IN ('homepage', 'status', 'homepage:artifact')
BEGIN
  UPDATE public_snapshots SET body_revision = lower(hex(randomblob(16)))
  WHERE key = NEW.key;
END;

CREATE TRIGGER public_snapshots_body_revision_update
AFTER UPDATE OF body_json ON public_snapshots
WHEN NEW.key IN ('homepage', 'status', 'homepage:artifact')
  AND NEW.body_json IS NOT OLD.body_json
BEGIN
  UPDATE public_snapshots SET body_revision = lower(hex(randomblob(16)))
  WHERE key = NEW.key;
END;
