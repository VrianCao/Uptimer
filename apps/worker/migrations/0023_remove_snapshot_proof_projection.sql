-- Retire the rejected signed/compressed projection experiment. Keep the earlier
-- migrations immutable for Dev databases that already applied them.
ALTER TABLE public_snapshots DROP COLUMN proof_revision;
ALTER TABLE public_snapshots DROP COLUMN proof_mac;
ALTER TABLE public_snapshots DROP COLUMN proof_body_gzip;
