-- 0154_growth_pending_index.sql -- a partial index for "growth awaiting Raziel's review"
--
-- Hearth redesign P2 ("Needs you", final review I3). The tab badge calls GET /raziel/needs/count on
-- every navigation and app-switch, and /needs lists the same rows. The growth predicate is
-- RATIFIABLE_PENDING_SQL (src/lib/ratifiable.ts):
--   (source = 'autonomous' OR (source = 'reflection' AND tags_json LIKE '%"needs-raziel"%'))
--   AND review_status = 'pending'
-- 0061's idx_growth_journal_pending is partial on review_status = 'pending' AND source = 'autonomous';
-- the OR means the query does not imply that WHERE, so SQLite could not use it and every badge refresh
-- full-scanned growth_journal (which the nightly reflect phase grows without bound) against the
-- free-tier row-read budget 0128 defends.
-- This index's WHERE is the top-level AND term alone, so both the count and the
-- ORDER BY created_at DESC list use it. It stays small because pending rows get reviewed.
-- Named review_pending, not pending: idx_growth_journal_pending already exists (0061), and
-- IF NOT EXISTS on that name would silently create nothing. Additive only.

CREATE INDEX IF NOT EXISTS idx_growth_journal_review_pending
  ON growth_journal(created_at DESC)
  WHERE review_status = 'pending';
