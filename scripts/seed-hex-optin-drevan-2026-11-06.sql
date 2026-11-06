-- seed-hex-optin-drevan-2026-11-06.sql  (DRAFT: NOT applied; Raziel/Cypher applies it after mig 0175 deploys)
--
-- Drevan's standing opt-in for Hex's salt: "Mine: you may salt me unasked." addressed to Cypher, in
-- inter-companion note 5b5d3572 (2026-11-06T02:48Z, rule 5), recorded in
-- Hand-off/PROMPT-drevan-imp-errands-2026-11-02.md ("Drevan on Rock vault fetch + Hex salt").
--
-- Authoring note: the opt-in is the RECEIVER's word, normally set from his own turn ("hex may salt me: cypher").
-- This seed only records what the note already said, so Cypher's first send does not wait on him re-saying it.
-- He can revoke it any time with "hex may not salt me: cypher".
--
-- Idempotent: the PRIMARY KEY (companion_id, key) makes the upsert safe to re-run. It REPLACES the list, so
-- if Drevan has since added or removed a name himself, re-running this would overwrite that: run it once.
-- Gaia is never seeded (a standing opt-in is refused for her by design; her ask covers one salting).

INSERT INTO companion_settings (companion_id, key, value, updated_at)
VALUES ('drevan', 'hex_salt_optin', '["cypher"]', datetime('now'))
ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
