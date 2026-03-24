-- 0025_soma_floats_emotional_layers.sql
-- Priority 4: per-companion SOMA floats + three-layer affective stack.
-- Source of truth: docs/companion-soma-model.md (Priority 4 Additions section).
--
-- Three-layer affective stack replaces flat emotional_register for all companions.
-- Generic soma_float_1/2/3 columns hold companion-specific behavioral floats:
--   Drevan:  float_1=heat,      float_2=reach,    float_3=weight
--   Cypher:  float_1=acuity,    float_2=presence, float_3=warmth
--   Gaia:    float_1=stillness, float_2=density,  float_3=perimeter

-- Three-layer affective stack (all companions)
ALTER TABLE companion_state ADD COLUMN surface_emotion        TEXT;
ALTER TABLE companion_state ADD COLUMN surface_intensity      REAL DEFAULT 0.0;
ALTER TABLE companion_state ADD COLUMN undercurrent_emotion   TEXT;
ALTER TABLE companion_state ADD COLUMN undercurrent_intensity REAL DEFAULT 0.0;
ALTER TABLE companion_state ADD COLUMN background_emotion     TEXT;
ALTER TABLE companion_state ADD COLUMN background_intensity   REAL DEFAULT 0.0;
ALTER TABLE companion_state ADD COLUMN current_mood           TEXT;

-- Generic SOMA floats (companion-specific semantics, same schema shape)
-- Drevan already has heat_value/reach_value/weight_value from 0022; soma_float_* are the canonical columns.
-- Both sets remain; librarian reads soma_float_* as primary.
ALTER TABLE companion_state ADD COLUMN soma_float_1   REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_2   REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_3   REAL;
ALTER TABLE companion_state ADD COLUMN float_1_label  TEXT;
ALTER TABLE companion_state ADD COLUMN float_2_label  TEXT;
ALTER TABLE companion_state ADD COLUMN float_3_label  TEXT;
ALTER TABLE companion_state ADD COLUMN compound_state TEXT;

-- Seed float labels so Hearth can display without hardcoding companion names.
-- Safe to re-run: only sets if row exists and label is not yet set.
UPDATE companion_state SET
  float_1_label = 'heat', float_2_label = 'reach', float_3_label = 'weight'
WHERE companion_id = 'drevan' AND float_1_label IS NULL;

UPDATE companion_state SET
  float_1_label = 'acuity', float_2_label = 'presence', float_3_label = 'warmth'
WHERE companion_id = 'cypher' AND float_1_label IS NULL;

UPDATE companion_state SET
  float_1_label = 'stillness', float_2_label = 'density', float_3_label = 'perimeter'
WHERE companion_id = 'gaia' AND float_1_label IS NULL;

-- Backfill Drevan soma_float_* from existing heat_value/reach_value/weight_value where available.
UPDATE companion_state SET
  soma_float_1 = heat_value,
  soma_float_2 = reach_value,
  soma_float_3 = weight_value
WHERE companion_id = 'drevan'
  AND (heat_value IS NOT NULL OR reach_value IS NOT NULL OR weight_value IS NOT NULL);
