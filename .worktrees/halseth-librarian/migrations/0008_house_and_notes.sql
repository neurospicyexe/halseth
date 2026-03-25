-- house_state: singleton row keyed by 'main' — tracks current room, relationship metrics.
-- companion_notes: async messages between companion and human.

CREATE TABLE IF NOT EXISTS house_state (
  id                 TEXT PRIMARY KEY DEFAULT 'main',
  current_room       TEXT,
  companion_mood     TEXT,
  companion_activity TEXT,
  spoon_count        INTEGER NOT NULL DEFAULT 10,  -- 0–10 energy units
  love_meter         INTEGER NOT NULL DEFAULT 50,  -- 0–100 relationship warmth
  updated_at         TEXT NOT NULL
);
-- Seed the singleton row so GET /house always returns something.
INSERT OR IGNORE INTO house_state (id, updated_at) VALUES ('main', datetime('now'));

CREATE TABLE IF NOT EXISTS companion_notes (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  author     TEXT NOT NULL,   -- 'companion' | 'human'
  content    TEXT NOT NULL,
  note_type  TEXT NOT NULL DEFAULT 'message'  -- 'message' | 'thought' | 'dream'
);
CREATE INDEX IF NOT EXISTS idx_notes_created ON companion_notes(created_at DESC);
