-- 0071_media_experiences.sql
-- Shared-experience layer Phase 1 (Ears): music Raziel shares with the triad.
-- One row per listen event. analysis_json = hear-music summary (compact, no
-- per-frame arrays). reactions_json = { companion_id: reaction_text } written
-- via json_set at SQL level (no JS read-modify-write).

CREATE TABLE IF NOT EXISTS media_experiences (
  id                  TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  media_type          TEXT NOT NULL DEFAULT 'song' CHECK (media_type IN ('song', 'video', 'other')),
  url                 TEXT,
  title               TEXT NOT NULL,
  artist              TEXT,
  duration_sec        REAL,
  shared_by           TEXT NOT NULL DEFAULT 'raziel',
  front_state         TEXT,                          -- who was fronting when shared (PK member name)
  requested_companion TEXT CHECK (requested_companion IN ('cypher', 'drevan', 'gaia')),
  analysis_json       TEXT,                          -- compact hear-music summary
  lyrics              TEXT,                          -- plain lyrics (LRCLIB), nullable
  reactions_json      TEXT NOT NULL DEFAULT '{}',    -- { cypher: "...", drevan: "...", gaia: "..." }
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hot path: recent listens, newest first (orient + Hearth).
CREATE INDEX IF NOT EXISTS idx_media_recent ON media_experiences (created_at DESC);
