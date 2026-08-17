-- Migration 0124: the weekly budget ledger (consequence layer C3)
--
-- R2 (Raziel, 2026-08-16): 1 credit = 1 autonomous run; 7/week/companion; weekly Monday
-- (America/Chicago) refill; NO rollover. Nothing given costs anything until a run spent on a
-- gift is a run not spent on the companion's own project -- this ledger is where that trade
-- becomes real.
--
-- Append-only ([[write-gate-is-unfalsifiable]]): credits are reason='replenish' rows (+7),
-- debits are -1 rows whose reason IS the purpose (project | self | gift:raziel | gift:<sibling>).
-- No rollover falls out of the balance query, not a sweep: balance sums only entries at or
-- after the current week's replenish row, so last week's unspent simply stops counting.

CREATE TABLE IF NOT EXISTS companion_budget_entries (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  delta        INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  ref          TEXT,                -- replenish: the week key (e.g. '2026-08-11'); debits: run/artifact id
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_companion
  ON companion_budget_entries(companion_id, created_at DESC);

-- Replenish idempotency: at most ONE credit row per companion per week key, so the rider (which
-- rides the every-minute scheduled door) and any read-path self-heal can both try safely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_replenish_week
  ON companion_budget_entries(companion_id, ref) WHERE reason = 'replenish';
