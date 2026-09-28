-- 0131: skill-proposal mirror -- the Hermes skill-approval stage becomes visible off-VPS.
-- The VPS watcher POSTs each staged skill record here at stage time (and PATCHes the
-- decision when Raziel taps Approve/Decline on Telegram), so every substrate --
-- Claude.ai chat, cloud sessions, Hearth, the triad via the Librarian -- can read the
-- pending queue without SSH access to the VPS. Mirror, not authority: the stage on the
-- VPS remains the source of truth for the skill files themselves; this table is the
-- review surface plus the durable evidence trail (closes the "approvals leave no
-- evidence" gap from the 2026-09-27 pipeline hardening).
CREATE TABLE IF NOT EXISTS skill_proposals (
  id            TEXT PRIMARY KEY,
  external_id   TEXT UNIQUE,               -- watcher's stage-record id; idempotency key for re-posts
  companion_id  TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  hermes_home   TEXT,                      -- companion-labeled home, never a raw basename (0927 label defect)
  skill_name    TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'create' CHECK (action IN ('create','update')),
  summary       TEXT,                      -- reviewer-fork's rationale for the skill
  content       TEXT,                      -- full SKILL.md body (or patch) as staged
  status        TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','approved','declined')),
  decided_by    TEXT,
  decision_note TEXT,
  staged_at     TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status, staged_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_companion ON skill_proposals(companion_id, staged_at DESC);
