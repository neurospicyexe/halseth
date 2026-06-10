-- 0069_capacity_and_metronome_4b.sql
-- 1. companion_state.version -- write counter for concurrency observability and CAS
--    guards on read-modify-write paths (capacity-debt item 3, swarm roadmap).
-- 2. metronome_actions CHECK rebuild adding Phase 4b action types
--    (name_pattern, write_note_to_raziel). SQLite cannot ALTER CHECK constraints,
--    so this is a full table rebuild, same pattern as 0065.

ALTER TABLE companion_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat', 'write_inter_companion', 'write_journal',
    'write_feeling', 'check_in_on_raziel', 'nothing',
    'ask_question', 'offer_presence', 'send_reminder', 'share_observation',
    'name_pattern', 'write_note_to_raziel'
  )),
  target                TEXT,
  prompt                TEXT,
  quiet_hours_allowed   INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'off')),
  silence_min_hours     REAL,
  silence_max_hours     REAL,
  max_per_day           INTEGER,
  cooldown_hours        REAL,
  requires_signal       TEXT,
  signal_lookback_hours REAL,
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
  silence_min_hours, silence_max_hours, max_per_day, cooldown_hours,
  requires_signal, signal_lookback_hours,
  last_fired_at, fire_count_today, fire_count_reset_at,
  created_at, updated_at
FROM metronome_actions;

DROP TABLE metronome_actions;
ALTER TABLE metronome_actions_new RENAME TO metronome_actions;

CREATE INDEX IF NOT EXISTS idx_metronome_actions_companion
  ON metronome_actions (companion_id, status);
