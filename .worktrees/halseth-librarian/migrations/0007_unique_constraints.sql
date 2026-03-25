-- Idempotency constraints for bootstrap-seeded data.
-- INSERT OR IGNORE in admin.ts will now correctly skip duplicates on name/subject
-- when bootstrap is re-run. Without these indexes, the random UUID primary key
-- never triggers the IGNORE clause, causing duplicate rows on each run.
--
-- Rollback if needed: DROP INDEX idx_wounds_name_unique; DROP INDEX idx_fossils_subject_unique;
-- Safe to roll back — no data loss.

CREATE UNIQUE INDEX IF NOT EXISTS idx_wounds_name_unique     ON living_wounds(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fossils_subject_unique ON prohibited_fossils(subject);
