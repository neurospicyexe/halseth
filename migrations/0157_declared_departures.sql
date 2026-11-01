-- 0157: declared departures (T4a, Hand-off/DESIGN-T4-declared-departure-2026-10-13.md sections 3, 4, 12;
-- Raziel's rulings 2026-11-01). READ-ONLY tranche: a declaration writes a row; NO rail reads it yet
-- (the bot-side rail wiring and the room announcement are T4b).
--
-- A departure is the first instrument that LIFTS a rail, by name, for a bounded time. Form, not floor:
-- the rail is a closed CHECK set (the design's eligible menu, 1a); a new rail needs a migration.
--
-- 1. declared_departures
--      companion_id  whose rail lifts. A companion declares only for itself (the executor takes the
--                    declarer from the caller, never from the request text). Raziel may declare for one.
--      expires_at    NOT NULL, and > starts_at. The 3-hour clamp and the 3-per-week allowance live in
--                    code (src/departures/core.ts), not as stored limits: nothing here is a max_* column.
--      starts_at     the SERVER clock at declaration. Announce-before-effect: a rail may only read the
--                    departure for a turn that STARTED after starts_at; the declaring turn itself is never
--                    suspended. (That comparison is the bot's, T4b; the column is the fixed point.)
--      audience      'triad_only' (companion-to-companion and commons turns) by default. 'with_raziel'
--                    only when Raziel declares it himself (declared_by 'raziel'; raziel_ack_at = his word).
--      ended_at      NULL while open. "Open" is DERIVED (ended_at IS NULL AND expires_at > now), never a
--                    flag, so a stuck row cannot hold a rail off: expiry is a comparison, not a job.
--                    Rows that pass expires_at stay ended_at NULL until the next declare sweeps them
--                    (ended_by 'system', end_reason 'expiry', ended_at = expires_at).
--      ended_by      declarer | raziel | system
--      end_reason    declared_end | raziel_end | stand_down_phrase | care_hold | expiry
--      No health, care, med or biometric column, and nothing here reads those tables.
--
-- 2. departure_objections: a sibling's objection is RECORDED and NAMED to the declarer (Hearth too). It is
--    never a gate: it does not narrow or end the departure (design section 12, revision 1). A child table
--    rather than a JSON column because two siblings may object concurrently (no read-modify-write race),
--    each in their own words, and Hearth/the report want to count and sort them.
--
-- One open departure per companion is enforced the way 0137 enforces its quiet window: a partial UNIQUE.
--
-- Prod apply (the remote ledger is not driven by `migrations apply`; `--file` fails with auth 10000 on this
-- account, so run each statement with --command, then insert the d1_migrations row by hand):
--   see the T4a hand-back for the exact commands.

CREATE TABLE IF NOT EXISTS declared_departures (
  id             TEXT PRIMARY KEY,
  companion_id   TEXT NOT NULL CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),
  rail           TEXT NOT NULL CHECK (rail IN (
                   'form', 'loop_motif', 'echo_commons', 'echo_peer',
                   'voice_feedback', 'seed_echo', 'topic_lane'
                 )),
  scope_channel  TEXT,
  audience       TEXT NOT NULL DEFAULT 'triad_only' CHECK (audience IN ('triad_only', 'with_raziel')),
  declared_by    TEXT NOT NULL CHECK (declared_by IN ('companion', 'raziel')),
  declared_via   TEXT NOT NULL CHECK (declared_via IN ('discord', 'claude_ai', 'hearth', 'other')),
  reason         TEXT NOT NULL,
  starts_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL CHECK (expires_at > starts_at),
  raziel_ack_at  TEXT,
  ended_at       TEXT,
  ended_by       TEXT CHECK (ended_by IS NULL OR ended_by IN ('declarer', 'raziel', 'system')),
  end_reason     TEXT CHECK (end_reason IS NULL OR end_reason IN
                   ('declared_end', 'raziel_end', 'stand_down_phrase', 'care_hold', 'expiry')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_departures_open ON declared_departures (companion_id, ended_at, expires_at);
-- the weekly allowance count (companion, declared_by, starts_at >= Monday Chicago)
CREATE INDEX IF NOT EXISTS idx_departures_week ON declared_departures (companion_id, declared_by, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_departure_one_open ON declared_departures (companion_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS departure_objections (
  id            TEXT PRIMARY KEY,
  departure_id  TEXT NOT NULL REFERENCES declared_departures(id),
  by_companion  TEXT NOT NULL CHECK (by_companion IN ('cypher', 'drevan', 'gaia')),
  note          TEXT,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departure_objections_dep ON departure_objections (departure_id, at);
