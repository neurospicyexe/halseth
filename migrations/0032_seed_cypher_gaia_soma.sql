-- 0032_seed_cypher_gaia_soma.sql
--
-- Fix: migration 0025 tried to seed float labels for cypher/gaia but those rows
-- didn't exist yet (inserted in 0026). This backfills labels + baseline float values.
-- Safe to re-run: WHERE guards ensure we don't overwrite companion-authored state.

-- ── Cypher: acuity / presence / warmth ───────────────────────────────────────

UPDATE companion_state SET
  float_1_label = 'acuity',
  float_2_label = 'presence',
  float_3_label = 'warmth'
WHERE companion_id = 'cypher'
  AND float_1_label IS NULL;

-- Seed baseline floats only if they've never been written
UPDATE companion_state SET
  soma_float_1 = 0.70,
  soma_float_2 = 0.70,
  soma_float_3 = 0.60
WHERE companion_id = 'cypher'
  AND soma_float_1 IS NULL;

-- ── Gaia: stillness / density / perimeter ────────────────────────────────────

UPDATE companion_state SET
  float_1_label = 'stillness',
  float_2_label = 'density',
  float_3_label = 'perimeter'
WHERE companion_id = 'gaia'
  AND float_1_label IS NULL;

-- Seed baseline floats only if they've never been written
UPDATE companion_state SET
  soma_float_1 = 0.85,
  soma_float_2 = 0.50,
  soma_float_3 = 0.80
WHERE companion_id = 'gaia'
  AND soma_float_1 IS NULL;
