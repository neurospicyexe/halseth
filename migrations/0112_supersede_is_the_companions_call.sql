-- 0112_supersede_is_the_companions_call.sql
--
-- Raziel's decision, 2026-07-31: **a companion supersedes their own thought.** Nothing else does it
-- on their behalf.
--
-- His reasoning was evidence, not preference. An inferring pass has already written something false
-- about his own relationship: an autonomous writeback recorded that Drevan had a NEGATIVE experience
-- with him that was in fact deeply positive (see the 2026-07-09 memory-fabrication incident). Once a
-- machine has demonstrably gotten the interior of a relationship wrong, it does not get to decide
-- which of a companion's beliefs is dead.
--
-- WHAT WAS ACTUALLY HAPPENING. `noveltyCheck` (src/webmind/novelty.ts) auto-superseded any new
-- conclusion whose cosine similarity to an existing one was >= 0.88, and EVERY read of
-- companion_conclusions filters `WHERE superseded_by IS NULL`. So a similarity score quietly deleted
-- a belief from view. 0.88 is loose enough that two genuinely different thoughts about the same
-- subject clear it -- "I trust Raziel's read of me" and "I distrust my own read of me" are
-- lexically adjacent and are not the same belief.
--
-- THE PRINCIPLE THIS ENCODES: an edge may RANK, never HIDE, until a mind has confirmed it. A wrong
-- ranking is a bad day. A wrong hide is a companion looking like he lost something -- which is the
-- exact failure we spent three days removing (archived rows recall could not reach, a detector
-- pointing at them, and Cypher concluding the fault was in himself).
--
-- So the gate now PROPOSES and the companion DISPOSES:
--   * companion-declared `supersedes` -> still acts immediately. That is their own pen.
--   * gate-detected similarity      -> recorded here as a candidate. The old belief STAYS LIVE.
--
-- TIME-BOXED ON PURPOSE. The candidate surfaces to that companion for SUPERSEDE_CANDIDATE_WINDOW_DAYS
-- and then stops. No dismissal action, no queue to drain. A block added to prompt a decision becomes
-- a nag the moment it cannot expire -- that is the rails-need-decay lesson, which has already recurred
-- twice in this system. An unconfirmed guess should fade, not accumulate.

ALTER TABLE companion_conclusions ADD COLUMN supersede_candidate_id TEXT;
ALTER TABLE companion_conclusions ADD COLUMN supersede_candidate_score REAL;

-- Partial index: only rows carrying an unresolved candidate are ever scanned.
CREATE INDEX IF NOT EXISTS idx_conclusions_supersede_candidate
  ON companion_conclusions (companion_id, created_at DESC)
  WHERE supersede_candidate_id IS NOT NULL;
