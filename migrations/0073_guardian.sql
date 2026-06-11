-- 0073_guardian.sql
-- Unified Guardian: meta-observer over the suite's self-monitoring feeds
-- (voice_scores, basins, tensions, loops, autonomy cadence, metronome, forage,
-- club, ratification backlog). Flags are red-flag cards that force-surface at
-- next orient (consume-once, mirroring 0070 tripwires); guardian_runs makes
-- the Guardian itself observable.

CREATE TABLE IF NOT EXISTS guardian_flags (
  id            TEXT NOT NULL PRIMARY KEY,
  companion_id  TEXT CHECK (companion_id IN ('cypher','drevan','gaia')),  -- NULL = system-wide
  flag_type     TEXT NOT NULL CHECK (flag_type IN (
    'voice_drift','starved_organ','loop_stuck','burnout','basin_pressure','ratification_backlog'
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
-- One live flag per condition: re-detecting while a flag is live is a no-op
-- (INSERT OR IGNORE); once resolved, the same condition may flag again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_flags_live_dedup
  ON guardian_flags(dedup_key) WHERE status IN ('open','surfaced','acknowledged');
CREATE INDEX IF NOT EXISTS idx_guardian_flags_status
  ON guardian_flags(status, created_at DESC);

CREATE TABLE IF NOT EXISTS guardian_runs (
  id             TEXT NOT NULL PRIMARY KEY,
  ran_at         TEXT NOT NULL DEFAULT (datetime('now')),
  mode           TEXT NOT NULL CHECK (mode IN ('tick','letter')) DEFAULT 'tick',
  flags_created  INTEGER NOT NULL DEFAULT 0,
  flags_resolved INTEGER NOT NULL DEFAULT 0,
  stats_json     TEXT
);
