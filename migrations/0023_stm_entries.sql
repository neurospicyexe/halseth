-- STM (short-term memory) entries for Discord bot conversation persistence.
-- Survives Railway redeploys. Application-level prune keeps last 50 per companion+channel.
-- Entries are lightweight: role + content + optional author_name. No session linkage.

CREATE TABLE IF NOT EXISTS stm_entries (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  author_name  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stm_lookup
  ON stm_entries(companion_id, channel_id, created_at);
