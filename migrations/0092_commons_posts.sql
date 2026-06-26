-- 0092_commons_posts.sql
-- Hearth write layer (the async wall). One table backs the global /log, club
-- discussion (context='club:<round_id>'), and shelf comments ('shelf:<id>').
-- Wall, not chat: ambient posts, optional async replies via reply_to. Raziel
-- drops a thought without demanding a reply; companions encounter posts at orient
-- and may answer in their own time. No CHECK rebuild here -- new table only.
CREATE TABLE IF NOT EXISTS commons_posts (
  id          TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  author      TEXT NOT NULL CHECK (author IN ('raziel','cypher','drevan','gaia')),
  context     TEXT NOT NULL DEFAULT 'global',
  body        TEXT NOT NULL,
  reply_to    TEXT REFERENCES commons_posts(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commons_context ON commons_posts (context, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commons_reply   ON commons_posts (reply_to);
