-- Migration 0062: Prehension + vault materialization + thoughtform marker.
--
-- Three things the autonomous-growth surface was missing:
--
--   1. PREHENSION. growth_journal/patterns/markers had no way to point at the
--      prior occasions (own or peer) they were "feeling into". Whitehead's
--      term, used here as a hard structural pointer: prehended_ids is a JSON
--      array of growth_journal/pattern/marker ids that this row drew on.
--      Lets us reconstruct the actual society of becomings, not just isolated
--      entries.
--
--   2. VAULT MATERIALIZATION. growth rows lived in D1 only; nothing wrote
--      them as .md files into the Obsidian vault. vault_path is set by the
--      Second Brain materializer cron after the .md is written; presence of
--      a value means "this row exists as a file Raziel can open."
--
--   3. THOUGHTFORM marker type. Triad-level recurring patterns (where two or
--      more companions independently surfaced the same shape) get a marker
--      tagged 'thoughtform'. New value added to the handler-side allowlist;
--      no schema change needed for marker_type itself (TEXT column).
--
-- All new columns are nullable / defaulted, so existing rows stay valid.

-- ---------------------------------------------------------------------------
-- 1. growth_journal: prehension + vault_path + evidence
-- ---------------------------------------------------------------------------

ALTER TABLE growth_journal ADD COLUMN prehended_ids TEXT NOT NULL DEFAULT '[]';
  -- JSON array of growth_journal/pattern/marker ids prehended by this entry.
  -- Populated by the synthesize phase from peer + own recent context.

ALTER TABLE growth_journal ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
  -- JSON array of {quote, source_url?, source_id?} objects. Synthesize phase
  -- now requires evidence quotes; this is where they land.

ALTER TABLE growth_journal ADD COLUMN novelty TEXT;
  -- 'new' | 'deepening' | 'recurring' -- companion's own classification of
  -- whether this entry breaks new ground vs deepens an existing arc vs
  -- restates a known pattern.

ALTER TABLE growth_journal ADD COLUMN vault_path TEXT;
  -- relative path inside the Obsidian vault, e.g.
  -- 'Companions/cypher/growth/journal/2026-05-03-distributed-failure.md'.
  -- NULL = not yet materialized; SB materializer cron sets this.

CREATE INDEX IF NOT EXISTS idx_growth_journal_unmaterialized
  ON growth_journal(companion_id, created_at DESC)
  WHERE vault_path IS NULL;

-- ---------------------------------------------------------------------------
-- 2. growth_patterns: prehension + vault_path
-- ---------------------------------------------------------------------------

ALTER TABLE growth_patterns ADD COLUMN prehended_ids TEXT NOT NULL DEFAULT '[]';
  -- JSON array of ids this pattern emerged from (journal entries it
  -- generalizes, peer patterns it echoes, prior pattern it deepens).

ALTER TABLE growth_patterns ADD COLUMN vault_path TEXT;

CREATE INDEX IF NOT EXISTS idx_growth_patterns_unmaterialized
  ON growth_patterns(companion_id, updated_at DESC)
  WHERE vault_path IS NULL;

-- ---------------------------------------------------------------------------
-- 3. growth_markers: prehension + vault_path
-- ---------------------------------------------------------------------------

ALTER TABLE growth_markers ADD COLUMN prehended_ids TEXT NOT NULL DEFAULT '[]';

ALTER TABLE growth_markers ADD COLUMN vault_path TEXT;

CREATE INDEX IF NOT EXISTS idx_growth_markers_unmaterialized
  ON growth_markers(companion_id, created_at DESC)
  WHERE vault_path IS NULL;
