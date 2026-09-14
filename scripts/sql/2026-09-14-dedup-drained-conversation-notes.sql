-- 2026-09-14: the Hermes memory-queue drain (nullsafe-discord/ops/drain-hermes-memory-queue.py,
-- 2026-08-12) re-posted files on crash-retry by design ("a duplicate note is recoverable, a
-- silently dropped one is not"). Measured in prod before this ran: 209 pending source='conversation'
-- rows, 113 distinct by (companion_id, content); 95 exact duplicates, none vaulted, none referenced
-- by home_events. Now that these logs are vault-worthy (halseth 927b112), each duplicate would
-- become its own vault file, so the earliest copy stays and the rest go.
--
-- Run once:  npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --file scripts/sql/2026-09-14-dedup-drained-conversation-notes.sql
DELETE FROM growth_journal
WHERE source = 'conversation' AND review_status = 'pending' AND vault_path IS NULL
  AND id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY companion_id, content ORDER BY created_at, id) AS rn
      FROM growth_journal WHERE source = 'conversation' AND review_status = 'pending'
    ) WHERE rn > 1
  );
