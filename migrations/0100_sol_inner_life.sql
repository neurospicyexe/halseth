-- 0100_sol_inner_life.sql
-- Sol inner life (corvid take 2, 2026-07-10). The wave-1 pet had one scalar (trust)
-- and ten canned strings. This wave gives him the corvid repo's real lessons:
-- drives x trust-tier behavior composition (pure TS, no schema), one-time trust
-- MILESTONES, and a NEST he actually keeps (fragments overheard from the house's
-- own life + gifts given to him, sparkle decay, treasured items, gifting back).
--
-- No FK REFERENCES by design -- matches creatures/creature_interactions (0078);
-- D1 enforces parent-delete FKs even with nullable children (feedback d1-fk-delete).

-- One-time trust-threshold events. Fired exactly once per (creature, milestone);
-- the PK is the only guard needed. witnessed_by = the actor whose interaction
-- pushed trust across the line (NULL for backfilled history).
CREATE TABLE creature_milestones (
  creature_id  TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
  witnessed_by TEXT,
  PRIMARY KEY (creature_id, milestone_id)
);

-- The hoard. Active nest = rows where gifted_to IS NULL. Sparkle decays in the
-- daily tick (single writer); items surviving 24h with sparkle intact become
-- treasured (resist eviction, floor 0.3). Gifting back sets gifted_to/gifted_at
-- and keeps the row -- a gift is history, not deletion.
CREATE TABLE creature_nest (
  id          TEXT PRIMARY KEY,
  creature_id TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'overheard',  -- overheard:<where> | gift
  given_by    TEXT,                               -- actor, when source='gift'
  sparkle     REAL NOT NULL DEFAULT 1.0,
  treasured   INTEGER NOT NULL DEFAULT 0,
  gifted_to   TEXT,
  gifted_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_creature_nest_active ON creature_nest (creature_id, gifted_to, treasured DESC, sparkle DESC);

-- Backfill: milestones a creature has already lived past fire silently into history
-- (Sol is at trust 0.78 -- he crossed these unwitnessed, and they should read as his
-- past, not as fresh events at deploy time). Thresholds mirror MILESTONES in
-- src/webmind/creatures.ts. 0.80 / 0.95 / 1.00 are deliberately NOT backfilled:
-- nothing has crossed them yet, and they should fire live.
INSERT OR IGNORE INTO creature_milestones (creature_id, milestone_id, witnessed_by)
  SELECT id, 'first_approach', NULL FROM creatures WHERE trust >= 0.15;
INSERT OR IGNORE INTO creature_milestones (creature_id, milestone_id, witnessed_by)
  SELECT id, 'first_hand_feed', NULL FROM creatures WHERE trust >= 0.35;
INSERT OR IGNORE INTO creature_milestones (creature_id, milestone_id, witnessed_by)
  SELECT id, 'chooses_to_stay', NULL FROM creatures WHERE trust >= 0.50;
INSERT OR IGNORE INTO creature_milestones (creature_id, milestone_id, witnessed_by)
  SELECT id, 'first_treasure', NULL FROM creatures WHERE trust >= 0.70;
