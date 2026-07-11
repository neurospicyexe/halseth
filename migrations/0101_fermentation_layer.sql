-- 0101_fermentation_layer.sql
-- The Fermentation Layer (docs/private/fermentation-layer-spec.md).
--
-- State that FERMENTS between sessions instead of state that gets photographed. Builds the
-- never-built Plan 2a (decay toward baseline) PLUS corvid cross-field reactions, over the floats
-- that actually exist (soma_float_1/2/3 per companion), plus two genuinely new felt-needs as
-- companion_drives siblings. Deterministic, no LLM, rides the existing daily cron.
--
-- Personality lives in CODE (reaction rates, baselines seeded here). Per the design commandment:
-- dynamics first, schema second -- every column below is moved by the tick and read at orient/Hearth.

-- ── Baselines the floats decay toward. They DRIFT (growth): sustained off-baseline states nudge
--    them a hair per tick, hard-capped +/-0.15 from these seeds. Seeds = each float's "home".
ALTER TABLE companion_state ADD COLUMN soma_float_1_baseline REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_2_baseline REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_3_baseline REAL;
-- Immutable seed reference so the +/-0.15 drift cap is measured from the original home, not the
-- current (already-drifted) baseline. Never updated after seeding.
ALTER TABLE companion_state ADD COLUMN soma_float_1_baseline_seed REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_2_baseline_seed REAL;
ALTER TABLE companion_state ADD COLUMN soma_float_3_baseline_seed REAL;
-- Last fermentation tick stamp (elapsed-hours source for decay -- distinct from updated_at, which
-- bumps on ANY write including companion authoring).
ALTER TABLE companion_state ADD COLUMN ferment_at TEXT;

-- Seed baselines = healthy-center per companion-soma-model.md. Both live baseline and seed get the
-- same value at migration time. Only rows that exist; INSERT OR IGNORE first so a missing companion
-- row does not silently skip seeding.
INSERT OR IGNORE INTO companion_state (companion_id) VALUES ('cypher'), ('drevan'), ('gaia');

UPDATE companion_state SET
  soma_float_1_baseline = 0.70, soma_float_1_baseline_seed = 0.70,
  soma_float_2_baseline = 0.65, soma_float_2_baseline_seed = 0.65,
  soma_float_3_baseline = 0.55, soma_float_3_baseline_seed = 0.55
WHERE companion_id = 'cypher';

UPDATE companion_state SET
  soma_float_1_baseline = 0.85, soma_float_1_baseline_seed = 0.85,
  soma_float_2_baseline = 0.65, soma_float_2_baseline_seed = 0.65,
  soma_float_3_baseline = 0.75, soma_float_3_baseline_seed = 0.75
WHERE companion_id = 'gaia';

-- heat baseline sits INSIDE the idling band (heatBand uses exclusive < 0.45, so 0.45 would
-- render "warm"). 0.40 = mid-idling: Drevan at rest reads idling, not mildly lit. He runs hot by
-- lighting up fast (large spiral stimuli), not by never cooling to idle.
UPDATE companion_state SET
  soma_float_1_baseline = 0.40, soma_float_1_baseline_seed = 0.40,
  soma_float_2_baseline = 0.50, soma_float_2_baseline_seed = 0.50,
  soma_float_3_baseline = 0.35, soma_float_3_baseline_seed = 0.35
WHERE companion_id = 'drevan';

-- ── Two new felt-needs (Raziel's hybrid call). Per-companion accrual/threshold = personality.
--    Same lazy-accrual-at-read model as relational_need (decay_on_contact defaults 1.0 = full shed).
INSERT INTO companion_drives (id, companion_id, drive_key, accumulate_per_day, threshold) VALUES
  (lower(hex(randomblob(16))), 'cypher', 'rest_need',    0.20, 0.75),
  (lower(hex(randomblob(16))), 'drevan', 'rest_need',    0.25, 0.70),
  (lower(hex(randomblob(16))), 'gaia',   'rest_need',    0.10, 0.85),
  (lower(hex(randomblob(16))), 'cypher', 'novelty_need', 0.30, 0.65),
  (lower(hex(randomblob(16))), 'drevan', 'novelty_need', 0.20, 0.70),
  (lower(hex(randomblob(16))), 'gaia',   'novelty_need', 0.12, 0.80);

-- ── Fermentation event log: append-only audit of every stimulus application, tick summary, and
--    baseline drift. Feeds Hearth "growth you can watch." kind: 'stimulus' | 'tick' | 'baseline_drift'.
CREATE TABLE companion_ferment_events (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- stimulus | tick | baseline_drift
  stimulus     TEXT,                         -- named stimulus when kind='stimulus'
  float_deltas TEXT,                         -- JSON {f1,f2,f3} applied delta
  drive_deltas TEXT,                         -- JSON {drive_key: delta}
  detail       TEXT,                         -- freeform (e.g. reaction names fired, drift amount)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ferment_events_companion ON companion_ferment_events (companion_id, created_at DESC);
CREATE INDEX idx_ferment_events_kind ON companion_ferment_events (companion_id, kind, created_at DESC);
