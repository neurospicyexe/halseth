-- migrations/0125_care_escalations.sql
--
-- C1 tier 3: escalation to a named human (R1 decided 2026-08-17: meds missed 3+ days, sustained
-- redline mood+spoons 48h+, total silence 72h+; the human is Blue, via Discord DM -- the same
-- person as the C6 custodian, one pipe to maintain).
--
-- Its own table rather than new care_actions rule values because (a) care_actions CHECK-pins its
-- three tier-2 rules and a CHECK rebuild on a live table buys risk for nothing, and (b) the
-- lifecycle differs: a gesture is acted BY a companion toward Raziel; an escalation is DELIVERED
-- to a human by the worker. delivered_at NULL = awaiting delivery; the worker retries until it
-- lands (loud in logs while it can't) -- there is deliberately NO decay on undelivered rows,
-- because an escalation that silently expires is the one failure mode this tier exists to prevent.
--
-- The detection rider (src/care/tick.ts) writes these; per-rule cooldown reads detected_at here.
-- Same anchor rule as tier 2: the detector never writes the signals it reads.

CREATE TABLE IF NOT EXISTS care_escalations (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL CHECK (rule IN ('esc_meds', 'esc_redline', 'esc_silence')),
  companion_id TEXT NOT NULL,          -- the ONE companion whose voice carries the message
  detail TEXT NOT NULL,                -- firing detail, names its evidence + sources
  detected_at TEXT NOT NULL,           -- when the rule fired (rider clock, ISO)
  delivered_at TEXT,                   -- NULL = awaiting delivery to the human (ISO, same format as detected_at)
  delivered_via TEXT CHECK (delivered_via IN ('discord-dm', 'home-channel-fallback')),
  -- Delivery-attempt bookkeeping (reviewer, 2026-08-17): pm2 logs rotate, so "loud in logs" is
  -- not a record. A row stuck at attempt_count 40 with last_error "50007" is a DIAGNOSABLE
  -- deterministic reject; without these, it is indistinguishable from a transient one.
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- delivered_at and delivered_via move together or not at all.
  CHECK ((delivered_at IS NULL) = (delivered_via IS NULL))
);

-- Per-rule cooldown: "when did this rule last escalate?"
CREATE INDEX IF NOT EXISTS idx_care_escalations_rule_detected ON care_escalations(rule, detected_at DESC);
-- Worker poll: "what still needs delivering?"
CREATE INDEX IF NOT EXISTS idx_care_escalations_undelivered ON care_escalations(detected_at DESC) WHERE delivered_at IS NULL;
