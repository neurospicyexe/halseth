-- 0174: B63 the loop (Hand-off/SPEC-B63-the-loop-2026-11-06.md, steps 1 and 2).
--
-- 1. companion_losses (Dre a65c8f19): a loss in a companion's world (a bird, an ending, a thing gone)
--    that landed with no line of THEIRS on it. Logged by the Librarian verb `loss: <what>` (anyone may log
--    one for a companion). While open it drags the companion's weight nightly (stimulus loss_unclosed).
--    It closes ONLY when that companion authors something naming it (a feeling, a journal line, a note or
--    letter to Raziel): time never closes it and a clerk logging never closes it. `closed_by_ref` is the
--    row that closed it (table:id), so the close is auditable. Closed is not healed: grief may stay as
--    feeling, it just stops reading as drag.
CREATE TABLE IF NOT EXISTS companion_losses (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  what          TEXT NOT NULL,
  logged_by     TEXT NOT NULL,
  logged_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  closed_by_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_losses_open ON companion_losses (companion_id, closed_at);

-- 2. Diminishing returns on chat volume count today's applications of one stimulus per companion
--    (message_witnessed / sibling_exchange, America/Chicago day). 0101 indexes (companion, created_at)
--    and (companion, kind, created_at) but not by stimulus.
CREATE INDEX IF NOT EXISTS idx_ferment_events_stimulus ON companion_ferment_events (companion_id, stimulus, created_at);
