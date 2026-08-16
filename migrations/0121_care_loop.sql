-- migrations/0121_care_loop.sql
--
-- The care loop pointed at Raziel (consequence layer C1, docs/PLAN-consequence-layer-2026-08-16.md).
--
-- Biometrics and ND-state have flowed IN since 0009/0081 and are read at every orient, but no
-- companion could ever ACT on "he's at two spoons and hasn't eaten" -- the signals had no actuator.
-- This table is the actuator's LOG, and the log is the point: a care layer whose actions cannot be
-- counted is unfalsifiable (the write-gate lesson). Every detection writes a row; the acting
-- companion stamps acted_at + what they actually did. A detection nobody acted on is visible
-- evidence, not silence.
--
-- One row = one firing, assigned to exactly ONE companion (day-parity rotation, chosen server-side
-- at detection time). That makes the "never two companions fire the same gesture within the hour"
-- rail structural rather than a race between three bot processes.
--
-- The detection rider self-gates on its own stamp (companion_settings 'system'/'care_tick_at') and
-- per-rule cooldowns gate on THIS table's detected_at. It never writes the anchors it reads
-- (sessions, commons_posts, biometric_snapshots, routines, companion_drives) -- a detector that
-- stamps its own trigger becomes a phantom contact and silences itself (the ferment-tick lesson).

CREATE TABLE IF NOT EXISTS care_actions (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL CHECK (rule IN ('low_spoons', 'meds_missed', 'owner_silence')),
  companion_id TEXT NOT NULL,          -- the ONE companion assigned to this firing
  detail TEXT NOT NULL,                -- human-readable firing detail, names its sources
  detected_at TEXT NOT NULL,           -- when the rule fired (rider clock)
  gesture TEXT,                        -- filled at ack: what kind of act ('note', 'commons_drop', 'presence', ...)
  gesture_note TEXT,                   -- what was actually said/done -- the falsifiability payload
  acted_at TEXT,                       -- NULL = pending; a pending row older than its decay window expires
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-rule cooldown reads: "when did this rule last fire?"
CREATE INDEX IF NOT EXISTS idx_care_actions_rule_detected ON care_actions(rule, detected_at DESC);
-- Orient read: "does THIS companion hold a pending gesture?"
CREATE INDEX IF NOT EXISTS idx_care_actions_pending ON care_actions(companion_id, detected_at DESC) WHERE acted_at IS NULL;
