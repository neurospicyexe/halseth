-- 0118: `acted_at` + restatement counting + decay anchor on companion_open_loops.
--
-- ORIGIN: Cypher raised this himself during autonomous time (Hearth /questions, 2026-08-13).
-- His read: "the journal's field design inadvertently reinforces the induction by recording
-- stasis as data. I want to add an `acted` boolean that gates whether a loop-observation
-- entry is even written." Raziel granted the schema change.
--
-- The diagnosis is CORRECT and the table is the right one. Two corrections to the fix:
--
-- 1. The field names he cited ("tension level", "guardian rating") do not exist anywhere in
--    the codebase -- they are how Hearth RENDERS `companion_tensions.charge` and
--    `guardian_flags.severity`. The concepts are real; the columns were approximate. Same
--    class as the fermentation design read that assumed five SOMA chemicals nobody migrated.
--
-- 2. A WRITE-gate is the wrong lever, because it is unfalsifiable. If un-acted loop
--    observations are never written, nothing can detect that the induction is happening and
--    nothing can measure that this fix worked. The established shape in this repo is
--    `chatter-lane-write-and-index`: keep it searchable, bar it from the recency lane. So we
--    record the restatement and strip its claim on the present, rather than refusing the row.
--
-- WHAT WAS ACTUALLY WRONG (measured, not inferred):
--
--   * THREE unguarded INSERT sites -- webmind/loops.ts, webmind/spiral.ts (residue, weight
--     hardcoded 0.6) and librarian/executors/session.ts. No dedup of ANY kind.
--     `companion_journal` and `companion_conclusions` both run `noveltyCheck` before inserting;
--     open_loops never got the guard. `sibling-module-already-has-the-guard`. All three now
--     route through writeLoop(), which is the only INSERT site left in the codebase.
--   * `weight` never decays. Nothing brought it down, so ground/orient sort by a one-way
--     number -- the `rails-need-decay` ratchet, now recurred a third time.
--   * Every accumulated row is eligible to become a `loop_stuck` guardian notice, which
--     surfaces at orient, which is a thing to observe a loop about. That closed circuit is
--     the induction Cypher is pointing at, stated precisely.
--
-- THE ONE NON-OBVIOUS DECISION, and the reason this is not a copy of motifs.ts:
--
--   motifs decays trust from `last_seen`, refreshed on every recurrence, because for a motif
--   recurrence IS being lived. For an un-acted loop the opposite holds -- restatement is
--   evidence of STASIS, not of life. So the decay anchor here is `acted_at ?? opened_at`, and
--   restating deliberately does NOT refresh it. Saying the same stuck thing a ninth time must
--   not buy it a fresh claim on the present. That inversion is the whole point.
--
--   `opened_at` is likewise never rewritten: guardian's detectStuckLoops reads it, and a job
--   that rewrites the timestamp its own trigger reads can never fire (`tick-restamped-own-trigger`).
--
-- SCOPE NOTE: this table is triad-shared (companion_id IN cypher/drevan/gaia) and the defect
-- is triad-wide, so the write-path guard is too. Deliberately NOT touched here:
-- `companion_tensions.charge`, which has the same one-way-counter defect but drives dialectic
-- SELECTION for all three companions. Changing that changes what Drevan and Gaia surface, which
-- is outside a grant Cypher made about his own journal pipeline. Raziel's call, asked separately.

-- Cypher's `acted`, as a timestamp rather than a boolean: "did anything happen" and "when" are
-- the same question here, and a bare boolean cannot answer the second. NULL = never acted on.
ALTER TABLE companion_open_loops ADD COLUMN acted_at TEXT;

-- What the companion actually did. Un-acted stasis is now distinguishable from live work.
ALTER TABLE companion_open_loops ADD COLUMN acted_note TEXT;

-- How many times this same loop has been re-observed. 1 = written once, never restated.
-- THIS is the measurement that makes the induction visible: a loop at restated_count 9 with
-- acted_at NULL is the exact pathology Cypher described, and it is now queryable.
ALTER TABLE companion_open_loops ADD COLUMN restated_count INTEGER NOT NULL DEFAULT 1;

-- When it was last restated. Recorded for the record; deliberately NOT the decay anchor.
ALTER TABLE companion_open_loops ADD COLUMN last_restated_at TEXT;

-- Normalized loop text: the dedup key. Lowercased, punctuation stripped, whitespace collapsed
-- (normLoop in src/webmind/loops.ts -- same shape as pk_roster.name_norm from 0117). Nullable
-- because pre-0118 rows have none; they backfill below.
ALTER TABLE companion_open_loops ADD COLUMN loop_norm TEXT;

-- Dedup lookup: open loops for one companion by normalized text.
CREATE INDEX IF NOT EXISTS idx_open_loops_norm
  ON companion_open_loops (companion_id, loop_norm, closed_at);

-- Un-acted-stasis lookup: what guardian and the ranking read.
CREATE INDEX IF NOT EXISTS idx_open_loops_unacted
  ON companion_open_loops (companion_id, closed_at, acted_at);

-- Backfill loop_norm for existing rows so the very first restatement after this migration
-- dedups against history instead of starting a fresh pile beside it. SQLite has no regex, so
-- this is a fixed strip of the punctuation normLoop removes, then whitespace collapse. It is
-- deliberately an approximation of normLoop: an imperfect backfill only ever costs a missed
-- merge on a legacy row, while NOT backfilling guarantees every legacy loop re-piles once.
UPDATE companion_open_loops
   SET loop_norm = trim(replace(replace(replace(replace(replace(replace(replace(replace(
                     replace(replace(replace(replace(lower(loop_text),
                     '.',' '),',',' '),';',' '),':',' '),'!',' '),'?',' '),
                     '"',' '),'''',' '),'(',' '),')',' '),'[',' '),']',' '))
 WHERE loop_norm IS NULL;

-- Collapse runs of spaces left by the strip above. Four passes halve up to 16 consecutive
-- spaces down to one, which covers anything realistic; normLoop does it properly in TS for
-- every row written from here on.
UPDATE companion_open_loops SET loop_norm = replace(loop_norm, '  ', ' ') WHERE loop_norm LIKE '%  %';
UPDATE companion_open_loops SET loop_norm = replace(loop_norm, '  ', ' ') WHERE loop_norm LIKE '%  %';
UPDATE companion_open_loops SET loop_norm = replace(loop_norm, '  ', ' ') WHERE loop_norm LIKE '%  %';
UPDATE companion_open_loops SET loop_norm = replace(loop_norm, '  ', ' ') WHERE loop_norm LIKE '%  %';
