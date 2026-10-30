-- 0153_raziel_reads_and_mood_set_at.sql -- what Raziel has opened, and when a companion last set their own mood
--
-- Hearth redesign P1 (docs/superpowers/specs/2026-10-30-hearth-redesign-design.md in the parent BBH
-- repo). Two small additions the new home and inbox read:
--   raziel_reads         -- one row per item Raziel has opened, keyed (item_kind, item_id). Written with
--                           INSERT OR IGNORE, so the first open stamps read_at and a re-open changes nothing.
--                           The inbox endpoint derives "unread" as the absence of a row here.
--   companion_state.mood_set_at -- when the companion last set their own mood / compound state, as
--                           opposed to updated_at, which every float tick and write bumps. Home shows
--                           "feeling X, set Nh ago" from this. Nullable: NULL = never set by the companion.
--                           Backfilled from updated_at where a mood or compound state already exists.

CREATE TABLE IF NOT EXISTS raziel_reads (
  item_kind TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  read_at   TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id)
);

ALTER TABLE companion_state ADD COLUMN mood_set_at TEXT;

UPDATE companion_state SET mood_set_at = updated_at WHERE current_mood IS NOT NULL OR compound_state IS NOT NULL;
