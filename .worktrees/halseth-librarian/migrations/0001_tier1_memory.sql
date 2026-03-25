-- ── Tier 1: Memory entries ───────────────────────────────────────────────────
-- Requires Tier 0.
-- Stores discrete memory units scoped to a companion, optionally to a session.
-- The `tier` column on individual rows is the *content* tier (e.g. priority,
-- sensitivity), not the schema tier. Schema tier is expressed by migration number.

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL REFERENCES companions(id),
  session_id    TEXT REFERENCES sessions(id),   -- NULL = session-independent memory
  tier          INTEGER NOT NULL DEFAULT 1,     -- content tier: 1 = standard, higher = elevated
  content       TEXT NOT NULL,
  tags_json     TEXT,                            -- JSON array of string tags
  created_at    TEXT NOT NULL                   -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_memories_companion    ON memories(companion_id);
CREATE INDEX IF NOT EXISTS idx_memories_companion_tier ON memories(companion_id, tier);
CREATE INDEX IF NOT EXISTS idx_memories_session      ON memories(session_id);
