-- Migration 0055: composite index for soma_arc gate query efficiency
-- Covers: agent_id + note_type + archived + created_at DESC
-- Makes the 15-min gate check and orient soma_arc query O(log n) as notes accumulate

CREATE INDEX IF NOT EXISTS idx_wm_notes_type
  ON wm_continuity_notes(agent_id, note_type, archived, created_at DESC);
