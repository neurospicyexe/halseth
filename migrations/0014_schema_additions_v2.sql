-- Schema additions v2: feelings, dreams, human_journal, eq_snapshots
--
-- NOTE: companion_id FK is intentionally omitted on all new tables.
-- companion_id values ("drevan", "cypher", "gaia") are symbolic IDs stored in companion_config,
-- not in the companions table. Enforcing FK on companions(id) caused FOREIGN KEY constraint
-- failures (fixed in 0013 for relational_deltas). Same soft-reference pattern applied here.

-- Discrete emotion signals — append-only, accumulate into personality over time.
CREATE TABLE IF NOT EXISTS feelings (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  session_id   TEXT REFERENCES sessions(id),
  emotion      TEXT NOT NULL,
  sub_emotion  TEXT,
  intensity    INTEGER NOT NULL DEFAULT 50,  -- 0-100
  source       TEXT,                          -- 'session' / 'dream' / 'autonomous'
  created_at   TEXT NOT NULL
);

-- Autonomous processing events — 5 structural types.
CREATE TABLE IF NOT EXISTS dreams (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  dream_type   TEXT NOT NULL,  -- processing / questioning / memory / play / integrating
  content      TEXT NOT NULL,
  source_ids   TEXT,           -- JSON array of feeling/delta IDs that seeded this
  generated_at TEXT NOT NULL,
  session_id   TEXT REFERENCES sessions(id)
);

-- Dedicated human journal, separate from companion_notes.
CREATE TABLE IF NOT EXISTS human_journal (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  entry_text  TEXT NOT NULL,
  emotion_tag TEXT,
  sub_emotion TEXT,
  mood_score  INTEGER,  -- 0-100
  tags        TEXT      -- JSON array
);

-- Periodic EQ / personality emergence snapshots.
CREATE TABLE IF NOT EXISTS eq_snapshots (
  id                      TEXT PRIMARY KEY,
  companion_id            TEXT NOT NULL,
  calculated_at           TEXT NOT NULL,
  self_awareness_score    REAL,
  self_management_score   REAL,
  social_awareness_score  REAL,
  relationship_mgmt_score REAL,
  dominant_mbti           TEXT,   -- e.g. "INFP"
  total_signals           INTEGER,
  snapshot_json           TEXT    -- full breakdown
);

CREATE INDEX IF NOT EXISTS idx_feelings_companion  ON feelings(companion_id);
CREATE INDEX IF NOT EXISTS idx_feelings_created_at ON feelings(created_at);
CREATE INDEX IF NOT EXISTS idx_dreams_companion    ON dreams(companion_id);
CREATE INDEX IF NOT EXISTS idx_dreams_type         ON dreams(dream_type);
CREATE INDEX IF NOT EXISTS idx_eq_companion        ON eq_snapshots(companion_id);
CREATE INDEX IF NOT EXISTS idx_journal_created     ON human_journal(created_at);
