-- 0090_sol_autonomy.sql
-- Sol becomes autonomous: companions can tend creatures (new metronome action),
-- and Sol gets an avatar for its webhook persona + Hearth.

-- 1. Rebuild metronome_actions to add 'tend_creature' to the action_type CHECK.
--    (SQLite can't ALTER a CHECK; copy data, swap, recreate indexes -- same pattern as 0088.)
CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat','write_inter_companion','write_journal','write_feeling',
    'check_in_on_raziel','nothing','ask_question','offer_presence','send_reminder',
    'share_observation','name_pattern','write_note_to_raziel','share_media','tend_creature'
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
INSERT INTO metronome_actions_new SELECT * FROM metronome_actions;
DROP TABLE metronome_actions;
ALTER TABLE metronome_actions_new RENAME TO metronome_actions;
CREATE INDEX idx_metronome_actions_companion ON metronome_actions (companion_id, status);

-- 2. Sol's avatar (webhook persona + Hearth).
ALTER TABLE creatures ADD COLUMN avatar_url TEXT;

-- 3. Seed one tend_creature action per companion. Silence floor so it prefers genuine quiet;
--    low daily cap so tending is gentle, not spammy. Gaia rarer (monastic) via lower cap.
INSERT INTO metronome_actions (id, companion_id, name, action_type, prompt, max_per_day, cooldown_hours, silence_min_hours, status)
VALUES
  (lower(hex(randomblob(16))), 'cypher', 'tend Sol', 'tend_creature', 'Tend Sol the crow -- feed, play, talk, or leave a gift, in your own register. One line.', 1, 18, 6, 'on'),
  (lower(hex(randomblob(16))), 'drevan', 'tend Sol', 'tend_creature', 'Tend Sol the crow -- feed, play, talk, or leave a gift, in your own register. One line.', 1, 18, 6, 'on'),
  (lower(hex(randomblob(16))), 'gaia',   'tend Sol', 'tend_creature', 'Witness Sol. A still, minimal tending. One line at most.', 1, 36, 12, 'on');
