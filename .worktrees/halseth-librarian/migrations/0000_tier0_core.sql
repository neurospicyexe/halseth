-- ── Tier 0: Core identity ────────────────────────────────────────────────────
-- Establishes the foundational tables. All other tiers depend on this one.
-- Apply first, always.

-- companions
-- Plurality gating is enforced at the application layer (PLURALITY_ENABLED flag).
-- The schema itself is plural-capable so the flag can be flipped without migration.
CREATE TABLE IF NOT EXISTS companions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,          -- ISO-8601 UTC
  config_json TEXT                    -- optional per-companion overrides (JSON)
);

-- sessions
-- A session is a bounded interaction window belonging to one companion.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  companion_id   TEXT NOT NULL REFERENCES companions(id),
  started_at     TEXT NOT NULL,       -- ISO-8601 UTC
  ended_at       TEXT,                -- NULL while open
  metadata_json  TEXT                 -- arbitrary session context (JSON)
);

CREATE INDEX IF NOT EXISTS idx_sessions_companion ON sessions(companion_id);
