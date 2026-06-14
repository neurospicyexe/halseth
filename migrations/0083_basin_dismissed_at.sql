-- 0083: dismissed_at on companion_basin_history -- the "deny / it was noise" half of basin
-- confirm/deny triage (B2, 2026-06-14). A pressure reading has three fates now, not two:
--   caleth_confirmed = 1  -> real growth; re-baseline the identity anchor (confirm path).
--   dismissed_at  IS SET  -> measurement noise; clear the warning WITHOUT re-baselining.
--   neither (default)     -> unaddressed; the Guardian basin_pressure detector counts these.
-- Keeping dismiss separate from confirm stops a noisy stretch from being re-baselined as the
-- new normal. NULL = never dismissed (default; existing behaviour).
ALTER TABLE companion_basin_history ADD COLUMN dismissed_at TEXT;
