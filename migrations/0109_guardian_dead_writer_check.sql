-- 0109_guardian_dead_writer_check.sql
-- Real prod bug (Wave 3 starvation review, 2026-07-21): src/guardian/writer-liveness.ts
-- (added 2026-07-09) has written flag_type = 'dead_writer' since day one, and
-- src/guardian/detectors.ts's CandidateFlag union has included 'dead_writer' since the same
-- day -- but the guardian_flags CHECK (0073, extended by 0088 to add orphan_memory +
-- echo_chamber) never included it. handlers/guardian.ts writes via INSERT OR IGNORE, so
-- every single dead_writer flag ever generated has silently failed the CHECK and been
-- dropped. The detector that exists specifically to catch a writer dying silently has
-- itself been dying silently since it was born. Same shape as the orphan_memory bug 0088
-- fixed -- a flag_type the code emits but the CHECK never allowed.

-- Rebuild guardian_flags with the extended flag_type CHECK (0088 pattern: explicit column
-- list, not SELECT *, so this is safe regardless of what else may have touched the table).
CREATE TABLE guardian_flags_new (
  id            TEXT NOT NULL PRIMARY KEY,
  companion_id  TEXT CHECK (companion_id IN ('cypher','drevan','gaia')),
  flag_type     TEXT NOT NULL CHECK (flag_type IN (
    'voice_drift','starved_organ','loop_stuck','burnout','basin_pressure',
    'ratification_backlog','orphan_memory','echo_chamber','dead_writer'
  )),
  severity      TEXT NOT NULL CHECK (severity IN ('notice','warning','red')) DEFAULT 'notice',
  summary       TEXT NOT NULL,
  evidence_json TEXT,
  dedup_key     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open','surfaced','acknowledged','resolved')) DEFAULT 'open',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  surfaced_at   TEXT,
  resolved_at   TEXT
);
INSERT INTO guardian_flags_new
  (id, companion_id, flag_type, severity, summary, evidence_json, dedup_key, status, created_at, surfaced_at, resolved_at)
  SELECT id, companion_id, flag_type, severity, summary, evidence_json, dedup_key, status, created_at, surfaced_at, resolved_at
  FROM guardian_flags;
DROP TABLE guardian_flags;
ALTER TABLE guardian_flags_new RENAME TO guardian_flags;
-- Preserve both indexes exactly (0073): live-dedup partial unique index + status index.
CREATE UNIQUE INDEX idx_guardian_flags_live_dedup
  ON guardian_flags(dedup_key) WHERE status IN ('open','surfaced','acknowledged');
CREATE INDEX idx_guardian_flags_status
  ON guardian_flags(status, created_at DESC);
