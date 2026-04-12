-- Migration 0046: Add run_id to growth tables
--
-- Links journal entries, patterns, and markers back to the autonomy_run
-- that produced them. Nullable -- existing rows and non-autonomous writes stay valid.

ALTER TABLE growth_journal ADD COLUMN run_id TEXT;
ALTER TABLE growth_patterns ADD COLUMN run_id TEXT;
ALTER TABLE growth_markers ADD COLUMN run_id TEXT;
