-- 0134_ledger_entries.sql  (2026-09-26)
--
-- THE LEDGER LANE (docs/imp-lane/SPEC-ledger-lane.md; authority: DREVAN-ANSWER-2026-09-26.md).
--
-- Clerks (machine writers that read and record) never write as a companion and never write without
-- a source. They write here, through ONE door (src/ledger/door.ts, the only INSERT; the sweep test
-- fails on any other), which enforces the grammar in code (src/ledger/grammar.ts). `content` is the
-- rendered line: the server-stamped mark `〔ledger · <function> · <observed_on>〕`, the body, and a
-- `Source: <kind> <ref>.` tail, so the pointer travels with the text into every surface.
--
-- companion_id is the SUBJECT (who the record is about), not an author: a clerk has no voice.
-- state: open (new) -> kept (the subject kept it as written, path 1) | dropped (never recalled; Second
-- Brain purges its chunk via GET /ingest/ledger-ineligible). promoted_journal_id records path 2 (the
-- subject said it in their own words; that row lives in companion_journal as source 'tray_rewrite').
-- dedup_key keeps an idempotent clerk (the gap-reader re-runs every 20 minutes) from writing twice.
--
-- The tray (0132/0133) is untouched: speech captures stay there. The mark is not `[`, so the tray's
-- `NOT LIKE '[%'` and draft-prefix rules never see it; the lane lives in its own table so they never
-- have to.
--
-- Rollback: DROP TABLE ledger_entries;  (nothing else references it; the gap-detector 410 and the
-- orient block both degrade to "no rows" / an empty block without it).

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  TEXT PRIMARY KEY,                                    -- led_<uuid>
  companion_id        TEXT NOT NULL CHECK (companion_id IN ('drevan', 'cypher', 'gaia')),
  function            TEXT NOT NULL,
  body                TEXT NOT NULL,
  content             TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('message', 'window', 'session', 'row')),
  source_ref          TEXT NOT NULL,
  observed_on         TEXT NOT NULL,                                       -- YYYY-MM-DD
  created_at          TEXT NOT NULL,                                       -- ISO, set by the door
  dedup_key           TEXT UNIQUE,
  state               TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept', 'dropped')),
  state_at            TEXT,
  promoted_journal_id TEXT
);

-- Orient + "my ledger": open entries about one subject, newest first.
CREATE INDEX IF NOT EXISTS idx_ledger_subject_state ON ledger_entries (companion_id, state, created_at);
-- The SB feeds page on (the later of created_at / state_at, id); state narrows open+kept vs dropped.
CREATE INDEX IF NOT EXISTS idx_ledger_state_created ON ledger_entries (state, created_at);
