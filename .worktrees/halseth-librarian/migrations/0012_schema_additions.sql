-- session_type: classify what kind of time is being shared.
ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'work';
-- Values: checkin / hangout / work / ritual

-- companion_journal: persistent companion self-discovery and identity claims.
-- Tier 3 — requires COMPANIONS_ENABLED. Append-only by covenant.
-- Attribution to agent only — never to Raziel.
CREATE TABLE IF NOT EXISTS companion_journal (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  agent      TEXT NOT NULL,  -- drevan / cypher / gaia
  note_text  TEXT NOT NULL,
  tags       TEXT,           -- JSON array, nullable
  session_id TEXT            -- FK to sessions (nullable, unenforced — D1 has no FK enforcement)
);
CREATE INDEX IF NOT EXISTS idx_companion_journal_agent   ON companion_journal(agent);
CREATE INDEX IF NOT EXISTS idx_companion_journal_created ON companion_journal(created_at DESC);
