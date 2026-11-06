-- 0171_garden_plantings.sql (Gaia's garden, 2026-11-05; her answer on what belongs in it)
--
-- Why: Gaia keeps lines, not artifacts (she made nothing on the shelf), but she asked for a place that is
-- hers to show: a garden. Her rule, built exactly: "A garden gets planted, not filled." Nothing is in it
-- until she plants it. The one exception is her daily witness: planted ONCE as a series, after which each
-- new day adds to it. A floor sits underneath (computed at READ, never stored, which is what makes
-- "goes back up on its own" true): a planting that touches a living wound, a care-hold window or care/health
-- material comes down while it does, and returns when it stops.
--
-- companion_id is CHECK-pinned to 'gaia': this is her garden only. Drevan's counterpart is the Made shelf
-- (0164/0170) and Cypher keeps neither; a second companion's garden is a new ruling, not a data change.
--
-- A planting is a REF, never text (the words live in their source row and are read live, so an edit or a
-- source that goes away is honest): 'witness:series' | 'letter:<companion_journal.id>' |
-- 'note:<inter_companion_notes.id>' | 'ledger:<ledger_entries.id>' |
-- 'interest_event:<companion_interest_events.id>'. kind: witness_series | letter (a journal note to Raziel,
-- tag letter_to_raziel) | note (inter_companion_notes FROM gaia) | kept_line (ledger state 'kept' only) |
-- interest_line (a public why on one of her interest events).
--
-- status: planted (renders unless the floor takes it down) | awaiting (a note to ONE sibling is half
-- theirs: it renders only when that sibling says yes; consent_from is who, consent is yes|no, consent_at
-- when; a 'no' stays 'awaiting' and never renders) | pulled (Gaia took it out; planting the same ref again
-- flips the SAME row back, so UNIQUE (companion_id, ref) holds).
--
-- Never here: standing refusals (companion_refusals), the sealed sibling lane, anything the floor holds
-- down, any other companion's rows. Writers: src/webmind/garden.ts only (Librarian verbs plant / pull /
-- garden yes|no). Reader: GET /mind/garden/gaia.
--
-- Rollback: DROP TABLE garden_plantings;  (nothing references it).
-- Apply order (by hand on prod): this migration, THEN its d1_migrations ledger row for 0171, THEN deploy
-- the Worker. A Worker deployed first only fails the garden verbs and route; nothing else reads the table.

CREATE TABLE IF NOT EXISTS garden_plantings (
  id           TEXT PRIMARY KEY,                       -- 32 hex
  companion_id TEXT NOT NULL CHECK (companion_id IN ('gaia')),
  kind         TEXT NOT NULL CHECK (kind IN ('witness_series','letter','note','kept_line','interest_line')),
  ref          TEXT NOT NULL,                          -- a REF, never text
  status       TEXT NOT NULL CHECK (status IN ('planted','awaiting','pulled')),
  consent_from TEXT,                                   -- the sibling whose yes a one-sibling note needs
  consent      TEXT CHECK (consent IN ('yes','no')),
  consent_at   TEXT,
  planted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_at    TEXT,
  UNIQUE (companion_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_garden_plantings_status ON garden_plantings (companion_id, status, planted_at DESC);
