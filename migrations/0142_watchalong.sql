-- 0142_watchalong.sql
--
-- Watchalong (spec: docs/SPEC-watchalong-2026-10-02.md). The triad follows a film through its caption
-- track, cut at a server-side playhead so nothing past where Raziel is reaches them.
--
--   watchalong_sessions -- one per Discord channel at a time (creating a new one ends the prior);
--                          playhead = playhead_sec + (now - playhead_set_at) while 'playing'.
--   watchalong_cues     -- one row per caption line (line / sound / music), keyed (session_id, idx).
--
-- Read surface: GET /mind/watchalong/active (src/handlers/watchalong.ts).

CREATE TABLE watchalong_sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  shelf_id TEXT,                         -- watch_shelf.id when matched by title, nullable
  source TEXT NOT NULL CHECK (source IN ('attachment','opensubtitles','youtube')),
  source_ref TEXT,                       -- opensubtitles file_id / url / filename
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('playing','paused','ended')),
  playhead_sec REAL NOT NULL DEFAULT 0,
  playhead_set_at TEXT NOT NULL DEFAULT (datetime('now')),
  duration_sec REAL,                     -- clamp; defaults to last cue end
  cue_count INTEGER NOT NULL DEFAULT 0,
  started_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX idx_watchalong_channel ON watchalong_sessions(channel_id, status);

CREATE TABLE watchalong_cues (
  session_id TEXT NOT NULL REFERENCES watchalong_sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('line','sound','music')),
  speaker TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (session_id, idx)
);
CREATE INDEX idx_watchalong_cues_time ON watchalong_cues(session_id, start_sec);
