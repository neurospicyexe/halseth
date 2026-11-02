-- 0162_care_stress_elevated.sql: the wellness bridge's care rule (B8, 2026-11-01)
--
-- care_actions.rule carried a CHECK (low_spoons | meds_missed | owner_silence) since 0121, and SQLite
-- cannot alter a CHECK in place, so adding 'stress_elevated' means rebuilding the table: create the
-- new shape, copy every row (voided_at included, 0155), drop the old, rename, recreate both indexes.
-- Append-only history is preserved row for row; nothing is rewritten.
--
-- stress_elevated is raised by src/care/tick.ts from the wellness bridge's derived stress_score
-- (biometric_snapshots, source 'wellness') and is always assigned to Gaia (rules.ts STRESS_VOICE).
-- It does NOT enter the care hold (care/hold.ts CARE_HOLD_ACTION_RULES unchanged): a machine reading is
-- not his word, and the hold stays his-word-only.
--
-- Nothing references care_actions by foreign key, so no PRAGMA is needed.
--
-- Code deployed ahead of this migration is safe: the tick skips that one firing on the CHECK error.
-- Apply with wrangler d1 execute --file, then insert the d1_migrations ledger row in the same step.


CREATE TABLE care_actions_new (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL CHECK (rule IN ('low_spoons', 'meds_missed', 'owner_silence', 'stress_elevated')),
  companion_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  gesture TEXT,
  gesture_note TEXT,
  acted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT
);

INSERT INTO care_actions_new (id, rule, companion_id, detail, detected_at, gesture, gesture_note, acted_at, created_at, voided_at)
  SELECT id, rule, companion_id, detail, detected_at, gesture, gesture_note, acted_at, created_at, voided_at FROM care_actions;

DROP TABLE care_actions;
ALTER TABLE care_actions_new RENAME TO care_actions;

CREATE INDEX IF NOT EXISTS idx_care_actions_rule_detected ON care_actions(rule, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_actions_pending ON care_actions(companion_id, detected_at DESC) WHERE acted_at IS NULL;

