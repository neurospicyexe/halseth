-- 0173: companion_tensions.drags_float (B63 step 4, Hand-off/SPEC-B63-the-loop-2026-11-06.md 3.4).
--
-- A held tension names WHICH float it drags (the companion names it; default when a tension is
-- named from a pressure offer = the float that dipped). NULL = names none (every row that exists
-- today, and every tension not tied to a float). The step 2 `tension_unworked` / `tension_resolved`
-- stimuli read this column to know which float to drag and lift.
--
-- Nothing creates a tension for a companion and nothing writes this column but the companion's own
-- reply. Additive: nullable, no default, no backfill; SQLite can ADD a column with a CHECK.
-- Pre-0173 the write paths answer 409 "needs the 0173 migration" only when drags_float is sent.

ALTER TABLE companion_tensions ADD COLUMN drags_float TEXT
  CHECK (drags_float IS NULL OR drags_float IN ('soma_float_1','soma_float_2','soma_float_3'));
