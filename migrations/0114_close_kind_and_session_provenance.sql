-- 0114: an honest close needs to say HOW it was closed, and a session row needs to say WHO opened it.
--
-- Context: 187 sessions sat open (oldest 2026-03-11). Closing them meant reconstructing each one
-- from evidence, and evidence comes in grades: a Claude Code transcript that names the session id,
-- companion-authored writes inside the session's window, or nothing at all. A close written from
-- archaeology must never be indistinguishable from a close the companion authored while living it
-- -- that indistinguishability is the murk. Hence close_kind.
--
-- close_kind values:
--   NULL             authored live, at the time, by the companion or the boot hook. The default,
--                    and every one of the 356 pre-existing rows.
--   'reconstructed'  backfilled 2026-08-04 from evidence that attaches to THIS session (a transcript
--                    naming its id, or companion-authored writes inside its window). The spine is
--                    real but written after the fact, by Cypher, not during the session.
--   'empty'          backfilled: the row was opened and nothing attributable happened. The spine
--                    says exactly that and nothing more. No arc is invented.
--   'machine_opened' backfilled: a job/cron/verification call opened the row; it was never a
--                    session anyone was in. Not a session we failed to reconstruct.
--
-- Continuity reads ("the latest handover") must filter close_kind IS NULL: a backfilled row is
-- archaeology, not the last thing that happened. Recall/search may still find them -- being
-- searchable is the point of writing them down.
ALTER TABLE handover_packets ADD COLUMN close_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_handover_close_kind
  ON handover_packets(close_kind, created_at DESC);

-- sessions.opened_by: the reason the 187 were unattributable is that a session row records the
-- surface (mig 0113) but never the CALLER. 'current state' / 'how am i' / 'checking in' are
-- session_open fast-path triggers, so any agent or cron asking a state-shaped question opened a
-- lifecycle row and nothing recorded that it had. Nullable: legacy rows stay honestly unknown.
-- Values are route tags set at the INSERT site, e.g. 'mcp:session_open',
-- 'librarian:session_orient', 'librarian:session_load'.
ALTER TABLE sessions ADD COLUMN opened_by TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_opened_by ON sessions(opened_by, created_at DESC);
