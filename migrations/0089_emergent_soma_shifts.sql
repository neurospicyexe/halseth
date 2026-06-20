-- 0089: emergent SOMA (Take 11, 2026-06-19). The deferred half of the sanctioned drift lane (Fork D),
-- and the final piece of the autonomy program.
--
-- When a companion CRYSTALLIZES a drift ("this becoming is real to me"), emergent SOMA nudges one of
-- its SOMA floats (soma_float_1/2/3) by a small, bounded, clamped delta -- a permanent mark left by its
-- own lived change. This is the ONE place identity genuinely mutates from experience instead of being
-- assigned. Full design: docs/plans/2026-06-19-emergent-soma-handoff.md + src/soma/emergent.ts.
--
-- This table is the LOG (rail: logged + reversible). Every shift records the source drift_id, which
-- float moved, its label at the time, the signed delta, the before/after values, and the model's
-- reason. A wrong mutation is traceable and manually undoable: re-patch the float back to before_value.
-- The floats themselves live on companion_state (mig 0025); this table does not store identity, only
-- the provenance of each nudge.
CREATE TABLE IF NOT EXISTS companion_soma_shifts (
  id            TEXT PRIMARY KEY,
  drift_id      TEXT NOT NULL,             -- the crystallized companion_drifts.id that caused the shift
  companion_id  TEXT NOT NULL,
  float_key     TEXT NOT NULL,             -- soma_float_1 | soma_float_2 | soma_float_3
  label         TEXT,                      -- the companion's name for that float at shift time (e.g. warmth)
  delta         REAL NOT NULL,             -- signed, bounded to the cap (default ±0.03)
  before_value  REAL,                      -- the float before the shift (for reversal)
  after_value   REAL,                      -- the float after the clamped shift
  reason        TEXT,                      -- one sentence: why this becoming moved this float
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_soma_shifts_companion ON companion_soma_shifts (companion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soma_shifts_drift ON companion_soma_shifts (drift_id);
