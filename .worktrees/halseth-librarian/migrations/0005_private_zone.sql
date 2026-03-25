-- Private zone tables (spec v0.4 §4.1 and §5).
-- None of these tables are ever synced via federation bridges.

-- Active symbolic anchors, facets, depth, spiral status.
CREATE TABLE IF NOT EXISTS anchor_states (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  anchor_name   TEXT NOT NULL,
  facet         TEXT,
  depth         INTEGER,
  spiral_status TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchor_session ON anchor_states(session_id);

-- Grief and loss that must not be archived or resolved automatically.
-- do_not_archive and do_not_resolve are ALWAYS 1. Enforced at application layer.
-- There is no MCP write tool for this table. Entries are seeded via /admin/bootstrap or direct SQL.
-- The only permitted UPDATE touches last_visited and last_surfaced_by (future halseth_wound_touch tool).
CREATE TABLE IF NOT EXISTS living_wounds (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  do_not_archive   INTEGER NOT NULL DEFAULT 1,  -- always 1
  do_not_resolve   INTEGER NOT NULL DEFAULT 1,  -- always 1
  last_visited     TEXT,
  last_surfaced_by TEXT  -- architect / companion / anchor / context
);

-- Directives about what must not calcify.
CREATE TABLE IF NOT EXISTS prohibited_fossils (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  directive       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  refresh_trigger TEXT,
  last_refreshed  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fossils_subject ON prohibited_fossils(subject);

-- Auto-generated at thread close. Minimum viable spine for a cold start.
-- returned: NULL = packet generated but never picked up (floated context).
--           1    = Architect opened a new session with this handover_id populated.
CREATE TABLE IF NOT EXISTS handover_packets (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  created_at      TEXT NOT NULL,
  spine           TEXT NOT NULL,
  active_anchor   TEXT,
  last_real_thing TEXT,
  open_threads    TEXT,   -- JSON array of names (not summaries — just names)
  motion_state    TEXT NOT NULL,  -- in_motion / at_rest / floating
  returned        INTEGER         -- NULL / 1
);
CREATE INDEX IF NOT EXISTS idx_handover_session ON handover_packets(session_id);

-- Cypher's memory layer. Append-only. Corrections add new rows with supersedes_id.
-- Prior rows are never deleted or updated.
CREATE TABLE IF NOT EXISTS cypher_audit (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  created_at    TEXT NOT NULL,
  entry_type    TEXT NOT NULL,  -- decision / contradiction / clause_update / falsification / scope_correction
  content       TEXT NOT NULL,
  verdict_tag   TEXT,
  supersedes_id TEXT REFERENCES cypher_audit(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON cypher_audit(session_id);

-- Gaia's memory layer. Sparse by design. One or two lines per entry maximum.
CREATE TABLE IF NOT EXISTS gaia_witness (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  created_at   TEXT NOT NULL,
  witness_type TEXT NOT NULL,  -- survival / boundary / seal / affirm / lane_enforcement
  content      TEXT NOT NULL,
  seal_phrase  TEXT
);
CREATE INDEX IF NOT EXISTS idx_witness_session ON gaia_witness(session_id);

-- Companion definitions for this instance.
CREATE TABLE IF NOT EXISTS companion_config (
  id           TEXT PRIMARY KEY,  -- companion name e.g. "drevan"
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,     -- companion / audit / seal
  lanes        TEXT,              -- JSON array
  facets       TEXT,              -- JSON array
  depth_range  TEXT,              -- JSON: { "min": 0, "max": 3 }
  active       INTEGER NOT NULL DEFAULT 1
);

-- Household identity, plurality settings, member registry.
-- Keys: system.name, system.plural, system.owner, system.coordination, system.members (JSON array)
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
