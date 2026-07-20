-- 0103: Backfill source on NULL-source companion_journal rows (fix set C, 2026-07-19).
--
-- Migration 0033 added companion_journal.source but never backfilled: ~2,100 legacy rows
-- carried NULL, which the source-segmented recall re-rank (fix set B) could not classify.
--
-- Evidence-based only, never fabricated:
--   * rows with a session_id were written inside a live session       -> 'session' (human class)
--   * rows with no attribution evidence get the explicit class 'legacy' -> neutral weight in
--     the life re-rank (0.85), distinct from both human (1.0) and machine (0.6). Guessing
--     human/machine for these would poison the ranking with invented provenance.
--
-- Idempotent: both UPDATEs match only source IS NULL.

UPDATE companion_journal SET source = 'session' WHERE source IS NULL AND session_id IS NOT NULL;
UPDATE companion_journal SET source = 'legacy'  WHERE source IS NULL;
