-- 0038_limbic_states.sql
-- Swarm-level synthesized state produced by the Brain synthesis loop.
-- One record per synthesis pass. Orient reads the latest.

CREATE TABLE IF NOT EXISTS limbic_states (
    state_id           TEXT PRIMARY KEY,
    generated_at       TEXT NOT NULL,
    synthesis_source   TEXT,
    active_concerns    TEXT,
    live_tensions      TEXT,
    drift_vector       TEXT,
    open_questions     TEXT,
    emotional_register TEXT,
    swarm_threads      TEXT,
    companion_notes    TEXT,
    created_at         TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_limbic_states_generated
  ON limbic_states(generated_at DESC);
