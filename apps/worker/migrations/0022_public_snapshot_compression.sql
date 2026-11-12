-- Optional, validated compressed projection. Canonical JSON remains available
-- to older readers and writers; the existing body revision invalidates proofs.
ALTER TABLE public_snapshots ADD COLUMN proof_body_gzip TEXT;
