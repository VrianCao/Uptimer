-- An optional proof is tied to a body identity. Existing rows remain readable
-- through the validating path until the next coordinated publication.
ALTER TABLE public_snapshots ADD COLUMN proof_revision TEXT;
ALTER TABLE public_snapshots ADD COLUMN proof_mac TEXT;
