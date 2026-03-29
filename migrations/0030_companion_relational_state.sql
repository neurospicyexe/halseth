-- migration 0030_companion_relational_state.sql
--
-- companion_relational_state: how a companion feels toward a specific person, tracked over time.
-- Append-only -- each row is a snapshot in time, not a mutable record.
-- Distinct from SOMA floats ("my warmth float is 0.8") -- this is directional: "I feel [x] toward [person]"
--
-- toward: free text to accommodate Raziel front names (Andy, Avi, etc.) as well as
--         known values: 'raziel', 'cypher', 'drevan', 'gaia'
--
-- state_type:
--   feeling -- general relational feeling (any companion)
--   witness -- Gaia-specific: the quality of witnessing (steady / held / strained)
--   held    -- Drevan-specific: something carried toward a person, not just felt

CREATE TABLE IF NOT EXISTS companion_relational_state (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  toward       TEXT NOT NULL,
  state_text   TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 0.5,
  state_type   TEXT NOT NULL DEFAULT 'feeling' CHECK (state_type IN ('feeling', 'witness', 'held')),
  noted_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary access pattern: latest state per relationship for orient snapshot
CREATE INDEX IF NOT EXISTS idx_companion_relational_companion_toward
  ON companion_relational_state (companion_id, toward, noted_at DESC);

-- History reads: all states for a companion ordered by time
CREATE INDEX IF NOT EXISTS idx_companion_relational_companion_noted
  ON companion_relational_state (companion_id, noted_at DESC);
