-- 0165_metronome_make.sql (B62 "making", 2026-11-02): the `make` move in the metronome palette.
--
-- metronome_actions CHECK rebuild adding ONE action type, `make` (Cypher's and Drevan's, MOVE_OWNERS
-- in webmind/metronome.ts; Gaia keeps lines, never artifacts). Everything else is the 0137 schema
-- verbatim: every column, every row, the one index. SQLite cannot ALTER a CHECK, so: copy, swap,
-- recreate the index (the 0065/0069/0072/0090/0093/0108/0137 pattern). Columns are named in both
-- lists so a future column added between rebuilds cannot silently shift into the wrong place.
--
-- The `make` move posts nothing to Discord and is deliberately NOT in REACH_CLASS_OF
-- (webmind/reach-cap.ts): it reserves no reach, so it sits outside the DM classes and caps.

CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat','write_inter_companion','write_journal','write_feeling',
    'check_in_on_raziel','nothing','ask_question','offer_presence','send_reminder',
    'share_observation','name_pattern','write_note_to_raziel','share_media','tend_creature',
    'drift_open','declare_preference',
    'flirt','dare','show_made','drift_outward',
    'make'
  )),
  target                TEXT,
  prompt                TEXT,
  quiet_hours_allowed   INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'on' CHECK (status IN ('on','off')),
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
INSERT INTO metronome_actions_new
  (id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status,
   silence_min_hours, silence_max_hours, max_per_day, cooldown_hours, requires_signal,
   signal_lookback_hours, last_fired_at, fire_count_today, fire_count_reset_at, created_at, updated_at)
SELECT id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status,
   silence_min_hours, silence_max_hours, max_per_day, cooldown_hours, requires_signal,
   signal_lookback_hours, last_fired_at, fire_count_today, fire_count_reset_at, created_at, updated_at
FROM metronome_actions;
DROP TABLE metronome_actions;
ALTER TABLE metronome_actions_new RENAME TO metronome_actions;
CREATE INDEX idx_metronome_actions_companion ON metronome_actions (companion_id, status);
