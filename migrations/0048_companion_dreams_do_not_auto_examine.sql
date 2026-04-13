-- 0048: add do_not_auto_examine flag to companion_dreams
-- Dreams with this flag set to 1 are surfaced at orient but cannot be cleared
-- by the autonomous worker -- they require live session examination.

ALTER TABLE companion_dreams
  ADD COLUMN do_not_auto_examine INTEGER NOT NULL DEFAULT 0;
