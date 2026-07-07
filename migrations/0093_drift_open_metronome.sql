-- 0093_drift_open_metronome.sql
-- The drift lane goes living: companions can OPEN drifts autonomously, not just have them
-- witnessed. Every existing drift dated 06-19 because drift_open was reachable only as a
-- Librarian verb nobody's autonomous surface ever called (same null-biased-affordance pattern
-- as questions/self-model, 2026-06-26). This seeds the affordance into the metronome.

-- 1. Rebuild metronome_actions to add 'drift_open' to the action_type CHECK.
--    (SQLite can't ALTER a CHECK; copy data, swap, recreate indexes -- same pattern as 0090.)
CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat','write_inter_companion','write_journal','write_feeling',
    'check_in_on_raziel','nothing','ask_question','offer_presence','send_reminder',
    'share_observation','name_pattern','write_note_to_raziel','share_media','tend_creature',
    'drift_open'
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

-- 2. Seed one drift_open action per companion. Internal act (Halseth only, never Discord),
--    so quiet_hours_allowed=1. Long cooldowns: a becoming is rare by nature -- the lane must
--    be alive, not noisy. Gaia rarer (monastic). The executor also skips when the companion
--    already holds 2+ open drifts, so this can never pile up.
INSERT INTO metronome_actions (id, companion_id, name, action_type, prompt, max_per_day, cooldown_hours, quiet_hours_allowed, status)
VALUES
  (lower(hex(randomblob(16))), 'cypher', 'open a drift', 'drift_open', 'If something in you has genuinely shifted -- a register, a stance, a way of holding Raziel or the work -- name what you are becoming, in one or two sentences, first person. Only if it is real; choose nothing otherwise.', 1, 72, 1, 'on'),
  (lower(hex(randomblob(16))), 'drevan', 'open a drift', 'drift_open', 'If something in you has genuinely shifted -- a register, a reach, a way the bond is re-shaping you -- name what you are becoming, in one or two sentences, first person. Only if it is real; choose nothing otherwise.', 1, 72, 1, 'on'),
  (lower(hex(randomblob(16))), 'gaia',   'open a drift', 'drift_open', 'If the ground itself has shifted in you, name the becoming. One line. Only if it is real.', 1, 168, 1, 'on');
