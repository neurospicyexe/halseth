-- 0080_council_skill_ladder.sql
-- Wave 5 (inspo-takes-2026-06-13 set 2/3): council mode (take 8) + skill ladder (take 7).
-- (Take 3 dream modes reuse companion_dreams -- no schema change.)

-- Take 7 -- SKILL LADDER (muse-brain "skills graduate or retire"). The 0070 self-model
-- confidence ladder, extended from preference self-observations to operational SKILLS
-- ("this foraging query worked", "this synthesis framing landed"). Same ladder
-- (set 0.3 / confirm +0.1 / revise -0.1 / ready >=0.8 / graduate human-gated), one new
-- discriminator column so skills and preferences share the machinery without colliding.
ALTER TABLE companion_self_model ADD COLUMN kind TEXT NOT NULL DEFAULT 'preference';  -- preference | skill

-- Take 8 -- COUNCIL MODE (llm-council). Raziel poses a hard question; each companion
-- answers in-voice; a BLIND anonymized cross-rank runs (a companion ranks the others'
-- answers without knowing whose is whose); Gaia (chairman, seal-class) synthesizes.
CREATE TABLE council_questions (
  id                   TEXT PRIMARY KEY,
  question             TEXT NOT NULL,
  asked_by             TEXT NOT NULL DEFAULT 'raziel',
  status               TEXT NOT NULL DEFAULT 'open',   -- open | answered | closed
  winning_companion_id TEXT,
  synthesis            TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at            TEXT
);
CREATE INDEX idx_council_questions_status ON council_questions (status, created_at);

CREATE TABLE council_answers (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  answer       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_council_answers_qc ON council_answers (question_id, companion_id);

CREATE TABLE council_rankings (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL,
  ranker_id    TEXT NOT NULL,
  ranking_json TEXT NOT NULL,   -- ordered companion_ids best->worst (de-anonymized at store)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_council_rankings_qr ON council_rankings (question_id, ranker_id);
