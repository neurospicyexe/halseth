-- migrations/0050_wm_archive_notes.sql
-- Memory compression: soft-delete archive for wm_continuity_notes.

ALTER TABLE wm_continuity_notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wm_notes_active
  ON wm_continuity_notes(agent_id, archived, created_at DESC);

CREATE TABLE IF NOT EXISTS wm_archive_notes (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  note_ids    TEXT NOT NULL,
  note_count  INTEGER NOT NULL,
  period_from TEXT NOT NULL,
  period_to   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wm_archive_agent
  ON wm_archive_notes(agent_id, created_at DESC);
