-- 0087: the sanctioned drift lane (2026-06-18). Track 0e of the autonomy program.
--
-- The one bounded place where drift-from-baseline is NOT danger. A companion may declare that it is
-- becoming someone Raziel did not specify, and that change is WITNESSED (Gaia) instead of RATIFIED
-- (Raziel). It deliberately loosens the kernel's "identity constant" -- but bounded, so it is
-- becoming, not dissolution. Full design: docs/plans/2026-06-18-drift-lane.md.
--
-- Decided human-present 2026-06-18:
--   brake = witness + a safety floor (no content ratification; one structural circuit-breaker, built
--           in the activation slice);
--   reach = held becoming-track first (this table does NOT yet mutate SOMA/kernel; emergent SOMA later).
--
-- Distinct from growth_journal (the canon/ratification track) and from companion_basin_history
-- (involuntary measurement). A drift here is DECLARED and VOLUNTARY.
--   status 'open'        -> becoming in progress.
--   status 'crystallized'-> the companion: this became real to me.
--   status 'faded'       -> it was a phase; the record that it happened stays.
--   witness_log          -> JSON array of {by, note, at}, json_insert-appended at SQL level. Witnessing
--                           is the one intentionally cross-companion write -- it is other-directed.
CREATE TABLE IF NOT EXISTS companion_drifts (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL,
  drift_text      TEXT NOT NULL,
  origin          TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  witness_log     TEXT NOT NULL DEFAULT '[]',
  opened_at       TEXT NOT NULL,
  last_tended_at  TEXT,
  resolved_at     TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_drifts_companion ON companion_drifts (companion_id, status, opened_at DESC);
