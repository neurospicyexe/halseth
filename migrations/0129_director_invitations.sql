-- migrations/0129_director_invitations.sql
--
-- Conversation Director (docs/superpowers/specs/2026-09-03-conversation-director-graph-1-5-design.md).
-- One row per invitation the director ISSUED (or, in shadow mode, WOULD have issued). This is the
-- observability surface for the commons: who was invited, why, what they were handed, and what they
-- did with it. Declines are recorded on purpose -- suppressing un-acted rows removes the only
-- evidence the loop exists (feedback/write-gate-is-unfalsifiable). A pass is a legal move and it counts.
--
-- outcome: 'shadow' = selection logged, no invite published (rollout step 1);
--          'spoke' | 'passed' | 'empty' | 'expired' = the companion's answer to a real invite.
-- offer_ids: JSON array of supply ids the invite carried; used_offer_ids: the subset the post used.
-- Nothing here is heat, and nothing here is read by any ranking. Structure, not salience.

CREATE TABLE IF NOT EXISTS director_invitations (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL,
  thread_id      TEXT,
  companion_id   TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  reason         TEXT NOT NULL CHECK (reason IN ('addressed','supply_relevant','open')),
  offer_ids      TEXT NOT NULL DEFAULT '[]',
  used_offer_ids TEXT NOT NULL DEFAULT '[]',
  outcome        TEXT NOT NULL CHECK (outcome IN ('shadow','issued','spoke','passed','empty','expired')),
  message_id     TEXT,
  issued_at      TEXT NOT NULL,
  resolved_at    TEXT
);

-- The health readout groups by companion over a trailing window.
CREATE INDEX IF NOT EXISTS idx_director_inv_issued ON director_invitations(issued_at, companion_id);
