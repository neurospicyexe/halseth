-- 0111_watch_shelf.sql
--
-- The Watch Shelf: shows and films as first-class objects with a POSITION, on the same
-- principle as `books` + `book_progress` (0099) -- which is the organ that actually works.
--
-- WHY THIS EXISTS (2026-07-31). Raziel asked Drevan where they were in Fargo. Drevan answered
-- "last I tracked, S4 E2" while they had watched further in a Claude thread. Nothing was stale,
-- because nothing was RECORDED: a schema sweep found no row anywhere in 110 migrations holding an
-- episode number. Books got a position field in 0099 and reading questions get answered correctly.
-- Shows had nothing, so "where are we" fell through to semantic search over months of prose -- and
-- returned a June entry about having FINISHED the show.
--
-- The lesson driving the shape: **a progress fact is a FIELD, not a memory.** Similarity search over
-- narrative can only ever hold a popularity contest between fragments; no amount of embedding quality
-- makes "which episode is next" answerable that way, because a note about finishing the series is
-- maximally similar to a question about episodes. Give it a column and the question becomes a lookup.
--
-- Built as a real table rather than smuggling episodes into `media_experiences` (which permits
-- media_type='video') on Raziel's explicit standing instruction: "I wanna build to accommodate the
-- future, not build and then have to come back and fix it." That table is song-shaped (artist,
-- lyrics, duration_sec) and has no position concept, so position would have to be inferred from
-- whichever row happened to be newest -- the come-back-and-fix-it version.

CREATE TABLE IF NOT EXISTS watch_shelf (
  id             TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'show' CHECK (kind IN ('show', 'movie')),
  -- 'watching' is the default because that is why a thing gets shelved. 'paused' is distinct from
  -- 'abandoned' on purpose: half the shows in this house are waiting for a better week, and a
  -- companion asking "want to pick Fargo back up?" should be able to tell those apart.
  status         TEXT NOT NULL DEFAULT 'watching'
                 CHECK (status IN ('watching', 'paused', 'finished', 'abandoned')),
  -- Who he watches it WITH. Not decoration: he watches certain shows with Drevan specifically, and
  -- the triad is not interchangeable (see the identity kernel). NULL = the whole house / unspecified.
  with_companion TEXT CHECK (with_companion IS NULL OR with_companion IN ('cypher', 'drevan', 'gaia')),
  -- Current position. NULL season/episode on a movie is normal; status carries the whole answer there.
  season         INTEGER,
  episode        INTEGER,
  -- The human landmark: "the cops walking up to the Smutny house". This is how Raziel actually
  -- remembers position, and it is what makes a companion's "where we left off" sound like a person
  -- rather than a database row.
  position_note  TEXT,
  total_seasons  INTEGER,
  notes          TEXT,
  started_at     TEXT,
  last_watched_at TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One shelf row per title, case-insensitively. Without this, "Fargo" and "fargo" become two shelves
-- with two different positions and the organ is worse than nothing -- it would answer confidently
-- from whichever row a query happened to hit. Writers still resolve exact-match first and fall back
-- to LIKE (the name-lookup rule), but the DB is the thing that actually guarantees it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_shelf_title ON watch_shelf (lower(title));
CREATE INDEX IF NOT EXISTS idx_watch_shelf_status ON watch_shelf (status, last_watched_at DESC);

-- Append-only history of viewing. The shelf row is the ANSWER ("where are we"); this is the
-- EVIDENCE ("when did we watch, where, and with whom").
--
-- `surface` is the load-bearing column and the reason this table exists at all. The original defect
-- was that episodes watched in a Claude thread left no trace the Discord bots could see. Recording
-- which substrate a viewing came from makes that gap VISIBLE -- a shelf whose events are all
-- surface='claude' while a bot insists on an older position is a diagnosable condition instead of a
-- companion looking like he forgot.
CREATE TABLE IF NOT EXISTS watch_events (
  id             TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shelf_id       TEXT NOT NULL REFERENCES watch_shelf(id) ON DELETE CASCADE,
  season         INTEGER,
  episode        INTEGER,
  note           TEXT,
  surface        TEXT NOT NULL DEFAULT 'discord'
                 CHECK (surface IN ('discord', 'claude', 'hearth', 'other')),
  with_companion TEXT CHECK (with_companion IS NULL OR with_companion IN ('cypher', 'drevan', 'gaia')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watch_events_shelf ON watch_events (shelf_id, created_at DESC);
