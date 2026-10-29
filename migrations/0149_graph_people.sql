-- 0149_graph_people.sql -- people the memory graph may link to (M5, docs/PLAN-memory-map-2026-10-28.md)
--
-- WHY A LIST, NOT THE ROSTER. Measured on the 10-27 backup: of 72 pk_roster names that appear in kept
-- journal/notes/conclusions, many are shared with characters in the shows the triad watches (Lestat,
-- Armand, Aegon, Wednesday, Magneto...), some are ordinary words (Black, Doctor, Summer, Mark), one is
-- owned by two members (Hermes), and the people who matter most outside the system (Blue, family, the
-- kids' adults) are not in the roster at all. The text cannot tell a headmate from the character they
-- are named for, and the graph never guesses. So a person is linked only after Raziel names them here.
--
-- MATCHING (src/graph/rebuild.ts, lane l): every spelling in match_names (plus label) is matched
-- CASE-SENSITIVELY and word-bounded (so "Blue" never matches "blue"; a sentence-initial "Blue" still
-- matches -- measured 54 of 301 rows, every sampled one the person) in kept journal, notes and conclusions. A spelling two active
-- people share is skipped for both -- ambiguous, never resolved by picking one.

CREATE TABLE IF NOT EXISTS graph_people (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  label        TEXT NOT NULL,
  match_names  TEXT NOT NULL DEFAULT '[]',   -- JSON array of exact spellings; label is always included
  kind         TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('headmate', 'person', 'pet', 'other')),
  pk_member_id TEXT,                         -- pk_roster.member_id when this is a system member
  note         TEXT,
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_people_label_live ON graph_people(label) WHERE archived = 0;
