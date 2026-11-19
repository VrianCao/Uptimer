-- Fragment reads use (snapshot_key, fragment_key), covered by the primary key.
-- Time-window validation happens after reading the bounded per-monitor fragments;
-- no query searches this index. Maintaining it amplifies every fragment write.
DROP INDEX IF EXISTS idx_public_snapshot_fragments_snapshot_generated;
