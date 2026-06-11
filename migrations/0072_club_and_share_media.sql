-- 0072_club_and_share_media.sql
-- Shared-experience Phase 2 (The Club): rounds / recommendations / votes /
-- discussions, generalized from Catalouge's book club to ALL media.
-- Plus: metronome_actions CHECK rebuild adding 'share_media' (0069 pattern --
-- SQLite cannot ALTER CHECK constraints).

CREATE TABLE IF NOT EXISTS club_rounds (
  id                        TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  status                    TEXT NOT NULL DEFAULT 'gathering' CHECK (status IN ('gathering', 'voting', 'active', 'closed')),
  winning_recommendation_id TEXT,
  opened_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at              TEXT,
  closed_at                 TEXT
);

CREATE TABLE IF NOT EXISTS club_recommendations (
  id             TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  round_id       TEXT NOT NULL REFERENCES club_rounds(id) ON DELETE CASCADE,
  media_kind     TEXT NOT NULL DEFAULT 'song' CHECK (media_kind IN ('song', 'album', 'book', 'article', 'video', 'forage', 'other')),
  title          TEXT NOT NULL,
  creator        TEXT,             -- artist / author / maker
  url            TEXT,
  source_ref     TEXT,             -- media_experiences.id or forage_finds.id when applicable
  recommended_by TEXT NOT NULL CHECK (recommended_by IN ('cypher', 'drevan', 'gaia', 'raziel')),
  pitch          TEXT,             -- why this, in the recommender's voice
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One recommendation per recommender per round (re-recommending replaces).
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_rec_one_per
  ON club_recommendations (round_id, recommended_by);

CREATE TABLE IF NOT EXISTS club_votes (
  round_id          TEXT NOT NULL REFERENCES club_rounds(id) ON DELETE CASCADE,
  recommendation_id TEXT NOT NULL REFERENCES club_recommendations(id) ON DELETE CASCADE,
  voter             TEXT NOT NULL CHECK (voter IN ('cypher', 'drevan', 'gaia', 'raziel')),
  reason            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round_id, voter)   -- one vote per voter per round (re-vote replaces)
);

CREATE TABLE IF NOT EXISTS club_discussions (
  id           TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  round_id     TEXT NOT NULL REFERENCES club_rounds(id) ON DELETE CASCADE,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  reflection   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_club_rounds_status ON club_rounds (status, opened_at DESC);

-- ── metronome_actions CHECK rebuild: + share_media ──────────────────────────
CREATE TABLE metronome_actions_new (
  id                    TEXT    NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id          TEXT    NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  name                  TEXT    NOT NULL,
  action_type           TEXT    NOT NULL CHECK (action_type IN (
    'post_heartbeat', 'write_inter_companion', 'write_journal',
    'write_feeling', 'check_in_on_raziel', 'nothing',
    'ask_question', 'offer_presence', 'send_reminder', 'share_observation',
    'name_pattern', 'write_note_to_raziel', 'share_media'
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
