-- 0079_collection_sparkle.sql
-- Collection / emotional archaeology (inspo-takes-2026-06-13 take 13, corvid).
--
-- corvid hoards "shiny" things; each item carries a sparkle weight, and the history
-- is the emotional archaeology of the collection. We already half-have this:
-- forage_finds + media_experiences ARE things the companions gather. Rather than ALTER
-- the live hot tables, a sidecar keyed by (source_table, source_id) carries the sparkle
-- weight. Sparkle accrues when a thing is engaged (a forage find consumed, a listen
-- reacted to). Hearth /collection renders each companion's hoard sparkle-weighted.
--
-- Read-only join at render time -- the sidecar never duplicates the item, only weights it.

CREATE TABLE collection_sparkle (
  source_table   TEXT NOT NULL,                 -- 'forage_finds' | 'media_experiences'
  source_id      TEXT NOT NULL,                 -- the row id in that table
  sparkle        REAL NOT NULL DEFAULT 0,       -- accumulated shine (monotonic up)
  last_sparked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_table, source_id)
);
CREATE INDEX idx_collection_sparkle_weight ON collection_sparkle (source_table, sparkle DESC);
