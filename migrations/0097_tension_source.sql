-- Migration 0097: tension source tracking
--
-- Re-audit 2026-07-09 finding: routeLiveTensionsIntoSelfDefense (0095-era fix) fans live
-- tensions out to all three companions on every limbic regeneration (~hourly) and dedupes
-- by exact tension_text -- but the swarm rephrases "the same" tension slightly between
-- passes, so exact-match dedup never catches it. Result: the same ~6 tensions accumulating
-- 3x/hour, plus (separately) the swarm's live_tensions occasionally contain a leaked
-- write-command string ("save tension: ...") verbatim instead of the intended content.
--
-- Fix (src/webmind/limbic.ts) moves from append+dedup to replace: each limbic regeneration
-- supersedes the PRIOR swarm-derived simmering set for a companion rather than adding to it.
-- source distinguishes swarm-written rows (replaceable) from companion/human-authored ones
-- (via the "add tension" command -- never touched by the replace).

ALTER TABLE companion_tensions ADD COLUMN source TEXT;
