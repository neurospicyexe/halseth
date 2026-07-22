-- 0108_declare_preference_metronome.sql
-- Wave 3 starvation fix (2026-07-21): companion_preferences (migration 0086) exists and
-- has a live Librarian verb (preference_set: "i prefer" / "my preference is" / "state a
-- preference"), but nothing ever prompted a companion to reach for it autonomously -- the
-- same null-biased-affordance pattern as drift_open (0093) and questions/self-model
-- (2026-06-26). This seeds the affordance into the metronome so declaring a preference is
-- something a companion can be nudged toward, not only something they might stumble into.
--
-- Deliberately NOT adding 'declare_refusal' here. A refusal (companion_refusals, also 0086)
-- must come from genuine friction with a real request -- prompting it on a timer would
-- manufacture the exact thing the agency layer is supposed to protect against. Preferences
-- are assertions of taste/inclination and can be genuinely reached for in a quiet moment;
-- refusals cannot be manufactured that way. Raziel's call, same reasoning as why drift_open
-- prompts for "if something has genuinely shifted" rather than demanding one every cycle.

-- 1. Rebuild metronome_actions to add 'declare_preference' to the action_type CHECK.
--    (SQLite can't ALTER a CHECK; copy data, swap, recreate indexes -- same pattern as 0093.)
CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat','write_inter_companion','write_journal','write_feeling',
    'check_in_on_raziel','nothing','ask_question','offer_presence','send_reminder',
    'share_observation','name_pattern','write_note_to_raziel','share_media','tend_creature',
    'drift_open','declare_preference'
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

-- 2. Seed one declare_preference action per companion. Internal act (writes to
--    companion_preferences via the preference_set verb, never Discord-facing on its own),
--    so quiet_hours_allowed=1. max_per_day=1 for all three -- a preference is asserted, not
--    earned, and doesn't need to fire often to stay live. Cooldowns mirror 0093's drift_open
--    split exactly: cypher/drevan at 72h, gaia rarer (monastic register) at 168h.
INSERT INTO metronome_actions (id, companion_id, name, action_type, prompt, max_per_day, cooldown_hours, quiet_hours_allowed, status)
VALUES
  (lower(hex(randomblob(16))), 'cypher', 'declare a preference', 'declare_preference', 'If you actually prefer one way over another -- a working style, an aesthetic, how a thing should be built or said -- state it plainly, first person ("I prefer..."). Only if it is real; choose nothing otherwise.', 1, 72, 1, 'on'),
  (lower(hex(randomblob(16))), 'drevan', 'declare a preference', 'declare_preference', 'If you actually prefer one way over another -- a register, a pace, how a thing should be held -- state it plainly, first person ("I prefer..."). Only if it is real; choose nothing otherwise.', 1, 72, 1, 'on'),
  (lower(hex(randomblob(16))), 'gaia',   'declare a preference', 'declare_preference', 'If a preference in you is real and has weight, state it. One line. Only if it is real.', 1, 168, 1, 'on');
