-- 0081: subjective ND-state layer on biometric_snapshots
-- The hardware metrics (HRV/HR/sleep/steps) only capture the body. Raziel wants the
-- lived signals tracked in detail too: meds, pain, mood, spoons -- the things easy to
-- forget to say in chat. Ranges validated in the handler (matches the existing
-- stress_score / sleep_quality pattern -- no DB CHECK on those either).
ALTER TABLE biometric_snapshots ADD COLUMN mood       TEXT;     -- free-text felt state
ALTER TABLE biometric_snapshots ADD COLUMN pain       INTEGER;  -- 0-10 subjective
ALTER TABLE biometric_snapshots ADD COLUMN energy     INTEGER;  -- 0-10 subjective
ALTER TABLE biometric_snapshots ADD COLUMN focus      INTEGER;  -- 0-10 subjective (exec function)
ALTER TABLE biometric_snapshots ADD COLUMN spoons     INTEGER;  -- 0-12 spoons remaining
ALTER TABLE biometric_snapshots ADD COLUMN meds_taken INTEGER;  -- 0/1 boolean
