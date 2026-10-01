-- 0141: med_answer_outcome (B7 step 2b, Raziel's ruling 2026-10-01). Supersedes the line in 0136
-- that reads "no 'missed'": a stated miss is now recorded. 0136 itself is not edited (applied).
--
-- The ruling, verbatim in spirit: a miss is recorded only when he says it; silence records nothing.
--   - "I missed the morning one", "didn't take my night ones", "forgot the morning jar" record an
--     explicit 'missed' for that dose. He told a companion, so it is an answer, like "taken" is.
--   - Silence is unchanged: an unanswered dose still leaves NO row. Ambiguity records nothing.
--   - A 'missed' row is never read as taken anywhere. The care rules (meds_missed / esc_meds, which
--     can page Blue) count only outcome = 'taken' as confirmation, so a stated miss behaves exactly
--     like no answer there. The 30-min follow-up does NOT fire after a stated miss (he answered).
--   - R-5 stands: no streak, no count, no rate is ever computed from this column.
--
-- One row per dose is kept: the PRIMARY KEY (slot_key, local_date) from 0136 is untouched. Existing
-- rows were all affirmatives, so the default 'taken' is their true value.

ALTER TABLE med_answers ADD COLUMN outcome TEXT NOT NULL DEFAULT 'taken' CHECK (outcome IN ('taken','missed'));
