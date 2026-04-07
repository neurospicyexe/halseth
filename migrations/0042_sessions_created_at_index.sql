-- Migration 0042: Add composite index on sessions(companion_id, created_at DESC).
--
-- The spine query in execSessionOrient does:
--   SELECT spine FROM sessions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1
--
-- Without this index, SQLite uses idx_sessions_companion (companion_id only) to filter
-- by companion, then sorts ALL matching rows by created_at -- an unindexed sort that
-- grows linearly as sessions accumulate. The composite index lets SQLite satisfy both
-- the WHERE and ORDER BY in a single index scan.

CREATE INDEX IF NOT EXISTS idx_sessions_companion_created
  ON sessions(companion_id, created_at DESC);
