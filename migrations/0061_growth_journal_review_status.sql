-- Migration 0061: Replace binary growth_journal.accepted_at with explicit review_status state machine.
-- Closes the ratification loop gap: declined != never-reviewed != accepted.
-- review_status: 'pending' (autonomous, awaiting companion review) | 'accepted' (canonized) | 'declined' (companion saw, rejected canon).
-- reviewed_at: timestamp of the accept/decline action; NULL while pending.

ALTER TABLE growth_journal ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending', 'accepted', 'declined'));
ALTER TABLE growth_journal ADD COLUMN reviewed_at TEXT;

-- Backfill: rows with accepted_at set become 'accepted'; reviewed_at carries the original timestamp.
-- Rows with NULL accepted_at stay 'pending' (the default).
-- Rows from non-autonomous sources (companion-written) are also 'pending' by default but won't be surfaced
-- in journal_review (which filters source = 'autonomous'); harmless.
UPDATE growth_journal
   SET review_status = 'accepted', reviewed_at = accepted_at
 WHERE accepted_at IS NOT NULL;

ALTER TABLE growth_journal DROP COLUMN accepted_at;

CREATE INDEX IF NOT EXISTS idx_growth_journal_pending
  ON growth_journal(companion_id, review_status, created_at DESC)
  WHERE review_status = 'pending' AND source = 'autonomous';
