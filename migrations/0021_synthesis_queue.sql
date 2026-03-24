-- 0021_synthesis_queue.sql
-- Durable queue for background synthesis jobs.
-- Written by session_close; consumed by the scheduled cron handler.

CREATE TABLE IF NOT EXISTS synthesis_queue (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  companion_id TEXT,                          -- from the session row at enqueue time
  job_type     TEXT NOT NULL DEFAULT 'session_summary', -- 'session_summary' | 'day_context' | 'topic'
  status       TEXT NOT NULL DEFAULT 'pending',         -- pending | processing | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_synthesis_queue_status ON synthesis_queue(status, created_at);
