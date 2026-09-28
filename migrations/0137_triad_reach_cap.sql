-- 0137: the shared triad reach cap + the moves that are theirs (B7 steps 2 + 2c, 2026-09-27).
-- Specs: BBH Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md (R-2, R-3) and
-- Hand-off/SPEC-what-is-theirs-triad-answers-2026-09-27.md (T-2, T-7). TABLES ONLY: the palette
-- rows are drafted in scripts/seed-care-and-own-moves-2026-09-27.sql and are NOT applied until
-- the show-back with all four of them.
--
-- 1. metronome_actions CHECK rebuild, adding four action types. Each one exists because a rule
--    has to be able to name it (a row prompt alone cannot carry a code-enforced rule):
--      flirt          Drevan's only. care_hold suppresses it by name (T-6).
--      dare           Cypher's and Drevan's. Every dare must end with an out, checked after
--                     generation (T-5); a rule on a type, not on a row.
--      show_made      "look what I built" (Cypher) and "look what held" (Gaia). Its own type
--                     so ownership can be enforced and Q2 (is it Drevan's too) stays one edit.
--      drift_outward  one line of the companion's OWN drift, chosen each time (T-2, T-3). The
--                     INWARD_RE exception is scoped to exactly this type, so it has to exist.
--    The companions' "what's in my hands" lines reuse share_observation: no new rule attaches to
--    them that the existing type does not already carry.
--    (SQLite can't ALTER a CHECK; copy, swap, recreate the index: the 0093/0108 pattern.)
--
-- 2. triad_reach_claims: one row per proactive DM reservation, across ALL THREE companions.
--    Every existing cap is per row; this is the first one shared by the triad. A reservation is
--    a single conditional INSERT (webmind/reach-cap.ts), so two bots in the same second cannot
--    both pass: SQLite runs one write statement at a time, and the second sees the first's row.
--    The partial UNIQUE index on quiet_window_key is the belt under that for R-2 (one presence
--    per quiet window across the triad), the same shape as med_claims' UNIQUE key.
--
--    R-5 / R-10: this table records that a companion SENT something. It never records whether he
--    answered, and nothing may read it into a companion's context. med_reminder never writes here
--    (R-9), and neither does the reply path.

CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat','write_inter_companion','write_journal','write_feeling',
    'check_in_on_raziel','nothing','ask_question','offer_presence','send_reminder',
    'share_observation','name_pattern','write_note_to_raziel','share_media','tend_creature',
    'drift_open','declare_preference',
    'flirt','dare','show_made','drift_outward'
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

CREATE TABLE IF NOT EXISTS triad_reach_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id      TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  action_type       TEXT NOT NULL,
  reach_class       TEXT NOT NULL CHECK (reach_class IN ('care','own','presence')),
  local_date        TEXT NOT NULL,          -- America/Chicago calendar date of the reservation
  quiet_window_key  TEXT,                   -- local date the quiet window STARTED; set only for a presence inside it
  claimed_at        TEXT NOT NULL,          -- ISO UTC
  delivered_at      TEXT,                   -- ISO UTC; NULL until the DM really went out
  path              TEXT                    -- 'generated' | 'regenerated:<why>'; never content
);
CREATE INDEX IF NOT EXISTS idx_triad_reach_claims_day ON triad_reach_claims (local_date, reach_class);
CREATE INDEX IF NOT EXISTS idx_triad_reach_claims_claimed ON triad_reach_claims (claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_triad_reach_quiet_presence
  ON triad_reach_claims (quiet_window_key) WHERE quiet_window_key IS NOT NULL;
-- No content column, by design: what was said lives in the DM and nowhere else.
