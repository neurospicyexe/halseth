-- 0067_identity_kernel_and_questions.sql
-- Identity Kernel: versioned canonical identity per companion ('shared' = triad doctrine bundle).
-- One write, every substrate pulls at boot. Kills manual identity re-upload.
CREATE TABLE IF NOT EXISTS identity_kernel (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia','shared')),
  version       INTEGER NOT NULL,
  kernel_md     TEXT NOT NULL,
  vows_json     TEXT,
  checksum      TEXT NOT NULL,
  source_note   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (companion_id, version)
);
CREATE INDEX IF NOT EXISTS idx_identity_kernel_active ON identity_kernel(companion_id, active);

-- Continuity-gap questions: companions ask Raziel, not just report.
CREATE TABLE IF NOT EXISTS companion_questions (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  question      TEXT NOT NULL,
  context       TEXT,
  source        TEXT NOT NULL DEFAULT 'autonomous' CHECK (source IN ('autonomous','session','dialectic')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  answer        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_questions_open ON companion_questions(companion_id, status, created_at DESC);
