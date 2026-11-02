-- migrations/0148_memory_pins.sql
--
-- Memory Kit gap 4 (Halseth task da8b0012, 2026-10-28): a PIN on a conclusion or a continuity note.
-- A pinned row (1) always takes an orient slot ahead of the heat-ranked fill and (2) is never
-- cap-evicted, compressed into wm_archive_notes, or demoted. Measured before this: compression
-- had archived 1,363 / 1,889 / 1,496 high-salience notes (cypher / drevan / gaia) against 25 / 26 /
-- 45 live, so anything that mattered lived about two weeks in the orient. Rules live in
-- src/webmind/pins.ts.
--
-- A pin NEVER writes heat (hard law: surfacing must not feed the ranking that decides surfacing;
-- a pin is its own lane, not a hotter row). Release still wins: memory_release sets archived = 1
-- and every read filters archived = 0, so a released pinned row is out of view; undo restores it
-- with the pin intact. Nullable columns, no default: every existing row is unpinned.

ALTER TABLE companion_conclusions ADD COLUMN pinned_at TEXT;
ALTER TABLE companion_conclusions ADD COLUMN pinned_by TEXT;
ALTER TABLE wm_continuity_notes ADD COLUMN pinned_at TEXT;
ALTER TABLE wm_continuity_notes ADD COLUMN pinned_by TEXT;

CREATE INDEX IF NOT EXISTS idx_conclusions_pinned ON companion_conclusions(companion_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wm_notes_pinned ON wm_continuity_notes(agent_id, pinned_at) WHERE pinned_at IS NOT NULL;
