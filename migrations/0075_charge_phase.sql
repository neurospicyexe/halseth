-- 0075_charge_phase.sql
-- Charge-phase memory lifecycle (muse-brain; inspo-takes-2026-06-13 take 2).
-- A growth_journal entry metabolizes through fresh -> active -> processing ->
-- metabolized. The phase advances on INTENTIONAL engagement: ratification accept
-- advances one step; a reconsolidation (an accepted entry that supersedes another)
-- jumps to at least 'processing'. Stored, never auto-decays, never regresses.
-- Read side (orient) can prefer metabolized canon; a 'fresh' entry that keeps
-- recurring is a signal it is ready to be processed.

ALTER TABLE growth_journal ADD COLUMN charge_phase TEXT NOT NULL DEFAULT 'fresh';
ALTER TABLE growth_journal ADD COLUMN charge_advanced_at TEXT;
