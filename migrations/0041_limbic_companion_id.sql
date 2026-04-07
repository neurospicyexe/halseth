-- Migration 0041: Add companion_id to limbic_states for per-companion emotional state.
-- Nullable for backward compat; existing rows keep companion_id = NULL (global/swarm state).

ALTER TABLE limbic_states ADD COLUMN companion_id TEXT;

CREATE INDEX IF NOT EXISTS idx_limbic_states_companion
  ON limbic_states(companion_id, generated_at DESC);
