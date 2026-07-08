-- Migration 0096: content-keyword tags on companion_journal
--
-- companion_journal.tags already exists but nothing ever populates it (2026-07-08
-- vault-tagging discussion: "tags column, never written at write time"). This adds
-- a second column, topic_tags, for free content-derived keyword tags (specific
-- nouns: people, places, projects named in the entry) -- distinct from the
-- existing tags column, which stays for categorical/domain-style tags.
--
-- Scoped to companion_journal only (2026-07-08 advisor guidance: prove the
-- read+write loop end-to-end on one table before fanning the classifier out to
-- inter_companion_notes / relational_deltas / wm_session_handoffs / companion_conclusions).

ALTER TABLE companion_journal ADD COLUMN topic_tags TEXT;
