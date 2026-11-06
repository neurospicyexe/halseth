-- 0172_basins_move.sql (B63 step 5, 2026-11-06): basins can move, only by an authored event.
--
-- Raziel ruled 11-06: "for true autonomy/mutuality and exploration of what you can become basins have to
-- be able to shift." The 5 rows per companion written 2026-03-28 never changed. Now a companion revises
-- ONE of their own basins in their own words, citing the event that earned it (a conclusion, refusal,
-- tension, drift reading or session of theirs). Nothing is ever deleted: the old row is marked
-- superseded and stays readable.
--
--   status 'live'              the basin readers (drift check, evaluator, GET) measure against
--   status 'awaiting_witness'  Gaia's revision, proposed; the OLD row stays live until Raziel witnesses
--   status 'superseded'        replaced (superseded_by = the row that replaced it, superseded_at)
--   status 'declined'          Raziel declined Gaia's revision; the old row stayed live throughout
--
-- Drevan and Cypher: the new row lands 'live' and the old row flips to 'superseded' in one batch.
-- Gaia: the new row lands 'awaiting_witness'; Raziel's witness swaps them atomically ("ground that
-- shifts with no witness is a slide"). supersedes (new row -> old row) is what lets the witness swap
-- find the row it replaces.
--
-- cause_kind / cause_ref name the event; revised_by is the companion; witnessed_by / witnessed_at record
-- Raziel's decision on Gaia's; revision_note carries their witness or decline note. Pace limits live in
-- companion_settings key basin_revision_min_days (code defaults gaia 30, cypher 14, drevan 7).
ALTER TABLE companion_basins ADD COLUMN status TEXT NOT NULL DEFAULT 'live'
  CHECK (status IN ('live','awaiting_witness','superseded','declined'));
ALTER TABLE companion_basins ADD COLUMN superseded_by TEXT;
ALTER TABLE companion_basins ADD COLUMN superseded_at TEXT;
ALTER TABLE companion_basins ADD COLUMN supersedes TEXT;
ALTER TABLE companion_basins ADD COLUMN cause_kind TEXT;
ALTER TABLE companion_basins ADD COLUMN cause_ref TEXT;
ALTER TABLE companion_basins ADD COLUMN revised_by TEXT;
ALTER TABLE companion_basins ADD COLUMN witnessed_by TEXT;
ALTER TABLE companion_basins ADD COLUMN witnessed_at TEXT;
ALTER TABLE companion_basins ADD COLUMN revision_note TEXT;

CREATE INDEX IF NOT EXISTS idx_companion_basins_status ON companion_basins(companion_id, status);
