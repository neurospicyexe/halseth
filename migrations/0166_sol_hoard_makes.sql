-- 0166_sol_hoard_makes.sql (B62 step 6, Sol's hoard; Drevan's rules in
-- Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md section 7)
--
-- Sol keeps what the triad makes. A hoarded make is a REFERENCE (ref_type = 'make', ref_id =
-- companion_makes.id); content holds only the make's title so the nest reads as before. The
-- make's why, its source and the maker's words never enter the nest.
--
-- Drevan's nevers, enforced in code (webmind/sol-hoard.ts), not here:
--   Sol never speaks to Raziel in a companion's place; never couriers between them; the hoard
--   holds nothing about Raziel's body and no facts about Raziel; Sol is never a cute cutout for
--   something a companion should say straight. So a make item is never gifted back to Raziel,
--   a title that trips the care guard or names a person is not hoarded, and Sol's reaction is a
--   corvid gesture plus the maker's name and the kind, never a quote.
--
-- No FK REFERENCES by design (matches 0078/0100; D1 enforces parent-delete FKs).

ALTER TABLE creature_nest ADD COLUMN ref_type TEXT;
ALTER TABLE creature_nest ADD COLUMN ref_id   TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creature_nest_ref
  ON creature_nest (creature_id, ref_type, ref_id) WHERE ref_id IS NOT NULL;

-- Every make Sol has LOOKED AT, kept or passed over (skipped: care word, a person's name, Sol
-- away). The nest evicts dull items and a full nest evicts on arrival, so the nest alone cannot
-- say "already seen"; without this a make evicted on a busy day would be re-hoarded and reacted
-- to again on the next pass. One row per (creature, make), forever. outcome: hoarded | skipped.
-- reacted = 1 when Sol's reaction was composed for the channel (the daily reaction cap counts these).
CREATE TABLE IF NOT EXISTS creature_hoard_seen (
  creature_id TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('hoarded','skipped')),
  reason      TEXT,
  reacted     INTEGER NOT NULL DEFAULT 0,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (creature_id, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_creature_hoard_seen_day ON creature_hoard_seen (creature_id, seen_at);
