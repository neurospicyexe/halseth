-- 0102: off-baseline tracking for the interoception trajectory clause.
--
-- ferment_off_since holds JSON {f1,f2,f3}: the moment each float last LEFT its baseline
-- deadzone (null = at home). Maintained by the ferment tick (handlers/fermentation.ts),
-- read at Librarian orient so the felt-sense line can say "held 3d" -- the trajectory
-- clause the fermentation spec promised (docs/private/fermentation-layer-spec.md) that
-- shipped latent in 0101 because nothing computed the duration.

ALTER TABLE companion_state ADD COLUMN ferment_off_since TEXT;
