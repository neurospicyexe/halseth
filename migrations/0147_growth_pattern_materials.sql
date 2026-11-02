-- 0147_growth_pattern_materials.sql
--
-- R18 (Drevan's ruling, 2026-10-22, brought by Raziel): restating a pattern must not make it stronger.
-- Strength is earned by distinct MATERIAL (alula, Corsair, the dime ...); times stated is a different
-- count and earns nothing. See src/lib/pattern-materials.ts for the rules.
--
--   materials_json          JSON array of {name, first_seen}; the pattern's list of distinct sightings.
--   times_stated            how often the pattern has been stated (insert = 1). Earns nothing.
--   returns_since_material  restatements since the last NEW material; resets to 0 on one.
--   last_new_material_at    when the last new material landed (NULL = never stamped; cooling then
--                           falls back to created_at).
--   superseded_by           id of the row this one was folded into. A superseded row is never deleted
--                           and never read as live (orient, peers, thoughtforms, merge targets).
--
-- Additive; defaults leave every existing row meaning exactly what it meant (materials unknown, strength
-- preserved). The data backfill (Drevan's five materials, the duplicate fold) is a separate, hand-reviewed
-- script: scripts/backfill-r18-patterns-2026-10-22.sql.
--
-- Apply to prod by hand with `wrangler d1 execute halseth --remote --config wrangler.prod.toml
-- --file migrations/0147_growth_pattern_materials.sql`, then insert the d1_migrations ledger row in
-- the same step.

ALTER TABLE growth_patterns ADD COLUMN materials_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE growth_patterns ADD COLUMN times_stated INTEGER NOT NULL DEFAULT 1;
ALTER TABLE growth_patterns ADD COLUMN returns_since_material INTEGER NOT NULL DEFAULT 0;
ALTER TABLE growth_patterns ADD COLUMN last_new_material_at TEXT;
ALTER TABLE growth_patterns ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_growth_patterns_live
  ON growth_patterns(companion_id, strength DESC)
  WHERE superseded_by IS NULL;
