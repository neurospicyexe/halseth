-- 0082: reviewed_at on companion_open_loops -- the "hold" half of Guardian self-resolution.
-- A companion clearing its own loop_stuck flag can either CLOSE the loop or HOLD it
-- (re-justify why it stays open). Hold sets reviewed_at; detectStuckLoops skips loops
-- reviewed within 21d, so a held loop self-heals out of the flag on the next guardian
-- tick instead of nagging forever. NULL = never reviewed (default; existing behaviour).
ALTER TABLE companion_open_loops ADD COLUMN reviewed_at TEXT;
