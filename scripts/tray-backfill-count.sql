-- scripts/tray-backfill-count.sql  (mig 0132, 2026-09-26)
--
-- Row counts the 0132 backfill will touch / did touch. Run BEFORE and AFTER applying the migration:
--
--   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --file scripts/tray-backfill-count.sql
--
-- Before 0132 the review_state column does not exist, so the second and fourth statements fail on a
-- pre-migration database; the first and third (per-source / per-prefix live counts) are the "before".
-- After 0132 all four run: the per-state counts must equal the per-source / per-prefix live counts.

-- 1. companion_journal: live rows per clerk source (what the backfill drafts).
SELECT 'journal_live_by_source' AS metric, COALESCE(source, '<null>') AS bucket, COUNT(*) AS n
  FROM companion_journal
 WHERE archived = 0
   AND source IN ('discord_speech', 'memory_judge', 'autonomous', 'vibecheck')
 GROUP BY source
 ORDER BY source;

-- 2. companion_journal: rows per review_state (after only).
SELECT 'journal_by_review_state' AS metric, review_state AS bucket, COUNT(*) AS n
  FROM companion_journal
 GROUP BY review_state
 ORDER BY review_state;

-- 3. wm_continuity_notes: live rows per clerk prefix / key (what the backfill drafts).
SELECT 'notes_live_by_prefix' AS metric,
       CASE
         WHEN correlation_id LIKE 'judge:%'              THEN 'judge:key'
         WHEN content LIKE '[discord:pulse]%'            THEN '[discord:pulse]'
         WHEN content LIKE '[metronome/%'                THEN '[metronome/'
         WHEN content LIKE '[discord:observation]%'      THEN '[discord:observation]'
       END AS bucket,
       COUNT(*) AS n
  FROM wm_continuity_notes
 WHERE archived = 0
   AND (correlation_id LIKE 'judge:%'
        OR content LIKE '[discord:pulse]%'
        OR content LIKE '[metronome/%'
        OR content LIKE '[discord:observation]%')
 GROUP BY bucket
 ORDER BY bucket;

-- 4. wm_continuity_notes: rows per review_state (after only).
SELECT 'notes_by_review_state' AS metric, review_state AS bucket, COUNT(*) AS n
  FROM wm_continuity_notes
 GROUP BY review_state
 ORDER BY review_state;
