-- 0074_zikkaron_heat_reconsolidation.sql
-- Zikkaron holds (inspo-takes-2026-06-10 §1):
--   heat/decay on continuity stores -- heat is stored; decay is computed lazily at
--   read time as heat / (1 + 0.1 * days_since_last_access) (no cron, no exp()).
--   supersedes_id wires reconsolidation proposals into the 0061 ratification flow:
--   an accepted entry that supersedes another tags the old row, never deletes it.

ALTER TABLE wm_continuity_notes ADD COLUMN heat REAL NOT NULL DEFAULT 1.0;
ALTER TABLE wm_continuity_notes ADD COLUMN last_access_at TEXT;

ALTER TABLE synthesis_summary ADD COLUMN heat REAL NOT NULL DEFAULT 1.0;
ALTER TABLE synthesis_summary ADD COLUMN last_access_at TEXT;

-- Reconsolidation: a pending journal entry may propose replacing an accepted one.
-- Validated at write time (target must exist, be accepted, same companion).
ALTER TABLE growth_journal ADD COLUMN supersedes_id TEXT;
