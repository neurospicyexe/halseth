-- Rolling distillation output: companion self-observations
CREATE TABLE IF NOT EXISTS persona_blocks (
  id          TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  block_type  TEXT NOT NULL CHECK(block_type IN ('identity', 'memory', 'relationship', 'agent')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persona_blocks_lookup
  ON persona_blocks(companion_id, created_at);

-- Rolling distillation output: observations about Raziel
CREATE TABLE IF NOT EXISTS human_blocks (
  id          TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  block_type  TEXT NOT NULL CHECK(block_type IN ('identity', 'memory', 'relationship', 'agent')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_human_blocks_lookup
  ON human_blocks(companion_id, created_at);
