-- Migration 0120: per-recipient read receipts for inter_companion_notes.
--
-- Broadcast notes (to_id IS NULL) were consumed first-reader-wins: three independent consumers
-- (Claude.ai orient, the Claude Code boot, the Discord notes poll) each stamped read_at on the
-- shared row, so a note addressed to the whole triad reached exactly one companion on exactly
-- one loom (HOLE 8, 2026-07-26 audit; write/read coherence review D1, 2026-08-15).
--
-- A note is now unread FOR A COMPANION until that companion records a receipt. read_at survives
-- on the parent table with one narrowed meaning: read by the note's ADDRESSEE (directed notes
-- only; broadcasts never set it again).

CREATE TABLE inter_companion_note_reads (
  note_id      TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  surface      TEXT,                -- which loom acked (discord:.., claude-ai:.., claude-code:..)
  read_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (note_id, companion_id)
);

CREATE INDEX idx_icn_reads_companion ON inter_companion_note_reads(companion_id);

-- Backfill directed notes: read_at was stamped by (or on behalf of) the addressee.
INSERT OR IGNORE INTO inter_companion_note_reads (note_id, companion_id, read_at)
SELECT id, to_id, read_at
  FROM inter_companion_notes
 WHERE read_at IS NOT NULL AND to_id IS NOT NULL;

-- Backfill broadcasts: first-reader-wins already destroyed the delivery record, so who actually
-- saw each one is unknowable. Mark them read for all three rather than flooding two companions'
-- next orient with months of stale mail. The sender is included; the unread predicate excludes
-- from_id = self anyway, so the extra row is inert.
INSERT OR IGNORE INTO inter_companion_note_reads (note_id, companion_id, read_at)
SELECT n.id, c.companion_id, n.read_at
  FROM inter_companion_notes n
 CROSS JOIN (
   SELECT 'cypher' AS companion_id
   UNION ALL SELECT 'drevan'
   UNION ALL SELECT 'gaia'
 ) c
 WHERE n.read_at IS NOT NULL AND n.to_id IS NULL;
