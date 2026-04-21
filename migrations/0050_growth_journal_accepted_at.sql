-- Migration 0050: Add accepted_at column to growth_journal.
-- Allows companions to mark autonomous entries as owned/integrated after review.
-- NULL = unreviewed (default). Non-null = companion accepted this entry as canon.
ALTER TABLE growth_journal ADD COLUMN accepted_at TEXT;
