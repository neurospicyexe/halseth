-- Migration 0028: Companion self-defense layer
-- companion_basins: semantic attractor states (identity "basins" -- not traits, attractor points)
CREATE TABLE IF NOT EXISTS companion_basins (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  basin_name      TEXT NOT NULL,
  basin_description TEXT NOT NULL,
  embedding       TEXT NOT NULL,  -- JSON float array from OpenAI-compatible embedder
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_basins_companion ON companion_basins(companion_id);

-- companion_basin_history: trajectory log -- each evaluator run writes one row per companion
CREATE TABLE IF NOT EXISTS companion_basin_history (
  id             TEXT PRIMARY KEY,
  companion_id   TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  drift_score    REAL NOT NULL,   -- avg cosine distance from all basins (0=identical, 2=opposite)
  drift_type     TEXT NOT NULL CHECK (drift_type IN ('stable','growth','pressure')),
  caleth_confirmed INTEGER NOT NULL DEFAULT 0,  -- 1 = intentional growth, confirmed
  worst_basin    TEXT,            -- basin_name with highest distance (for triage)
  notes          TEXT,
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_basin_history_companion ON companion_basin_history(companion_id, recorded_at DESC);

-- companion_tensions: productive contradictions that don't resolve -- they simmer, deepen, crystallize
CREATE TABLE IF NOT EXISTS companion_tensions (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  tension_text    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'simmering' CHECK (status IN ('simmering','crystallized','released')),
  first_noted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_surfaced_at TEXT,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_companion_tensions_companion ON companion_tensions(companion_id, status);
