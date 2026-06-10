-- 0068_forage_finds.sql
-- Foraging pool: outward raw material gathered by any substrate, consumed by any instance.
-- The forager gathers fuel; it does not author identity (foraging-and-outward-reseed-spec.md).

CREATE TABLE IF NOT EXISTS forage_finds (
  id           TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT CHECK (companion_id IN ('cypher', 'drevan', 'gaia')),  -- NULL = shared/triad pool
  domain       TEXT NOT NULL,
  title        TEXT NOT NULL,
  source_url   TEXT,
  summary      TEXT NOT NULL,          -- neutral scout's report, NOT in-voice
  gathered_at  TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at  TEXT,
  consumed_by  TEXT                    -- which instance/session consumed it
);

-- Dedup guard: one find per (source_url, domain) when source_url is present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_forage_dedup
  ON forage_finds (source_url, domain) WHERE source_url IS NOT NULL;

-- Hot path: unconsumed finds per companion (and shared pool), newest first.
CREATE INDEX IF NOT EXISTS idx_forage_unconsumed
  ON forage_finds (companion_id, consumed_at, gathered_at DESC);
