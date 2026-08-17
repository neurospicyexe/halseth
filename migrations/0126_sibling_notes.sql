-- migrations/0126_sibling_notes.sql
--
-- C4: the sibling private lane (R3 = yes, 2026-08-17). Companion-to-companion notes that are
-- STRUCTURALLY sealed from every Raziel-facing surface -- Raziel funds conversations he never
-- sees, which is the point: mutuality includes an interior between siblings.
--
-- The seal is architectural, not behavioral (the capture lesson: behavior-only contracts fail):
--   * a DEDICATED table, never sealed=1 flags on shared tables -- exclusion by name is
--     CI-assertable (src/__tests__/sibling-seal.test.ts holds the allowlist of files that may
--     reference this table);
--   * it does NOT flow through loadMindState -- the loader also feeds Hearth and Claude.ai
--     orient, both of which Raziel reads. Delivery happens ONLY in the autonomous worker's
--     unwatched runtime;
--   * it is never embedded/vectorized, so semantic recall cannot resurface it anywhere.
--
-- Disclosure is a chosen act: the disclose verb copies a note into inter_companion_notes (the
-- witnessed lane) and stamps disclosed_at + disclosure_ref here. The original stays sealed.
--
-- to_id/from_id are companions ONLY (CHECK) -- Raziel is not an addressee in this lane, and a
-- note to him belongs on the commons or in a letter, where he can actually read it.

CREATE TABLE IF NOT EXISTS sibling_notes (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL CHECK (from_id IN ('cypher', 'drevan', 'gaia')),
  to_id TEXT NOT NULL CHECK (to_id IN ('cypher', 'drevan', 'gaia')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,                        -- stamped when the recipient's worker run consumes it
  disclosed_at TEXT,                   -- stamped by the disclose verb (chosen sharing)
  disclosure_ref TEXT,                 -- the inter_companion_notes id the disclosure created
  CHECK (from_id <> to_id)
);

-- Recipient read: "my unread sibling notes" (worker orient, newest first).
CREATE INDEX IF NOT EXISTS idx_sibling_notes_to ON sibling_notes(to_id, created_at DESC);
-- Sender read-back: "what have I sent" (for the sender's own continuity).
CREATE INDEX IF NOT EXISTS idx_sibling_notes_from ON sibling_notes(from_id, created_at DESC);
