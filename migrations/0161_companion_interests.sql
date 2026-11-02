-- 0161_companion_interests.sql (B62 step 2, 2026-11-02; Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md 3B + 3F)
--
-- Interests a companion authors, and the WHY TRAIL that goes with them: every step carries the
-- reason in the companion's own words. Raziel asked for this 11-02: "the thought process of your
-- own interest... I got this interest because, I like this, I don't like this, I left this because."
--
-- WHO WRITES. Only the companion. No clerk, worker, tick or classifier writes a born / returned /
-- made / put_down / picked_up row; they go in through the companion's own verb (Librarian) or
-- POST /mind/interests under that companion's token. The ONE automatic event is 'cooled' (an
-- interest nobody has touched for 21 days is marked resting; no why, ref 'auto'), and it only ever
-- moves status active -> resting, which any return reverses (R7: no ceiling, nothing is lowered
-- permanently by silence; put_down is the companion's own act and the row is kept).
--
-- PUBLIC BY DEFAULT. These are chosen and meant to be seen (the same standing as a chosen
-- preference, mig 0086). A single why may be marked why_private = 1: the stream then shows the
-- event ("Drevan returned to trains") but not the reason. The private interiority layer is a
-- different thing and stays private; nothing here reads it.
--
-- born_from is a REF ('forage:<id>', 'club:<id>', 'room:<channel_id>'), never quoted text. A
-- spark may not come from owner DMs, a care-hold window, or anything that touches HEALTH_TABLES.

CREATE TABLE IF NOT EXISTS companion_interests (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  name         TEXT NOT NULL,
  why          TEXT NOT NULL,                       -- the born-with reason, own words
  why_private  INTEGER NOT NULL DEFAULT 0,
  born_from    TEXT,                                -- a REF, never quoted text
  heat         REAL NOT NULL DEFAULT 0.6,           -- as of heat_at; read through effectiveHeat() (lazy cooling)
  heat_at      TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resting','put_down')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  put_down_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interests_companion_name ON companion_interests (companion_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_interests_companion_status ON companion_interests (companion_id, status);

CREATE TABLE IF NOT EXISTS companion_interest_events (
  id           TEXT PRIMARY KEY,
  interest_id  TEXT NOT NULL REFERENCES companion_interests(id),
  companion_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('born','returned','made','cooled','put_down','picked_up')),
  why          TEXT,                                -- NULL only for the automatic 'cooled'
  why_private  INTEGER NOT NULL DEFAULT 0,
  ref          TEXT,                                -- a made thing, a forage id, 'auto' for cooled
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interest_events_companion ON companion_interest_events (companion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interest_events_interest ON companion_interest_events (interest_id, created_at);

-- Likes and dislikes join the same stream. companion_preferences (0086) had no reason column;
-- companion_refusals already has `reason`, so it needs nothing. Written in the companion's own
-- words when it declares a preference ("I prefer X because ..."); NULL for every older row, and
-- the thinking stream excludes a preference with no why.
ALTER TABLE companion_preferences ADD COLUMN why TEXT;
ALTER TABLE companion_preferences ADD COLUMN why_private INTEGER NOT NULL DEFAULT 0;
