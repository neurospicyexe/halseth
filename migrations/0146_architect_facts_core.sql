-- 0146_architect_facts_core.sql
--
-- B3 (facts out of SOUL), the "Core" layer. Raziel picked the facts that must stay always-on in
-- every companion's SOUL; everything else moves to the per-message lane
-- (GET /identity/architect-facts/shortlist). `core` marks the always-on set.
--
-- Additive and inert: DEFAULT 0 means no row changes meaning and the default render is untouched.
-- The flag is set per fact via PATCH /identity/architect-facts/:id { core: true }, and read by
-- GET /identity/architect-facts/render?scope=core (status='active' AND core=1 only).
--
-- Apply to prod by hand with `wrangler d1 execute halseth --remote --config wrangler.prod.toml
-- --file migrations/0146_architect_facts_core.sql`, then insert the d1_migrations ledger row in
-- the same step.

ALTER TABLE architect_facts ADD COLUMN core INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_architect_facts_core
  ON architect_facts(core) WHERE core = 1;
