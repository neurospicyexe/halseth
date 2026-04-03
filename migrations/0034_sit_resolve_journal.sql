-- 0034_sit_resolve_journal.sql
-- Redirect sit-and-resolve from companion_notes to companion_journal.
--
-- companion_notes (0008) has no active Librarian write path -- all companion writes go to
-- companion_journal (0012). The original companion_note_sits table is preserved but empty
-- (0 sits ever created). This migration re-anchors the feature on the live write target.

ALTER TABLE companion_journal ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'raw';

CREATE TABLE IF NOT EXISTS companion_journal_sits (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,      -- references companion_journal.id
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  sit_text      TEXT,
  sat_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cjs_note      ON companion_journal_sits (note_id);
CREATE INDEX IF NOT EXISTS idx_cjs_companion ON companion_journal_sits (companion_id, sat_at DESC);
