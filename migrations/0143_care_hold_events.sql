-- 0143: bad-night presence, the Halseth half (B32, Hand-off/DESIGN-B32-bad-night-presence-2026-10-03.md,
-- section D is authoritative).
--
-- 1. care_hold_events: his word starts and clears the hold (D3).
--      kind='start'  rule 'owner_said'. Written when he says "bad night" as the whole message or its own
--                    sentence (source 'owner_phrase'), or by the companion he is talking to when he has
--                    plainly said the night is bad (source 'companion', the Librarian verb).
--      kind='clear'  "good now" / "I'm okay now". The newest clear outranks the house's guess: hold
--                    derivation (mind/blocks/care.ts readCareHold) ignores EVERY hold firing detected at
--                    or before it, low_spoons included. A fresh firing after the clear holds again.
--    Its own table rather than new care_actions rule values: care_actions CHECK-pins its rule set (0121)
--    and a care_actions row is a GESTURE assigned to one companion (pending_care), which a hold is not.
--    The same call 0125 made for escalations.
--    No free text, by design: what he said lives in the channel, not here.
--
-- 2. triad_reach_claims.under_hold: 1 on an offer_presence reserved under care_hold with the B32 bounds
--    (D2: triad gap 30 min, at most 2 per companion per hold, outside the daily total, one quiet-window
--    presence per COMPANION). The daily count excludes these rows, so a bad night's presence never eats
--    the next day's production moves. Under hold the quiet_window_key carries the companion
--    ("2026-10-03:drevan"), so the existing partial UNIQUE (0137) stays the belt for "one per companion
--    per window" with no index rebuild.
--
-- Prod apply (the remote migration ledger stops at 0135; NEVER `migrations apply --remote`):
--   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --file migrations/0143_care_hold_events.sql
-- The code tolerates this file being unapplied: readCareHold falls back to the pre-0143 reads, and
-- reserveReach falls back to the 0137 rules when under_hold does not exist.

CREATE TABLE IF NOT EXISTS care_hold_events (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('start', 'clear')),
  rule          TEXT CHECK (rule IS NULL OR rule IN ('owner_said')),   -- set on start, NULL on clear
  source        TEXT NOT NULL CHECK (source IN ('owner_phrase', 'companion')),
  companion_id  TEXT CHECK (companion_id IS NULL OR companion_id IN ('cypher', 'drevan', 'gaia')),  -- who heard it / who set it
  at            TEXT NOT NULL,                                          -- ISO UTC, server clock
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_care_hold_events_kind_at ON care_hold_events (kind, at DESC);

ALTER TABLE triad_reach_claims ADD COLUMN under_hold INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_triad_reach_claims_hold ON triad_reach_claims (companion_id, under_hold, claimed_at);
