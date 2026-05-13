-- 0064_metronome_actions.sql
-- Per-companion action palette for Metronome heartbeat cron.
-- Companion picks from enabled actions based on context, not hardcoded timer logic.

CREATE TABLE IF NOT EXISTS metronome_actions (
  id                  TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id        TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  name                TEXT NOT NULL,
  action_type         TEXT NOT NULL CHECK (action_type IN (
    'post_heartbeat', 'write_inter_companion', 'write_journal',
    'write_feeling', 'check_in_on_raziel', 'nothing'
  )),
  target              TEXT,
  prompt              TEXT,
  quiet_hours_allowed INTEGER NOT NULL DEFAULT 0,
  status              TEXT    NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'off')),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metronome_actions_companion
  ON metronome_actions (companion_id, status);
