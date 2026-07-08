-- Migration 0095: fix "last session narrative" recency bug
--
-- Boot audit 2026-07-08 finding: orient/session_orient/session_load all pick the
-- most recent synthesis_summary row by created_at (row-insertion time). A backfill
-- pass on 2026-07-04 reprocessed a backlog of old (March/April) sessions, inserting
-- rows with created_at='2026-07-04' whose content (full_ref) is months stale --
-- those rows now outrank genuinely recent session summaries at every boot.
--
-- Fix: track the session's actual date separately from row-insertion time, and
-- sort by that instead. Existing rows backfilled via join on subject (= session_id).

ALTER TABLE synthesis_summary ADD COLUMN session_created_at TEXT;

UPDATE synthesis_summary
SET session_created_at = (
  SELECT s.created_at FROM sessions s WHERE s.id = synthesis_summary.subject
)
WHERE session_created_at IS NULL AND subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_synthesis_summary_session_date
  ON synthesis_summary(companion_id, summary_type, session_created_at DESC);
