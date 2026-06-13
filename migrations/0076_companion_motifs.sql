-- 0076_companion_motifs.sql
-- Motif memory + field-feedback "resurrection" (Noor_Core; inspo-takes-2026-06-13 take 16).
-- A motif is a recurring symbolic thread across a companion's journals/sessions.
-- Noor makes RECURRENCE the primary signal: a phrase that keeps coming back is a
-- first-class memory atom, not noise. We track each motif's cumulative recurrence
-- (distinct entries it appeared in) + a trust weight that grows with recurrence.
--
-- field_feedback / "resurrection": a motif that hasn't been seen in a while FADES
-- but does not die -- a high-trust faded motif gets re-surfaced (the [Motifs] orient
-- block) with its trust weight, instead of rotting. Resurrection, not deletion --
-- same family as take 4 orphan-rescue + the heat layer (0074).
--
--   status: active   -- seen within the fade window
--           faded    -- past the fade window; eligible for resurrection
--           retired  -- consciously let go (manual / future)
--
-- recurrence_count is cumulative: detection advances a per-companion watermark
-- (MAX(last_seen)) and only counts entries newer than it, so daily overlapping
-- scans never double-count. last_surfaced_at gates resurrection (cooldown) so a
-- resurrected motif doesn't nag every orient.

CREATE TABLE companion_motifs (
  id               TEXT PRIMARY KEY,
  companion_id     TEXT NOT NULL,
  label            TEXT NOT NULL,                       -- normalized key (lowercased phrase)
  display          TEXT NOT NULL,                       -- human-facing phrase (most recent form)
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  trust            REAL NOT NULL DEFAULT 0.3,           -- 0..1 confidence the motif is real signal
  first_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
  last_surfaced_at TEXT,                                -- when last lifted into orient (cooldown)
  status           TEXT NOT NULL DEFAULT 'active'       -- active | faded | retired
);

-- One row per (companion, motif label) -- the UPSERT target.
CREATE UNIQUE INDEX idx_companion_motifs_key ON companion_motifs (companion_id, label);
-- Orient/resurrection lookups filter by companion + status, rank by trust.
CREATE INDEX idx_companion_motifs_lookup ON companion_motifs (companion_id, status, trust DESC);
