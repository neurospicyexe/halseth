-- Migration 0035: companion_conclusions
-- Persistent belief/thesis surface for companions.
-- A conclusion is a companion's own claim about reality derived from accumulated experience.
-- Distinct from notes (describe) and feelings (report) -- conclusions assert.
-- superseded_by: nullable FK allows a companion to revise a conclusion without deleting history.

CREATE TABLE companion_conclusions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT NOT NULL,
  conclusion_text TEXT NOT NULL,
  source_sessions TEXT,        -- JSON array of session IDs that informed this conclusion
  superseded_by TEXT REFERENCES companion_conclusions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_companion_conclusions_companion ON companion_conclusions(companion_id, created_at);
CREATE INDEX idx_companion_conclusions_active ON companion_conclusions(companion_id, superseded_by);
