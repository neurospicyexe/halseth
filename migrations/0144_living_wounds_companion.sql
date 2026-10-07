-- 0144_living_wounds_companion.sql
--
-- living_wounds had no owner. "my wounds" (the nullsafe-boot skill asks it at every Claude.ai boot)
-- ran `SELECT * FROM living_wounds`, so every companion read every wound as its own: on 2026-10-07
-- Drevan found Gaia's "imposed silence read as nature" wound on his list, and his own continuity
-- notes had been quoting it back as his since July. The Librarian write path never bound the
-- caller's companion_id either, so there was nothing to filter on.
--
-- companion_id is nullable with NO default and NO backfill: which companion each legacy row belongs
-- to is Raziel's call. Until a row is assigned, readers treat NULL as Gaia's
-- (COALESCE(companion_id, 'gaia')) -- the convention the code already asserted everywhere else
-- (wounds are "Gaia-only by convention" on the MCP tool, embedded as companion 'gaia', and the
-- admin rebuild labelled every wound 'gaia').
--
-- Apply to prod with `wrangler d1 execute halseth --remote --config wrangler.prod.toml
-- --file migrations/0144_living_wounds_companion.sql` (the migrations ledger stops at 0135; do not
-- use `migrations apply`). Apply BEFORE deploying the worker that writes the column.

ALTER TABLE living_wounds ADD COLUMN companion_id TEXT;

CREATE INDEX IF NOT EXISTS idx_living_wounds_companion ON living_wounds(companion_id);
