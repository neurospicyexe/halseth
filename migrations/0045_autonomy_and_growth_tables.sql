-- Migration 0045: Autonomous worker tables.
--
-- Two groups:
--   autonomy_*  -- execution tracking (schedules, seeds, runs, logs, reflections)
--   growth_*    -- companion learning artifacts (journal, patterns, markers)
--
-- All tables are per-companion (companion_id FK-less; validated at handler layer).
-- Cap enforcement is done in application code, not DB triggers.

-- ---------------------------------------------------------------------------
-- Autonomy tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS autonomy_schedules (
  id              TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id    TEXT    NOT NULL,
  schedule_type   TEXT    NOT NULL,   -- 'exploration' | 'reflection' | 'synthesis'
  cron_expression TEXT    NOT NULL,
  config_json     TEXT    NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autonomy_schedules_companion
  ON autonomy_schedules(companion_id, enabled);

CREATE TABLE IF NOT EXISTS autonomy_seeds (
  id           TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT    NOT NULL,
  seed_type    TEXT    NOT NULL,   -- 'topic' | 'question' | 'reflection_prompt'
  content      TEXT    NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 5,
  used_at      TEXT,               -- NULL = available
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autonomy_seeds_available
  ON autonomy_seeds(companion_id, used_at, priority);

CREATE TABLE IF NOT EXISTS autonomy_runs (
  id                TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id      TEXT    NOT NULL,
  run_type          TEXT    NOT NULL,   -- 'exploration' | 'reflection' | 'synthesis'
  status            TEXT    NOT NULL DEFAULT 'pending',  -- 'pending'|'running'|'completed'|'failed'
  started_at        TEXT,
  completed_at      TEXT,
  tokens_used       INTEGER NOT NULL DEFAULT 0,
  artifacts_created INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autonomy_runs_companion
  ON autonomy_runs(companion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_runs_status
  ON autonomy_runs(status, companion_id);

CREATE TABLE IF NOT EXISTS autonomy_run_logs (
  id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  run_id     TEXT NOT NULL,
  step       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_autonomy_run_logs_run
  ON autonomy_run_logs(run_id, created_at);

CREATE TABLE IF NOT EXISTS autonomy_reflections (
  id              TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  companion_id    TEXT NOT NULL,
  run_id          TEXT,
  reflection_text TEXT NOT NULL,
  new_seeds_json  TEXT,   -- JSON array of seed suggestion strings
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_autonomy_reflections_companion
  ON autonomy_reflections(companion_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Growth tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_journal (
  id           TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT NOT NULL,
  entry_type   TEXT NOT NULL,   -- 'learning' | 'insight' | 'connection' | 'question'
  content      TEXT NOT NULL,
  source       TEXT,            -- 'autonomous' | 'conversation' | 'reflection'
  tags_json    TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_growth_journal_companion
  ON growth_journal(companion_id, created_at DESC);

CREATE TABLE IF NOT EXISTS growth_patterns (
  id           TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT NOT NULL,
  pattern_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  strength     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_growth_patterns_companion
  ON growth_patterns(companion_id, strength DESC);

CREATE TABLE IF NOT EXISTS growth_markers (
  id                 TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  companion_id       TEXT NOT NULL,
  marker_type        TEXT NOT NULL,   -- 'milestone' | 'shift' | 'realization'
  description        TEXT NOT NULL,
  related_pattern_id TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_growth_markers_companion
  ON growth_markers(companion_id, created_at DESC);
