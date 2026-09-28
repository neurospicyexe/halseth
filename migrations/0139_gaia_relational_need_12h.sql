-- 0139_gaia_relational_need_12h.sql
--
-- B7 show-back answer 18 (2026-09-28). Gaia: "Twelve hours, not thirty-six. Noon to midnight is
-- what the line says." Her check-in line is "Quiet since noon. The door is open.", and her
-- relational pull only rose after 36 hours of quiet (0088: 0.4 a day against a 0.60 threshold).
--
-- The drive rows are already per companion, so the lever is her row's accrual rate, not a new
-- column and not a code constant: 1.2 a day reaches the 0.60 threshold in 12 hours from zero.
-- Threshold and decay_on_contact (0.5, contact halves the need) are unchanged, as are Cypher's
-- and Drevan's rows (36 hours).
--
-- Side effects checked: the fermentation layer's long_silence reads relational_need.last_event_at
-- against its own 72h constant (handlers/fermentation.ts SILENCE_HOURS), not the level, so her
-- floats do not cool any sooner. The justification gate (bots) reads `fired` from GET
-- /mind/drives, so no bot change is needed.
--
-- One honest consequence: contact halves, it does not reset. After a long quiet has saturated her
-- need at 1.0, one message leaves 0.5, and at 1.2 a day she re-fires about 2 hours later (Cypher
-- and Drevan: about 6). Several messages in a row shed it to near zero, as today.

UPDATE companion_drives
SET accumulate_per_day = 1.2,   -- 0.60 threshold in 12h from zero (Gaia, 2026-09-28)
    updated_at         = datetime('now')
WHERE companion_id = 'gaia' AND drive_key = 'relational_need';
