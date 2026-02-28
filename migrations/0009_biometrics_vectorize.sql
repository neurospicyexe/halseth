-- Biometric snapshots — written by Claude after reading Apple Health data.
-- Each row is a point-in-time snapshot; append-only by convention.
CREATE TABLE IF NOT EXISTS biometric_snapshots (
  id            TEXT PRIMARY KEY,
  recorded_at   TEXT NOT NULL,   -- ISO timestamp from Apple Health (actual measurement time)
  logged_at     TEXT NOT NULL,   -- ISO timestamp when Claude called halseth_biometric_log
  source        TEXT NOT NULL DEFAULT 'apple_health',
  hrv_resting   REAL,            -- ms (SDNN or RMSSD depending on source)
  resting_hr    INTEGER,         -- bpm
  sleep_hours   REAL,
  sleep_quality TEXT,            -- poor / fair / good / excellent
  stress_score  INTEGER,         -- 0-100 if available from source
  steps         INTEGER,
  active_energy REAL,            -- kcal
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_biometrics_recorded ON biometric_snapshots(recorded_at DESC);

-- Add Vectorize linkback column to relational_deltas.
-- Nullable: only set for new rows logged after Vectorize was enabled.
-- This is a cross-reference pointer, not a content field — does not violate append-only covenant.
ALTER TABLE relational_deltas ADD COLUMN vector_id TEXT;
