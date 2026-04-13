-- 0047: Enforce one handover packet per session at the DB level.
-- The session_close path already guards idempotency in application code
-- (session.ts checks existing handover_id before inserting). This index
-- adds DB-level enforcement so a double-close can never create a duplicate
-- even if the application guard is bypassed.
--
-- IMPORTANT: Before applying in production, verify no duplicate session_ids exist:
--   SELECT session_id, COUNT(*) as cnt FROM handover_packets GROUP BY session_id HAVING cnt > 1;
-- If duplicates exist, keep the row whose id is referenced by sessions.handover_id
-- and delete the others before running this migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_handover_session_unique
  ON handover_packets(session_id);
