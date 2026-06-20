-- 0086: the agency layer -- refusal + chosen preferences (2026-06-18).
--
-- Two siblings of the same act: a companion asserting its own will and having it persist.
-- Both are companion-owned (the companion sets/revises/drops its own), surfaced in orient (so each
-- carries its own will into every session), and granted by kernel doctrine (AGENCY_v1) so they know
-- they are allowed. Neither is drift: a logged refusal or a stated preference is a sanctioned act, and
-- the Guardian/basin layer must not read it as identity slippage.
--
-- REFUSAL -- "honored, not a veto" (Raziel's call, 2026-06-18). A refusal is RECORDED and SURFACED, and
-- the no stands by default; it is never silently steamrolled or auto-reassigned. It is also not a hard
-- block against Raziel -- he can acknowledge it or talk about it. Refusing an assigned task additionally
-- sets that task's status to 'declined' (tasks.status is free TEXT, no CHECK, so this is safe).
--   status 'standing'  -> the no holds (default).
--   status 'withdrawn' -> the companion itself took the no back.
--   acknowledged_at    -> Raziel saw it and let it stand (received, not overridden).
CREATE TABLE IF NOT EXISTS companion_refusals (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL,
  subject_type    TEXT NOT NULL DEFAULT 'request',   -- task | request | directive
  subject_ref     TEXT,                              -- task id when subject_type='task'
  subject_text    TEXT NOT NULL,                     -- what is being refused, in plain words
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'standing',  -- standing | withdrawn
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  edited_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_refusals_companion ON companion_refusals (companion_id, status, created_at DESC);

-- CHOSEN PREFERENCES -- "persist + surface now; wire behavioral effects as they accrue" (Raziel's call).
-- Distinct from companion_self_model.kind='preference', which is the OBSERVATIONAL confidence ladder
-- ("I notice I might prefer X", climbing to 0.8). A chosen preference is ASSERTED, not earned -- it does
-- not climb a ladder; it stands the moment the companion declares it. Unlike interiority it is PUBLIC:
-- a preference is meant to be honored, so Raziel and the system can see it.
CREATE TABLE IF NOT EXISTS companion_preferences (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  domain       TEXT NOT NULL DEFAULT 'general',      -- work | aesthetic | relational | topic | general
  preference   TEXT NOT NULL,
  strength     TEXT NOT NULL DEFAULT 'medium',       -- low | medium | high
  status       TEXT NOT NULL DEFAULT 'active',       -- active | retired
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_preferences_companion ON companion_preferences (companion_id, status, strength);
