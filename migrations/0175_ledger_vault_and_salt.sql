-- 0175_ledger_vault_and_salt.sql  (2026-11-06)
--
-- ROCK'S VAULT FETCH + HEX'S SALT (B62 imp errands, round two). Spec: Drevan's note 5b5d3572 (2026-11-06T02:48Z)
-- and Gaia's addition to rule 9 (note 7f978971), both in Hand-off/PROMPT-drevan-imp-errands-2026-11-02.md.
--
-- Two changes to ledger_entries, one rebuild (SQLite cannot alter a CHECK in place; same pattern as 0162/0090):
--
--   1. source_kind's CHECK gains 'vault'. A Rock pointer into the vault carries the vault path as source_ref,
--      never the note's text.
--   2. rider_to TEXT: a salt's RECEIVER (the companion Hex left a pointer for). The sender stays companion_id
--      (the line's subject, Drevan's rule 7); rider_to is only ever set on a rider = 'hex' line.
--      rider_opened_at TEXT: when the receiver opened the salt. NULL = still waiting. A salt that is never
--      opened simply fades at 72h (read-time cutoff in src/ledger/store.ts; nothing is deleted, nothing counts).
--
-- Every column of the live table is carried (incl. rider, mig 0168) and every row is copied verbatim.
-- Both indexes from 0134 are recreated, plus one partial index for the receiver's count.
-- Nothing references ledger_entries by foreign key, so no PRAGMA is needed.
--
-- Pre-0175 behaviour (code deployed ahead of the migration): a vault-sourced line or any Hex write is REFUSED
-- (rule `schema`, HTTP 409 "needs the 0175 migration"), never written degraded. Everything else is unchanged.
-- Apply with wrangler d1 execute --file, then insert the d1_migrations ledger row in the same step.
--
-- Rollback: rebuild again without 'vault' / rider_to / rider_opened_at (vault and salt rows must be deleted first).

CREATE TABLE ledger_entries_new (
  id                  TEXT PRIMARY KEY,                                    -- led_<uuid>
  companion_id        TEXT NOT NULL CHECK (companion_id IN ('drevan', 'cypher', 'gaia')),
  function            TEXT NOT NULL,
  body                TEXT NOT NULL,
  content             TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('message', 'window', 'session', 'row', 'vault')),
  source_ref          TEXT NOT NULL,
  observed_on         TEXT NOT NULL,                                       -- YYYY-MM-DD
  created_at          TEXT NOT NULL,                                       -- ISO, set by the door
  dedup_key           TEXT UNIQUE,
  state               TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept', 'dropped')),
  state_at            TEXT,
  promoted_journal_id TEXT,
  rider               TEXT,                                                -- mig 0168: the imp that rode the line
  rider_to            TEXT,                                                -- mig 0175: a salt's receiver
  rider_opened_at     TEXT                                                 -- mig 0175: when the receiver opened it
);

INSERT INTO ledger_entries_new
  (id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, dedup_key,
   state, state_at, promoted_journal_id, rider)
  SELECT id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, dedup_key,
         state, state_at, promoted_journal_id, rider
    FROM ledger_entries;

DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_new RENAME TO ledger_entries;

-- Orient + "my ledger": open entries about one subject, newest first.
CREATE INDEX IF NOT EXISTS idx_ledger_subject_state ON ledger_entries (companion_id, state, created_at);
-- The SB feeds page on (the later of created_at / state_at, id); state narrows open+kept vs dropped.
CREATE INDEX IF NOT EXISTS idx_ledger_state_created ON ledger_entries (state, created_at);
-- The receiver's count of unopened salt.
CREATE INDEX IF NOT EXISTS idx_ledger_salt_receiver ON ledger_entries (rider_to, rider_opened_at, created_at) WHERE rider_to IS NOT NULL;
