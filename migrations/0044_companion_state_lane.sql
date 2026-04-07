-- Migration 0044: Add lane signal columns to companion_state.
--
-- companion_state is one mutable row per companion (PK = companion_id).
-- Sibling lane queries were fetching spine + motion_state from the sessions heap
-- (rowid lookup after index scan). Moving the signal here makes sibling reads
-- pure PK lookups with zero heap access.
--
-- motion_state: in_motion | at_rest | floating -- written at every session close.
-- lane_spine:   first 150 chars of session spine -- enough for lane-awareness, not a full record.

ALTER TABLE companion_state ADD COLUMN motion_state TEXT;
ALTER TABLE companion_state ADD COLUMN lane_spine TEXT;
