-- 0159_voice_lessons.sql  (2026-11-01, voice drift loop item 5; Halseth task 31648f0a)
--
-- A staged queue of voice lessons, modeled on skill_proposals (0135): on a night the drift job sees a marker
-- move (|z| >= 2), the worker asks that companion, in its own voice, for ONE lesson / corrective / experiment
-- about its voice, built from marker names and z-scores only (never reply text). It is STAGED, never applied:
-- Raziel approves or rejects (a rejection needs a reason, delivered back to the companion). An approved lesson
-- is a record both can read; nothing edits a SOUL. One row per companion per Chicago day. Staged rows older
-- than 7 days expire on read.
CREATE TABLE IF NOT EXISTS voice_lessons (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  day          TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('lesson','corrective','experiment')),
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 600),
  evidence     TEXT,
  status       TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','approved','rejected','expired')),
  decided_by   TEXT,
  decided_at   TEXT,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  UNIQUE (companion_id, day)
);
CREATE INDEX IF NOT EXISTS idx_voice_lessons_status ON voice_lessons (status, created_at);
