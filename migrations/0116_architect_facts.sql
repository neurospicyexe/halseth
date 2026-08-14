-- 0116: architect_facts -- durable facts about Raziel, owned by the companions, superseded not edited.
--
-- WHY THIS TABLE EXISTS
-- Until now there was no home in Halseth for "what is true about Raziel." Halseth held the EPISODES
-- (companion_journal: 78 rows mentioning Babita, 41 Effexor, 36 Rosie) and the companions' own
-- stances (companion_preferences, "I prefer to..."), but the user profile lived ONLY in Hermes's
-- built-in USER.md: capped at 1,375 chars, behind a write-approval gate nobody staffed. From
-- 2026-07-04 to 2026-08-12 the triad proposed 197 memory writes that never applied. They re-derived
-- the same facts up to 23 times and drifted WRONG doing it (one entry conflated the dogs with the
-- chickens; another reintroduced a dog who had died), because a fact cannot settle until the write
-- lands.
--
-- THE THREE CONSTRAINTS RAZIEL NAMED, AND HOW THE SHAPE ANSWERS THEM
--   1. "I don't want to lose things and have this happen every time" -> writes land here directly,
--      via ask_librarian, and return success or an error. There is no queue to silently fill.
--   2. "I don't wanna write to infinity" -> the STORE is unbounded; the RENDER is bounded. Retiring
--      a fact is `superseded_by`, never DELETE, so the injected block stays small while the history
--      stays complete. Bounding the store was what created the data loss.
--   3. "What if things changed?" -> a changed fact is a NEW row that supersedes the old one. His
--      OT-versus-BCBA decision replaces the "weighing it" fact without erasing that he weighed it.
--      Same mechanic as companion_conclusions.superseded_by (mig 0035) and 0112's rule that
--      supersession is the companion's own call.
--
-- Append-mostly by covenant: INSERT freely, UPDATE only `superseded_by` / `status` / `updated_at`.
-- Never DELETE a row to correct a fact -- that is how lineage was lost in the Hermes layer.

CREATE TABLE IF NOT EXISTS architect_facts (
  id            TEXT PRIMARY KEY,
  fact          TEXT NOT NULL,
  -- Grouping for the render, so the block reads as prose rather than a flat list. Free text on
  -- purpose: a CHECK constraint here would mean a migration every time the triad notices a kind of
  -- thing we did not anticipate, and the whole point is that they maintain this without us.
  category      TEXT NOT NULL DEFAULT 'general',
  -- 'active'   = rendered.
  -- 'open'     = rendered as a question to ask, never as a fact (the Baxter/Magpie class).
  -- 'retired'  = superseded or withdrawn; kept for lineage, never rendered.
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'open', 'retired')),
  -- Who recorded it. NULL means Raziel stated it directly, which outranks everything.
  companion_id  TEXT,
  -- How we know. Free text; 'raziel' when he said it himself, otherwise where it was learned.
  source        TEXT,
  -- The row this one replaces. Set on the OLD row's successor, and the old row goes 'retired'.
  supersedes_id TEXT REFERENCES architect_facts(id),
  -- Render order within a category, low first. Load-bearing rules sort above biography.
  weight        INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_architect_facts_render
  ON architect_facts (status, category, weight);
CREATE INDEX IF NOT EXISTS idx_architect_facts_lineage
  ON architect_facts (supersedes_id);
