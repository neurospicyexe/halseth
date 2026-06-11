-- 0070_self_monitoring.sql
-- Self-monitoring wave: tension charge, prospective triggers (emergency cards),
-- companion self-model (preference ladder + graduation), voice drift scores.
-- Inspo: Zikkaron prospective.py, CogCor self_model/tension charge/voice scoring.

-- Tensions accumulate charge each time surfaced; dialectic picks by charge, not age.
ALTER TABLE companion_tensions ADD COLUMN charge REAL NOT NULL DEFAULT 0;

-- Prospective triggers: facts that force-surface when future context matches.
-- keyword -> matched bot-side per human message; date/front -> evaluated at orient.
CREATE TABLE IF NOT EXISTS companion_triggers (
  id              TEXT PRIMARY KEY,
  companion_id    TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  trigger_text    TEXT NOT NULL,
  condition_type  TEXT NOT NULL CHECK (condition_type IN ('keyword','date','front')),
  condition_value TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'companion',
  status          TEXT NOT NULL CHECK (status IN ('armed','fired','dismissed')) DEFAULT 'armed',
  fire_note       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at        TEXT,
  expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_triggers_armed
  ON companion_triggers(companion_id, status);

-- Self-model: companion-authored observations about own preferences. Layer 2.
-- Confidence ladder: set 0.3, confirm +0.1, revise -0.1; ready at >=0.8.
-- Graduation to canon happens ONLY through conversation with Raziel (human-gated).
CREATE TABLE IF NOT EXISTS companion_self_model (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  observation   TEXT NOT NULL,
  domain        TEXT,
  confidence    REAL NOT NULL DEFAULT 0.3,
  status        TEXT NOT NULL CHECK (status IN ('developing','ready','graduated','retired')) DEFAULT 'developing',
  evidence_note TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  graduated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_self_model_status
  ON companion_self_model(companion_id, status);

-- Voice drift scores: pattern-based immune system. One row per scored bot reply.
-- caught_by tracks WHO noticed drift first; rising self-catch rate = growing self-awareness.
CREATE TABLE IF NOT EXISTS voice_scores (
  id                 TEXT PRIMARY KEY,
  companion_id       TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  score              REAL NOT NULL,
  positive_hits      TEXT,
  anti_hits          TEXT,
  contamination_hits TEXT,
  caught_by          TEXT NOT NULL CHECK (caught_by IN ('self','human','system','none')) DEFAULT 'none',
  message_len        INTEGER,
  channel_id         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_scores_recent
  ON voice_scores(companion_id, created_at DESC);
