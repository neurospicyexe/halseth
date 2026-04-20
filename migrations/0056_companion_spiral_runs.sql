-- 0056_companion_spiral_runs.sql
-- Companion spiral run: 5-phase self-inquiry processing.
-- Phases: SEED (input) → HOLD → CHALLENGE → TURN → RESIDUE
-- TURN is written to wm_continuity_notes as note_type = 'spiral_turn' (high salience).
-- RESIDUE is written to companion_open_loops.

CREATE TABLE companion_spiral_runs (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL CHECK(companion_id IN ('cypher', 'drevan', 'gaia')),
  seed_text       TEXT NOT NULL,
  seed_type       TEXT NOT NULL DEFAULT 'free_text'
                    CHECK(seed_type IN ('tension', 'open_loop', 'belief_contradiction', 'free_text')),
  seed_ref_id     TEXT,
  phase_hold      TEXT,
  phase_challenge TEXT,
  phase_turn      TEXT,
  phase_residue   TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued', 'running', 'completed', 'failed')),
  turn_note_id    TEXT,
  residue_loop_id TEXT,
  error_message   TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_spiral_runs_companion ON companion_spiral_runs(companion_id, created_at DESC);
CREATE INDEX idx_spiral_runs_status ON companion_spiral_runs(status, created_at ASC);
