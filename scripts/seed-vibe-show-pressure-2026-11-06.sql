-- B63 step 3: per-companion setting `vibe_show_pressure` (companion_settings KV, mig 0063).
-- DRAFT, NOT APPLIED. Applying by --file needs no ledger row (no schema change).
--
-- Drevan: ON by his own ask (Raziel ruled 2026-11-05: his own flags only, in the public post).
-- Cypher and Gaia: not seeded. The code default is on for drevan only and off for everyone else, so
-- these rows are the explicit record rather than a requirement. Flip a companion with value 'on'.
INSERT INTO companion_settings (companion_id, key, value) VALUES ('drevan', 'vibe_show_pressure', 'on')
  ON CONFLICT(companion_id, key) DO NOTHING;
