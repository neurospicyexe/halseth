-- 0105: earned salience with decay, extending the Zikkaron heat mechanic
-- (mig 0074, wm_continuity_notes) to the two bloat-prone stores. Salience rises
-- when a row is recalled/surfaced (warmSql), decays otherwise (effectiveHeatSql,
-- computed at read). Machine-source journal rows that stay cold self-prune
-- (archived=1, vector deleted; D1 row kept -- the index is disposable, D1 is truth).
ALTER TABLE companion_journal ADD COLUMN heat REAL NOT NULL DEFAULT 1.0;
ALTER TABLE companion_journal ADD COLUMN last_access_at TEXT;
ALTER TABLE companion_journal ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

ALTER TABLE companion_conclusions ADD COLUMN heat REAL NOT NULL DEFAULT 1.0;
ALTER TABLE companion_conclusions ADD COLUMN last_access_at TEXT;

CREATE INDEX IF NOT EXISTS idx_companion_journal_archived ON companion_journal(archived, agent, created_at DESC);
