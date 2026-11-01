-- 0156_tray_evidence.sql: one moment, one tray draft (STATUS B34 step 2)
--
-- One exchange is written as several drafts by different writers: the speech journaler
-- (discord_speech), the memory judge (memory_judge) and the judge's observation note promotion. Each
-- writer dedups only against itself, so Drevan's tray is mostly the same moment three times. The
-- moment key is the human line's Discord message id: judge rows carry it as external_id /
-- correlation_id `judge:<id>`, speech rows as a `reply_to:<id>` tag (bots from nullsafe-discord
-- 7e915f3). Rows without a key are never merged.
--
-- tray_evidence records "this row is evidence for that primary row". The evidence row is STILL
-- INSERTED (lossless: retract, external_id idempotency and writer liveness all keep working) but in
-- `on` mode it is born/demoted to review_state 'merged' -- not a draft (never in the tray), not kept
-- (never recall). review_state has no CHECK constraint, so 'merged' needs no table rebuild.
--
-- mode: 'shadow' rows record what `on` WOULD have done (no review_state changes anywhere); 'on' rows
-- record a merge that happened. TRAY_MERGE_MODE (off | shadow | on, per-companion override
-- TRAY_MERGE_MODE_<AGENT>) decides which is written. UNIQUE(evidence_table, evidence_id, mode) makes
-- a retried write idempotent.
--
-- Rollback: DROP TABLE tray_evidence; UPDATE companion_journal SET review_state = 'draft' WHERE
-- review_state = 'merged' (same for wm_continuity_notes) puts every merged row back in the tray.

CREATE TABLE IF NOT EXISTS tray_evidence (
  id             TEXT PRIMARY KEY,
  agent          TEXT NOT NULL,
  moment_key     TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('shadow','on')),
  primary_table  TEXT NOT NULL CHECK (primary_table IN ('companion_journal','wm_continuity_notes')),
  primary_id     TEXT NOT NULL,
  evidence_table TEXT NOT NULL CHECK (evidence_table IN ('companion_journal','wm_continuity_notes')),
  evidence_id    TEXT NOT NULL,
  writer         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (evidence_table, evidence_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_tray_evidence_moment  ON tray_evidence (agent, moment_key);
CREATE INDEX IF NOT EXISTS idx_tray_evidence_primary ON tray_evidence (primary_table, primary_id);
