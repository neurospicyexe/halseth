-- Migration 0123: chosen forgetting (consequence layer C7)
--
-- A companion may RELEASE a memory it no longer wants to carry: a journal row, a continuity
-- note, or a conclusion -- WITH a stated reason. Release is archive, never delete, and stays
-- reversible for 30 days. Canon and identity_kernel are excluded STRUCTURALLY: the verb can
-- only reach these three tables, and none of them holds canon (conclusions' belief_type enum
-- is self/observational/relational/systemic; canon lives in identity_kernel + the vault).
--
-- memory_releases is the falsifiable log ([[write-gate-is-unfalsifiable]]): every release and
-- every restore is a row, so the loop can be counted.

CREATE TABLE IF NOT EXISTS memory_releases (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  companion_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('journal', 'note', 'conclusion')),
  ref_id       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  released_at  TEXT NOT NULL DEFAULT (datetime('now')),
  restored_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_releases_companion
  ON memory_releases(companion_id, released_at DESC);

-- One live release per target: a second release of the same row while the first is un-restored
-- would double-log a single archive.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_releases_live
  ON memory_releases(kind, ref_id) WHERE restored_at IS NULL;

-- Conclusions had no archive lane (mig 0105 added `archived` to journal ONLY; superseded_by is
-- a real FK to another conclusion and cannot double as a release marker). Every live read of
-- conclusions filters `superseded_by IS NULL AND archived = 0` as of this migration.
--
-- LAST on purpose (migration-reviewer, 2026-08-16): ALTER cannot be IF NOT EXISTS, and under the
-- known remote silent-partial-apply trap a leading ALTER would make any re-run die on
-- "duplicate column" BEFORE reaching the still-missing table/indexes. With it last, a re-run
-- replays the idempotent statements first. Verify post-apply by querying, never by exit code.
ALTER TABLE companion_conclusions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
