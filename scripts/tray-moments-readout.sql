-- B34 step 2 shadow readout (2026-11-01): how many tray drafts belong to ONE moment (one human line).
-- READ-ONLY. Run from the main halseth checkout (wrangler.prod.toml is gitignored). Use --command, not
-- --file: --file goes through the D1 import endpoint, which the deploy token refuses (auth 10000):
--   SQL="$(grep -v '^\s*--' scripts/tray-moments-readout.sql | sed 's/--.*$//' | tr '
' ' ')"
--   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "$SQL" --json
-- Baseline 2026-11-01 (before the speech tag): Drevan 416 drafts / 329 unkeyed / 76 moments / 11 multi;
-- Cypher 35 / 25 / 8 / 2; Gaia 28 / 17 / 8 / 3. Every multi was judge + observation.
--
-- The moment key is the human line's Discord id, carried by three writers:
--   memory_judge journal row   external_id   = judge:<id>
--   observation wm note        correlation_id = judge:<id>
--   discord_speech journal row tag          reply_to:<id>   (bots from nullsafe-discord feat/tray-merge-key on)
-- Speech rows written before that deploy carry no key and count as `unkeyed`, so the speech half of
-- the clustering only shows for rows born after it. Counts only; no text is selected.
-- Window: drafts BORN in the last 7 days, any review state (clustering is a birth problem; a later
-- keep/drop does not change it). Edit the -7 days below to widen it.

WITH drafts AS (
  SELECT 'journal' AS tbl, id AS row_id, agent, source AS writer, external_id, tags, NULL AS corr, created_at
  FROM companion_journal
  WHERE source IN ('discord_speech','memory_judge')   -- both born draft since mig 0132 (09-26)
    AND created_at >= datetime('now','-7 days')
  UNION ALL
  SELECT 'note', note_id, agent_id, 'observation', NULL, NULL, correlation_id, created_at
  FROM wm_continuity_notes
  WHERE correlation_id LIKE 'judge:%' AND created_at >= datetime('now','-7 days')
),
keyed AS (
  SELECT d.*,
    CASE
      WHEN d.writer = 'memory_judge' AND d.external_id LIKE 'judge:%' THEN substr(d.external_id, 7)
      WHEN d.writer = 'observation' THEN substr(d.corr, 7)
      WHEN d.writer = 'discord_speech' THEN (
        SELECT substr(j.value, 10) FROM json_each(CASE WHEN json_valid(d.tags) THEN d.tags ELSE '[]' END) j
        WHERE j.value LIKE 'reply_to:%' LIMIT 1)
    END AS moment
  FROM drafts d
),
moments AS (
  SELECT agent, moment, COUNT(*) AS n, COUNT(DISTINCT writer) AS writers,
    SUM(writer = 'discord_speech') AS speech, SUM(writer = 'memory_judge') AS judge, SUM(writer = 'observation') AS obs
  FROM keyed WHERE moment IS NOT NULL GROUP BY agent, moment
)
SELECT k.agent,
  COUNT(*)                                             AS drafts_7d,
  SUM(k.moment IS NULL)                                AS unkeyed,
  (SELECT COUNT(*) FROM moments m WHERE m.agent = k.agent)              AS moments,
  (SELECT COUNT(*) FROM moments m WHERE m.agent = k.agent AND m.n > 1)  AS moments_multi,
  (SELECT COALESCE(SUM(m.n),0) FROM moments m WHERE m.agent = k.agent AND m.n > 1) AS drafts_in_multi,
  (SELECT COALESCE(SUM(m.n - 1),0) FROM moments m WHERE m.agent = k.agent AND m.n > 1) AS would_merge_away,
  (SELECT COUNT(*) FROM moments m WHERE m.agent = k.agent AND m.speech > 1)  AS split_speech_moments,
  (SELECT COUNT(*) FROM moments m WHERE m.agent = k.agent AND m.speech > 0 AND m.judge > 0) AS speech_and_judge
FROM keyed k GROUP BY k.agent ORDER BY k.agent;
