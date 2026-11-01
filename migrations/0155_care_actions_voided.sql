-- 0155_care_actions_voided.sql: a care firing can be VOIDED, never deleted
--
-- Raziel's ruling 2026-10-31: undoing a check-in clears a care hold that check-in started. The hold is
-- derived (src/care/hold.ts) from low_spoons care_actions rows, so the undo has to take the firing the
-- undone reading caused out of the derivation. Deleting the row would also drop a companion's
-- gesture/gesture_note if they had already acted on it, and the care log is append-only by the same
-- rule the hold keeps (a clear never deletes a start). So the row stays and is stamped instead.
--
-- voided_at: NULL = a live firing. Set (server clock, ISO) by DELETE /biometrics/:id when the only
-- reading that justified the firing was the one undone (src/care/undo.ts). Readers that decide
-- anything (the hold, the tick's cooldown and pending block, the pending-gesture reads) filter
-- voided_at IS NULL; the audit list (GET /care/recent) still shows the row with its stamp.
-- Additive only. Code deployed ahead of this migration falls back to the pre-0155 reads and the void
-- write logs and does nothing.

ALTER TABLE care_actions ADD COLUMN voided_at TEXT;
