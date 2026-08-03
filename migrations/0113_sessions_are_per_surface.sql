-- 0113: sessions are per-surface, not per-companion
--
-- The 24h idempotency guard keyed on companion_id alone, so every surface Raziel talks to a
-- companion from collapsed onto ONE open session: a Claude.ai daily-planning thread, a Claude Code
-- work session, and a Discord channel all resolved to whichever opened first. Everyone else
-- silently "joined" it. That is also why nothing closes -- the boot hook refuses to write a machine
-- spine onto an inherited session, so joined sessions stay open forever (167 open as of 2026-08-03,
-- oldest 2026-04-14).
--
-- The guard exists for a real reason (bots restarting every few minutes, orient firing on every
-- Claude.ai session start) so it is not removed -- it is given the right key.
--
-- NULLABLE, NO DEFAULT, on purpose. A backfill to 'unknown' would leave every legacy caller
-- colliding in one bucket, i.e. exactly the current bug under a new name. The guard skips dedup
-- entirely when surface IS NULL, so an un-migrated caller opens a fresh session rather than
-- hijacking someone else's. Duplicate-open is the failure mode we accept; cross-surface takeover
-- is the one we do not.
--
-- Existing rows stay NULL. This migration deliberately does NOT close the 167 stale open sessions
-- -- that is a separate decision, not a side effect of a schema change.

ALTER TABLE sessions ADD COLUMN surface TEXT;

-- The guard's exact query shape: companion + surface + open + inside the 24h window, newest first.
CREATE INDEX IF NOT EXISTS idx_sessions_companion_surface_open
  ON sessions (companion_id, surface, created_at DESC)
  WHERE handover_id IS NULL;
