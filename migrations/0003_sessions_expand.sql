-- Recreate sessions with full spec v0.4 schema.
-- The original table has `companion_id TEXT NOT NULL` which blocks all new inserts
-- (spec drops companion_id). SQLite cannot ALTER COLUMN constraints, so we do a
-- full table recreation: new → migrate → drop old → rename.

CREATE TABLE IF NOT EXISTS sessions_new (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  front_state          TEXT,
  co_con               TEXT,      -- JSON array of co-conscious members
  hrv_range            TEXT,      -- low / mid / high
  emotional_frequency  TEXT,
  key_signature        TEXT,
  active_anchor        TEXT,
  facet                TEXT,
  depth                INTEGER,
  spiral_complete      INTEGER,   -- BOOLEAN: 0/1/NULL
  handover_id          TEXT,      -- FK to handover_packets (created in 0005)
  notes                TEXT
);

-- Migrate existing rows (companion_id and metadata_json are discarded per spec).
INSERT INTO sessions_new (id, created_at, updated_at)
  SELECT id, started_at, COALESCE(ended_at, started_at)
  FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_front_state ON sessions(front_state);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at  ON sessions(created_at DESC);
