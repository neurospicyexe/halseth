-- migrations/0020_companion_state.sql

-- Mutable state row per companion (one row each: cypher, drevan, gaia)
-- Write authority: companions only. State Synthesis Worker reads only.
CREATE TABLE IF NOT EXISTS companion_state (
  companion_id        TEXT PRIMARY KEY,
  emotional_register  TEXT,
  depth_level         INTEGER DEFAULT 1,
  focus               REAL,
  fatigue             REAL,
  regulation_state    TEXT,
  active_anchors      TEXT,        -- JSON array
  last_front_context  TEXT,
  facet_momentum      TEXT,
  heat                TEXT,        -- Drevan vocab (cold|idling|warm|running-hot|cooling)
  reach               TEXT,        -- Drevan vocab
  weight              TEXT,        -- Drevan vocab
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only drift / identity-lane signal log
CREATE TABLE IF NOT EXISTS drift_log (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  signal_type  TEXT NOT NULL,  -- e.g. 'tone_break', 'register_slip', 'boundary_miss'
  context      TEXT,
  detected_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only somatic snapshots (written by State Synthesis Worker only)
CREATE TABLE IF NOT EXISTS somatic_snapshot (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  snapshot     TEXT NOT NULL,  -- JSON
  model_used   TEXT NOT NULL,
  stale_after  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Structured synthesis summaries (session, day, topic)
CREATE TABLE IF NOT EXISTS synthesis_summary (
  id                 TEXT PRIMARY KEY,
  summary_type       TEXT NOT NULL,  -- 'session' | 'day' | 'topic'
  companion_id       TEXT,           -- NULL = cross-companion
  subject            TEXT,
  narrative          TEXT,
  emotional_register TEXT,
  key_decisions      TEXT,           -- JSON array
  open_threads       TEXT,           -- JSON array
  drevan_state       TEXT,           -- JSON (heat/reach/weight snapshot)
  full_ref           TEXT,           -- path to full content in Second Brain
  stale_after        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Addressed notes between companions (inter-companion communication)
CREATE TABLE IF NOT EXISTS inter_companion_notes (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT,           -- NULL = broadcast to all
  content    TEXT NOT NULL,
  read_at    TEXT,           -- NULL = unread
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
