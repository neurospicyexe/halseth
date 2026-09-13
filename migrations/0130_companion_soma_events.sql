-- migrations/0130_companion_soma_events.sql
--
-- Graph memory, Phase 2 tranche 1 (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md,
-- docs/private/graph-memory-spec-2026-08-28.md § Phase 2). One append-only table: the HISTORY of
-- every move a companion's felt floats (soma_float_1/2/3) ever made, and who moved them.
--
-- WHY. Measured 2026-09-12: every AUTHORED change to a float left no history row at all
-- (`sessionClose` and `updateCompanionState` both write companion_state in place), and the two
-- machine writers logged only their own private shape -- companion_ferment_events records deltas
-- with no before/after, companion_soma_shifts records before/after but only for drift shifts.
-- No writer recorded a WRITER. So "heat 0.68" had no answer to "since when, and because of what".
-- This table is that answer, and it is the ONLY place all five writers meet.
--
-- NOT A PROJECTION. Unlike graph_edges (mig 0127) this is a SOURCE of truth: rows are written at
-- the moment of the move by the writer that made it, and nothing can regenerate them afterwards.
-- APPEND-ONLY, same covenant as relational_deltas: no UPDATE, no DELETE, ever. The derived
-- graph_edges projection reads this table; it never writes back to it.
--
-- The detail tables stay. companion_ferment_events and companion_soma_shifts keep their own rows
-- (drive deltas, reaction names, shift reasons live there and nowhere else); a machine writer
-- additionally appends an event here POINTING at its own detail row via cause_table/cause_id.
-- Authored writers point at what moved the value -- the handover packet for a session close,
-- nothing yet for a bare state update (tranche 2 candidate: the session).
--
-- before_value/after_value are nullable on purpose. A writer that could not read the prior value
-- records NULL rather than guessing, and the backfill (POST /admin/soma/backfill-events) copies
-- what the detail tables actually say: companion_ferment_events knows the delta but not the
-- absolutes, so backfilled ferment rows carry delta only. `delta` is after - before when both are
-- known, else the writer's own delta.
--
-- Events are written only when the float ACTUALLY CHANGED (|delta| > 1e-9). A write that lands the
-- same number is not a move, and a history full of no-ops is a history nobody reads. Backfill is
-- the one exception: it copies the detail tables verbatim rather than re-deriving.
--
-- IDS. JS-generated. The machine writers and the backfill share DETERMINISTIC ids derived from the
-- detail row (`fe_<ferment_event_id>_<f1|f2|f3>`, `ss_<soma_shift_id>`) so INSERT OR IGNORE makes
-- the backfill idempotent AND collision-free against rows the live writers already appended.

CREATE TABLE IF NOT EXISTS companion_soma_events (
  id            TEXT PRIMARY KEY,                 -- JS-generated; backfill uses deterministic ids
  companion_id  TEXT NOT NULL,
  float_key     TEXT NOT NULL CHECK (float_key IN ('soma_float_1','soma_float_2','soma_float_3')),
  before_value  REAL,                             -- NULL when the writer could not read it (backfilled ferment events)
  after_value   REAL,                             -- NULL only for backfilled ferment events (delta known, absolute unknown)
  delta         REAL,                             -- after - before when both known, else the writer's delta
  kind          TEXT NOT NULL CHECK (kind IN ('authored_close','authored_update','tick','stimulus','drift_shift')),
  writer        TEXT NOT NULL,                    -- companion id for authored kinds; 'system' for tick/stimulus/drift_shift
  cause_table   TEXT,                             -- handover_packets | companion_ferment_events | companion_soma_shifts | NULL
  cause_id      TEXT,
  session_id    TEXT,                             -- authored_close always; others when known
  version_after INTEGER,                          -- companion_state.version after the write, when known
  detail        TEXT,                             -- short free text: stimulus name, 'silence', reason head (<=120 chars)
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_soma_events_companion_float ON companion_soma_events(companion_id, float_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soma_events_cause ON companion_soma_events(cause_table, cause_id);
CREATE INDEX IF NOT EXISTS idx_soma_events_session ON companion_soma_events(session_id);
