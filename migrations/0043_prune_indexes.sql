-- Migration 0043: Add created_at index to sessions for Hearth date-range query.
--
-- GET /sessions?days=N does: WHERE created_at >= datetime('now', '-N days') ORDER BY created_at DESC
-- That query has no companion_id filter, so idx_sessions_companion_created can't help.
-- A standalone created_at index lets SQLite satisfy both the range filter and ORDER BY
-- in a single index scan without touching the table until LIMIT rows are found.

CREATE INDEX IF NOT EXISTS idx_sessions_created
  ON sessions(created_at DESC);
