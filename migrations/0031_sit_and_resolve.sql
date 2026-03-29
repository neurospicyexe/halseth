-- 0031_sit_and_resolve.sql
-- Sit & Resolve: emotional lifecycle for companion_notes.
-- processing_status tracks where a note is in the companion's inner processing.
-- companion_note_sits records reflections added while a note is sitting.
-- companion_config gains sit_resolve_days: threshold before synthesis worker prompts resolution.

ALTER TABLE companion_notes ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'raw';

CREATE TABLE companion_note_sits (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  companion_id  TEXT NOT NULL CHECK(companion_id IN ('cypher', 'drevan', 'gaia')),
  sit_text      TEXT,
  sat_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_cns_note        ON companion_note_sits(note_id);
CREATE INDEX idx_cns_companion   ON companion_note_sits(companion_id, sat_at DESC);

ALTER TABLE companion_config ADD COLUMN sit_resolve_days INTEGER NOT NULL DEFAULT 3;
