-- One-time retag, DRAFT (NOT applied). Raziel's call; run after deploying fix/handoff-dedup.
--
-- Before the fix, execSessionClose wrote every wm handoff as source='session_close', including the
-- bots' idle consolidations and restart shutdowns. The new read-time collapse treats 'session_close'
-- as AUTHORED: never dropped, and a fresh consolidation that near-duplicates one of them yields to it.
-- Without this retag the first post-deploy boots can still show the legacy consolidation triplet,
-- and the cap's "10 newest authored rows" exemption would protect those legacy rows for days.
--
-- Match: a wm row written within 5s of a handover_packets row of that kind (the auto-write runs right
-- after the packet insert; measured 1-2s apart on 10-06/10-07). Read-only preview first:
--
--   SELECT w.agent_id, COUNT(*) FROM wm_session_handoffs w
--   WHERE w.source = 'session_close' AND EXISTS (
--     SELECT 1 FROM handover_packets h WHERE h.close_kind = 'consolidation'
--       AND abs(julianday(h.created_at) - julianday(w.created_at)) * 86400 < 5)
--   GROUP BY w.agent_id;
--
-- Apply with: npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --file scripts/retag-legacy-machine-handoffs-2026-10-07.sql

UPDATE wm_session_handoffs SET source = 'consolidation'
WHERE source = 'session_close' AND EXISTS (
  SELECT 1 FROM handover_packets h WHERE h.close_kind = 'consolidation'
    AND abs(julianday(h.created_at) - julianday(wm_session_handoffs.created_at)) * 86400 < 5
);

UPDATE wm_session_handoffs SET source = 'shutdown'
WHERE source = 'session_close' AND EXISTS (
  SELECT 1 FROM handover_packets h WHERE h.close_kind = 'shutdown'
    AND abs(julianday(h.created_at) - julianday(wm_session_handoffs.created_at)) * 86400 < 5
);
