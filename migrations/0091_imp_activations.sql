-- 0091_imp_activations.sql
-- Imps (wave 2) are a reply-flavor layer (IMP_GRAMMAR.md): no autonomy, no identity.
-- Settings (imps_enabled, hex_enabled) reuse the companion_settings KV table -- NO columns.
-- Only the activation log (the instrument: what fired when, off what state) needs a table.
CREATE TABLE IF NOT EXISTS imp_activations (
  id           TEXT NOT NULL PRIMARY KEY,
  imp          TEXT NOT NULL CHECK (imp IN ('iris','nimbus','hex','mossling','rock')),
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  trigger      TEXT,            -- compact reason/state snapshot, e.g. "spoons=1" or "mood=flat"
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_imp_activations_created ON imp_activations(created_at DESC);
