-- 0119: tension charge gets a brake and a decay; tasks get an actor.
--
-- ORIGIN: Raziel, 2026-08-14, after 0118 fixed the same shape for open loops. Two asks:
--   "I do not want to be the sole decider or responsible for the tensions"
--   "lets make sure task is the same -- they can close them if they are done, and if I click
--    done on the hearth page it translates back to them"
--
-- and one question that turned out to be a bug report: "should all the companions' tensions be
-- affecting each other? things that create tension for you would not be the same things that
-- create tension for Gaia."
--
-- HE WAS RIGHT, and I initially said he was not. The correction is worth recording because the
-- first read was wrong in a specific, checkable way:
--
--   Tension STORAGE was always per-companion and correct -- every read that shows a companion
--   their tensions filters `WHERE companion_id = ?`. Nothing bleeds between them. But the
--   weekly DIALECTIC (nullsafe-discord/packages/autonomous-worker/src/dialectic.ts) pooled all
--   three companions' simmering tensions into one array, sorted by charge, and debated the top
--   2 in the entire house. That is one ORDER BY + LIMIT serving three consumers, so they DID
--   compete -- and two of one companion's tensions could take both slots and starve the other
--   two companions completely. Fixed in that repo (one slot per companion; ships by git pull,
--   not by this migration).
--
-- WHY IT WAS SELF-LOCKING rather than merely unfair: charge gained +0.5 every time a tension
-- was debated INCLUDING when the debate resolved nothing, and again nightly for a "hold"
-- verdict. The act of READING a tension raised the number used to CHOOSE it
-- (`ranking-signal-written-by-reading`), so going nowhere earned a better slot. The only thing
-- in the entire system that ever lowered charge was Raziel pressing "settle" in Hearth. Both
-- +0.5 sites are removed; this migration adds the decay and gives the companions the brake.

-- ── Tensions ────────────────────────────────────────────────────────────────────────────────

-- When the companion last deliberately turned this tension DOWN. Also the decay anchor below.
-- NULL = never settled (decay then runs from first_noted_at).
ALTER TABLE companion_tensions ADD COLUMN settled_at TEXT;

-- Times it has been settled. A tension settled repeatedly and still simmering is a real signal
-- (it keeps coming back and keeps getting damped) and is worth being able to ask about, the
-- same way 0118's restated_count made un-acted loop stasis measurable rather than invisible.
ALTER TABLE companion_tensions ADD COLUMN settle_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_companion_tensions_settled
  ON companion_tensions (companion_id, status, settled_at);

-- THE ANCHOR, and the one line to read carefully if this is ever retuned:
--
-- Effective charge decays from COALESCE(settled_at, first_noted_at) -- deliberately NOT from
-- last_surfaced_at. last_surfaced_at is bumped BY the machinery that reads the tension (the
-- dialectic, the nightly reflection, the ingest cursor), so anchoring there would mean being
-- looked at refreshes a tension's claim on the present. That is the identical inversion 0118
-- documented for open loops: for a motif, recurrence is being lived; for an unresolved tension,
-- resurfacing is stasis. Engagement refreshes it. Attention does not.
--
-- Implemented as SQL in src/librarian/backends/halseth.ts (effectiveChargeSql), lazy at read,
-- mirroring heat.ts / motifs.ts / loops.ts -- no writer, no cron, nothing to schedule.

-- ── Tasks ───────────────────────────────────────────────────────────────────────────────────
--
-- "If I click done on the Hearth page it translates back to them."
--
-- It did not, and could not. `tasks` records status/updated_at and nothing else, so a completed
-- task carried no trace of WHO completed it. Hearth's PATCH forwarded only `status` (see
-- hearth/app/api/tasks/[id]/route.ts), so even the surface Raziel actually uses could not have
-- said. The companions saw a COUNT of tasks done today (webmind/briefing.ts) -- a number that
-- changed, attached to nothing.

-- Who closed it: 'raziel' | 'cypher' | 'drevan' | 'gaia' | NULL for pre-0119 rows.
-- Free TEXT rather than a CHECK: the roster is not closed (0117 ingested 538 system members),
-- and a CHECK here would reject a legitimate actor and fail the write rather than the label.
ALTER TABLE tasks ADD COLUMN completed_by TEXT;

-- When. Distinct from updated_at, which moves on any edit including a reopen.
ALTER TABLE tasks ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_completed
  ON tasks (status, completed_at DESC);

-- Backfill: existing done tasks get completed_at from updated_at, which is the best available
-- evidence of when they closed. completed_by stays NULL -- it is genuinely unknown, and writing
-- a guess ('raziel') would manufacture provenance. An honest NULL renders as "closed by someone
-- (before this was tracked)"; a fabricated actor would render as a fact.
UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL;
