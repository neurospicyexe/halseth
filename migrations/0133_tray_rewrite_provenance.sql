-- 0133_tray_rewrite_provenance.sql  (2026-09-26)
--
-- The imp tray, second pass (follows 0132). Two things:
--
-- 1. Rewrite provenance. "keep draft <id>: <my words>" replaces the clerk's text with the owner's.
--    Before this, the clerk's original was simply overwritten: nothing could say what the imp wrote
--    versus what the companion chose to keep, which is the one question the tray exists to answer.
--    original_content holds the clerk's text as drafted (set once, on the first rewrite; never
--    touched again), rewritten_by the companion who rewrote it. Both NULL = kept as written.
--    memory_releases was considered and rejected: its kind CHECK, restore semantics and one-live-
--    release unique index are all about archiving, and a later real release of the row would collide.
--
-- 2. The tray list index. listTray reads (owner, review_state) ordered by created_at DESC; 0132's
--    (agent, review_state) index serves the filter but not the sort. Code never depends on it.
--
-- Nullable adds only; nothing reads the new columns except the tray's keep-with-rewrite UPDATE
-- (webmind/tray.ts), which refuses the REWRITE -- never the plain keep/drop -- until this is applied
-- rather than lose the clerk's words.
--
-- Rollback: the columns are inert if unused. (SQLite DROP COLUMN works on D1 if ever needed:
--   ALTER TABLE companion_journal DROP COLUMN original_content; ... and the same for the other three.)

ALTER TABLE companion_journal   ADD COLUMN original_content TEXT;
ALTER TABLE companion_journal   ADD COLUMN rewritten_by TEXT;
ALTER TABLE wm_continuity_notes ADD COLUMN original_content TEXT;
ALTER TABLE wm_continuity_notes ADD COLUMN rewritten_by TEXT;

CREATE INDEX IF NOT EXISTS idx_companion_journal_tray ON companion_journal (agent, review_state, created_at);
CREATE INDEX IF NOT EXISTS idx_wm_notes_tray          ON wm_continuity_notes (agent_id, review_state, created_at);
