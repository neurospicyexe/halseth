-- Dream seeds: Architect-injected prompts for companions to process during autonomous time.
-- Companions call halseth_dream_seed_read to claim the oldest unclaimed seed.
-- If no seed is pending, they fall back to reading deltas and handovers.

CREATE TABLE IF NOT EXISTS dream_seeds (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  content       TEXT NOT NULL,              -- the seed text / prompt / image description
  for_companion TEXT,                       -- NULL = any companion, or 'drevan'/'cypher'/'gaia'
  claimed_at    TEXT,                       -- NULL = unclaimed
  claimed_by    TEXT                        -- companion ID that claimed it
);

CREATE INDEX IF NOT EXISTS idx_dream_seeds_claimed ON dream_seeds(claimed_at);
