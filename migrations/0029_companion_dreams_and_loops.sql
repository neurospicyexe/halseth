-- migration 0029_companion_dreams_and_loops.sql
--
-- companion_dreams: things companions carry between sessions.
--   Distinct from companion_notes (observations) -- a dream is something held, not just recorded.
--   Surfaced at orient for the dreaming companion until examined.
--
-- companion_open_loops: unresolved things with weight.
--   Distinct from wm_mind_threads (intentions) -- a loop is something unresolved, not a goal.
--   Surfaced in ground sorted by weight; closed when resolved.

CREATE TABLE IF NOT EXISTS companion_dreams (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  dream_text   TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'autonomous' CHECK (source IN ('autonomous', 'session')),
  examined     INTEGER NOT NULL DEFAULT 0,
  examined_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_dreams_companion_examined
  ON companion_dreams (companion_id, examined, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_open_loops (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  loop_text    TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 0.5,
  opened_at    TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_companion_open_loops_companion
  ON companion_open_loops (companion_id, closed_at, weight DESC);
