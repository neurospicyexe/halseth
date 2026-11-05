-- 0169: forage find expiry (2026-11-05, quiet-drops sweep item 15)
--
-- Finds pile up when supply beats demand: 167 gathered in October against ~60 consumed, while the
-- consumers (seed.ts forage rotation, director invitations, orient pool) are alive and drain oldest
-- first. A find nobody ate in 21 days is stale news, not fuel. The housekeeping rider stamps
-- expired_at on unconsumed finds older than 21 days; every "unconsumed pool" read excludes them.
-- The row is never deleted (collection, graph and sparkle still reference it), and it is NOT marked
-- consumed (consumed_at/consumed_by mean a companion actually used it).
--
-- Rollback: ALTER TABLE forage_finds DROP COLUMN expired_at;  (and revert the readers' predicate)

ALTER TABLE forage_finds ADD COLUMN expired_at TEXT;
