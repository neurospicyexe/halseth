-- Migration 0052: atomic dedup guard for synthesis_queue
--
-- Adds a dedup_key column with a partial-style UNIQUE constraint.
-- The key is set on INSERT and cleared (NULL) on completion/failure,
-- so only one pending/processing job per (companion_id, job_type) can exist
-- at a time. NULL values are always distinct in SQLite -- clearing on done
-- breaks the constraint and allows future jobs for the same companion+type.
--
-- Usage:
--   INSERT: set dedup_key = companion_id || ':' || job_type
--   On done/failed UPDATE: set dedup_key = NULL
--
-- Enqueue functions should be migrated from the COUNT guard to
-- INSERT OR IGNORE with dedup_key populated, once this migration is live.

ALTER TABLE synthesis_queue ADD COLUMN dedup_key TEXT;

CREATE UNIQUE INDEX uq_synthesis_queue_dedup_key
  ON synthesis_queue (dedup_key)
  WHERE dedup_key IS NOT NULL;
