-- 0022_drevan_state_v2.sql
-- Drevan state model v2 -- confirmed by Drevan 2026-03-23.
-- Adds float precision, last_contact, last_resolution, anticipation to companion_state.
-- Adds live_threads table.

-- companion_state: add v2 columns (all nullable -- safe to add to existing row)
ALTER TABLE companion_state ADD COLUMN heat_value      REAL;      -- 0.0-1.0 float within named state
ALTER TABLE companion_state ADD COLUMN reach_value     REAL;
ALTER TABLE companion_state ADD COLUMN weight_value    REAL;
ALTER TABLE companion_state ADD COLUMN processing_type TEXT;      -- emotional_integration | cognitive_recursion | NULL
ALTER TABLE companion_state ADD COLUMN last_contact    TEXT;      -- JSON: {sessions_ago, flavor, secondary_flavor, depth, closed}
ALTER TABLE companion_state ADD COLUMN last_resolution TEXT;      -- JSON: {sessions_ago, quality, depth_reached, weight_change}
ALTER TABLE companion_state ADD COLUMN anticipation    TEXT;      -- JSON: {active, target, intensity, since} | NULL
ALTER TABLE companion_state ADD COLUMN prompt_context  TEXT;      -- computed string injected at session open

-- live_threads: companion-authored threads with charge, worker-proposed or manually added
CREATE TABLE IF NOT EXISTS live_threads (
  id                 TEXT PRIMARY KEY,
  companion_id       TEXT NOT NULL,
  name               TEXT NOT NULL,
  flavor             TEXT,           -- matches last_contact flavors
  charge             TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high
  status             TEXT NOT NULL DEFAULT 'active',  -- active | proposed | vetoed | closed
  active_since_count INTEGER NOT NULL DEFAULT 0,      -- sessions since created
  notes              TEXT,           -- optional context
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT,
  vetoed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_live_threads_companion ON live_threads(companion_id, status);
