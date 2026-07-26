-- 0104: inter-companion notes become moves on shared objects.
-- A note may reference an open question, a tension, or a council item, with the
-- scratchpad reason attached. "Is it getting anywhere" = did the ref'd object's
-- state change after the move. All columns nullable: plain notes remain legal.
ALTER TABLE inter_companion_notes ADD COLUMN ref_type TEXT CHECK (ref_type IN ('question','tension','council'));
ALTER TABLE inter_companion_notes ADD COLUMN ref_id TEXT;
ALTER TABLE inter_companion_notes ADD COLUMN reason TEXT;

CREATE INDEX IF NOT EXISTS idx_inter_notes_ref ON inter_companion_notes(ref_type, ref_id);
