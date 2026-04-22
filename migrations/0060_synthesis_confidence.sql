-- 0060_synthesis_confidence.sql
-- Add confidence score and evidence count to synthesis_summary.
-- confidence: 0.0-1.0; starts at 0.6 for new entries, boosted by multi-session corroboration.
-- evidence_count: number of source events (deltas + notes) that fed this synthesis run.
ALTER TABLE synthesis_summary ADD COLUMN confidence REAL DEFAULT 0.6;
ALTER TABLE synthesis_summary ADD COLUMN evidence_count INTEGER DEFAULT 1;
