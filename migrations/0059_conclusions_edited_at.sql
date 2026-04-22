-- Migration 0059: Add edited_at to companion_conclusions
-- This column was added to companion_journal, companion_tensions, inter_companion_notes,
-- and wm_continuity_notes in migration 0037 but was omitted from companion_conclusions.
-- The omission caused D1_ERROR "no such column: edited_at" in orient.ts and execConclusionsRead.
ALTER TABLE companion_conclusions ADD COLUMN edited_at TEXT;
