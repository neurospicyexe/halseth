-- 0098: idempotency key for companion_journal writes.
--
-- WHY
-- ---
-- Two writers need exactly-once semantics against this table:
--
--   1. Bot-side journalSpeech() (nullsafe-discord). It runs through writeQueue.fireAndForget,
--      which BUFFERS FAILURES AND RETRIES -- so a transient Halseth 5xx would re-POST the same
--      reply and duplicate it.
--   2. The 2026-06-25 -> now speech backfill, replaying Discord history. It must be safely
--      re-runnable (partial run, rate limit, crash) without duplicating two weeks of speech.
--
-- Both key naturally off the Discord message id, which is unique and stable.
--
-- Partial unique index: NULL external_id stays unconstrained, so every existing row and every
-- ordinary journal write (reflections, session closes, growth) is untouched. SQLite treats
-- NULLs as distinct anyway, but the WHERE clause makes the intent explicit and keeps the index
-- small (only speech rows carry a key).

ALTER TABLE companion_journal ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_journal_external_id
  ON companion_journal(external_id)
  WHERE external_id IS NOT NULL;
