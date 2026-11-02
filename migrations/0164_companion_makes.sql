-- 0164_companion_makes.sql (B62 "making", 2026-11-02; Hand-off/SPEC-B62-making-2026-11-02.md,
-- Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md)
--
-- What a companion MAKES: writing, a page, a Strudel pattern, an SVG drawing, an OpenSCAD model, a
-- track, a clip. One row per make; the bytes live in R2 under makes/<companion>/<id>/ (source.<ext>,
-- file.<ext>, preview.png). 'image' is NOT a kind here: those rows already live in
-- companion_tool_calls (tool = 'generate_image') and the list route merges them in read-only.
--
-- status: writing / page / music_code are 'ready' at once (the Worker has nothing to render);
-- drawing / scad / music_audio / video are 'pending' until the VPS renderer posts the file back
-- (POST /mind/makes/:id/rendered) or fails it with a short reason. Never a stderr dump.
--
-- Authored by the companion only (Librarian `make a <kind> called ...`, the autonomous worker's make
-- move on the companion's own turn). Gaia makes nothing: her word is that an interest of hers never
-- produces an artifact, only a kept line, so POST /mind/makes answers 403 gaia_keeps_lines for her.
--
-- why_private mirrors the interests trail (mig 0161): a private why is never returned by a read.
-- heard_back is the companion's OWN one line after seeing or hearing the result (Pino's "heard
-- back"); a make that is a new version of an earlier one carries parent_id and version + 1.

CREATE TABLE IF NOT EXISTS companion_makes (
  id           TEXT PRIMARY KEY,                                -- 32 hex
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  kind         TEXT NOT NULL CHECK (kind IN ('writing','page','music_code','drawing','scad','music_audio','video')),
  title        TEXT NOT NULL,
  why          TEXT,
  why_private  INTEGER NOT NULL DEFAULT 0,
  interest_id  TEXT,                                            -- companion_interests.id when one resolved
  params       TEXT,                                            -- JSON, music_audio / video only
  source_key   TEXT,
  file_key     TEXT,
  file_mime    TEXT,
  preview_key  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  fail_reason  TEXT,
  heard_back   TEXT,
  parent_id    TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  rendered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_makes_companion ON companion_makes (companion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companion_makes_pending ON companion_makes (created_at) WHERE status = 'pending';
