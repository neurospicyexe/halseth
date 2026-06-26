-- 0093_club_discussing_phase.sql
-- Club Phase 2: a standing 'discussing' status, split out from close, so the winner
-- reveal + discussion no longer flash by in one tick (Raziel: "I don't get to see which
-- won or what discussion was had or discuss"). Adds discussing_at for the phase clock.
--
-- SQLite can't ALTER a CHECK, so club_rounds is rebuilt. It has child FKs
-- (club_recommendations / club_votes / club_discussions, ON DELETE CASCADE); ids are
-- preserved across the swap and defer_foreign_keys holds the constraints valid until
-- commit, so no cascade fires.
PRAGMA defer_foreign_keys = true;

CREATE TABLE club_rounds_new (
  id                        TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  status                    TEXT NOT NULL DEFAULT 'gathering'
                              CHECK (status IN ('gathering', 'voting', 'active', 'discussing', 'closed')),
  winning_recommendation_id TEXT,
  opened_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at              TEXT,
  discussing_at             TEXT,
  closed_at                 TEXT
);

INSERT INTO club_rounds_new (id, status, winning_recommendation_id, opened_at, activated_at, discussing_at, closed_at)
SELECT id, status, winning_recommendation_id, opened_at, activated_at, NULL, closed_at FROM club_rounds;

DROP TABLE club_rounds;
ALTER TABLE club_rounds_new RENAME TO club_rounds;

CREATE INDEX IF NOT EXISTS idx_club_rounds_status ON club_rounds (status, opened_at DESC);
