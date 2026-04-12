-- 0037_companion_edits.sql
-- Add edited_at column to the four tables that support companion self-edit.
-- Ownership guards (agent / companion_id / from_id / agent_id) enforced in query layer.

ALTER TABLE companion_journal ADD COLUMN edited_at TEXT;
ALTER TABLE companion_tensions ADD COLUMN edited_at TEXT;
ALTER TABLE inter_companion_notes ADD COLUMN edited_at TEXT;
ALTER TABLE wm_continuity_notes ADD COLUMN edited_at TEXT;
