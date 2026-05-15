-- 0065_metronome_phase4.sql
-- Extend metronome_actions with context-aware triggering columns + new relational action types.
-- SQLite cannot ALTER CHECK constraints, so this is a full table rebuild.

CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat', 'write_inter_companion', 'write_journal',
    'write_feeling', 'check_in_on_raziel', 'nothing',
    'ask_question', 'offer_presence', 'send_reminder', 'share_observation'
  )),
  target                TEXT,
  prompt                TEXT,
  quiet_hours_allowed   INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'off')),
  -- condition columns (all nullable = no constraint on that axis)
  silence_min_hours     REAL,
  silence_max_hours     REAL,
  max_per_day           INTEGER,
  cooldown_hours        REAL,
  requires_signal       TEXT,
  signal_lookback_hours REAL,
  -- fire tracking
  last_fired_at         TEXT,
  fire_count_today      INTEGER NOT NULL DEFAULT 0,
  fire_count_reset_at   TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO metronome_actions_new (
  id, companion_id, name, action_type, target, prompt,
  quiet_hours_allowed, status,
  silence_min_hours, silence_max_hours, max_per_day, cooldown_hours,
  requires_signal, signal_lookback_hours,
  last_fired_at, fire_count_today, fire_count_reset_at,
  created_at, updated_at
)
SELECT
  id, companion_id, name, action_type, target, prompt,
  quiet_hours_allowed, status,
  NULL, NULL, NULL, NULL,
  NULL, NULL,
  NULL, 0, NULL,
  created_at, updated_at
FROM metronome_actions;

DROP TABLE metronome_actions;
ALTER TABLE metronome_actions_new RENAME TO metronome_actions;

CREATE INDEX IF NOT EXISTS idx_metronome_actions_companion
  ON metronome_actions (companion_id, status);
