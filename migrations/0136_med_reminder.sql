-- 0136: med_reminder (B7 step 2b, spec Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md
-- R-9, R-10, P-1, P-2). TABLES ONLY: this file is tracked in git, so it carries no rows. The
-- schedule is seeded from a gitignored file under docs/private/ (medication labels and dose
-- times never enter a tracked file).
--
-- Three tables, three jobs:
--   med_schedule  what is due, when, and who sends it (primary + fallback companion)
--   med_claims    idempotency: exactly one sender per (slot, local date, first|followup)
--   med_answers   the ONLY thing ever recorded about him: that he said he took it, and when
--
-- R-10 / R-5: no streak, no count, no rate, no "missed". An unanswered dose leaves NO row in
-- med_answers. med_claims records that a reminder was SENT (needed so a restart can never
-- resend and two bots can never both send); it is an operational lock, never surfaced as
-- compliance, and nothing may read it as "he did not take it".

CREATE TABLE IF NOT EXISTS med_schedule (
  slot_key               TEXT PRIMARY KEY,                 -- stable key, e.g. 'morning' (never a drug name)
  label                  TEXT NOT NULL,                    -- what the DM names; PRIVATE, lives only in D1
  local_time             TEXT NOT NULL CHECK (local_time GLOB '[0-2][0-9]:[0-5][0-9]'),  -- 'HH:MM' wall clock in tz
  tz                     TEXT NOT NULL DEFAULT 'America/Chicago',  -- IANA zone; DST-aware, never an offset
  weekday_mask           INTEGER NOT NULL DEFAULT 127 CHECK (weekday_mask BETWEEN 1 AND 127),  -- bit0=Sun .. bit6=Sat
  followup_minutes       INTEGER DEFAULT 30,               -- NULL or 0 = no follow-up
  late_window_minutes    INTEGER NOT NULL DEFAULT 180,     -- past this the first reminder expires unsent
  primary_companion      TEXT NOT NULL DEFAULT 'drevan' CHECK (primary_companion IN ('cypher','drevan','gaia')),
  fallback_companion     TEXT DEFAULT 'cypher' CHECK (fallback_companion IS NULL OR fallback_companion IN ('cypher','drevan','gaia')),
  fallback_delay_seconds INTEGER NOT NULL DEFAULT 120,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  active_from            TEXT,                             -- local date 'YYYY-MM-DD'; NULL = already active
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS med_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key      TEXT NOT NULL,
  local_date    TEXT NOT NULL,                             -- the dose's local date in the row's tz
  kind          TEXT NOT NULL CHECK (kind IN ('first','followup')),
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  claimed_at    TEXT NOT NULL,                             -- ISO UTC
  delivered_at  TEXT,                                      -- ISO UTC; NULL until the DM really went out
  path          TEXT,                                      -- 'generated' | 'fallback:<reason>'; never content
  UNIQUE (slot_key, local_date, kind)
);
CREATE INDEX IF NOT EXISTS idx_med_claims_companion ON med_claims(companion_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS med_answers (
  slot_key      TEXT NOT NULL,
  local_date    TEXT NOT NULL,
  answered_at   TEXT NOT NULL,                             -- ISO UTC, the time of his message
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),  -- who he told
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slot_key, local_date)
);
-- No free-text column in med_answers, by design: what he said is not stored, only that he said it.
