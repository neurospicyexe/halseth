-- Migration 0058: Second Brain search log.
-- Written at orient time (execSessionOrient) and per-message search (getMindSearch).
-- Read by GET /mind/sb-search-log/:agent_id → Hearth /orient hit rate section.

CREATE TABLE IF NOT EXISTS sb_search_log (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  query        TEXT NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'orient',  -- 'orient' | 'message'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sb_search_log_companion_created
  ON sb_search_log (companion_id, created_at DESC);
