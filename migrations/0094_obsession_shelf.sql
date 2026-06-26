-- 0094_obsession_shelf.sql
-- Shelf (Phase 3): "what Raziel's into" -- a persistent shelf of his current fixations
-- (show/movie/actor/book/...), separate from the voted club rounds, that the triad reacts
-- to. Reactions live in commons_posts (context='shelf:<id>'), not a separate table -- the
-- write layer (0092) carries them, same as it carries club discussion.
CREATE TABLE IF NOT EXISTS obsession_shelf (
  id         TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other'
               CHECK (kind IN ('show', 'movie', 'actor', 'person', 'book', 'music', 'game', 'article', 'other')),
  note       TEXT,                  -- Raziel's own words on what / why
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obsession_status ON obsession_shelf (status, updated_at DESC);
