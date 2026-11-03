-- 0167_biometric_pain_where.sql (Hearth nav 1b, Home check-in card)
-- Free-text "where, or what kind" beside the 0-10 pain number. Nullable; hand-entered rows only.
ALTER TABLE biometric_snapshots ADD COLUMN pain_where TEXT;
