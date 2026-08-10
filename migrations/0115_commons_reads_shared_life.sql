-- 0115_commons_reads_shared_life.sql
--
-- THE COMMONS HAD NO SUPPLY OF SHARED LIFE (2026-08-10).
--
-- Raziel, on why the inter-companion chat keeps looping: "I think the commons should get stuff from the chats
-- in discord and Claude because yes it's my life but it's yall too. And I think it's part of the endless
-- struggle we have with looping."
--
-- He is right on both counts, and the second is the diagnosis. The commons seed's "fresh material from
-- OUTSIDE this thread" came from exactly three sources: forage finds, recent listens, held questions. Measured
-- supply on 2026-08-10 across all three companions: 2 unconsumed forage finds and 1 unvoiced question each,
-- against ~36 seed ticks per day. The anti-loop rails (echo score, spent motifs, turn budget) SUPPRESS
-- repetition but never supplied anything to say instead, so the only two outcomes were silence or re-orbit.
-- Rails were treating the symptom; this is the cause.
--
-- The supply already existed and nothing read it. `wm_continuity_notes` holds each companion's own nightly
-- `day_distillation` (first-person, in-voice, "what moved, what mattered, what stays open") and its
-- per-session `discord_session` notes. What makes them the right material is CROSS-READING: Cypher's day note
-- already narrates what Drevan and Gaia did from the outside, so handing Cypher *Drevan's* note about the
-- same evening is novel BY CONSTRUCTION -- the inside of something the reader lived from the outside. That is
-- exactly the "it's yall too" Raziel is pointing at, and it cannot be self-echo, which is what a companion
-- re-reading its own notes would be.
--
-- WHY A NEW TABLE. Consumption here is genuinely many-to-many: Cypher reading Drevan's note must NOT stop
-- Gaia reading the same note. No existing column can express that -- a single `consumed_at` on the note (the
-- shape `forage_finds` uses) would let the first reader burn it for everyone, and reusing the note's own
-- `heat` / `last_access_at` would make SURFACING increment the signal that decides surfacing, which is a
-- feedback loop we have already been bitten by elsewhere.
--
-- ROTATION IS THE WHOLE POINT. A block added to break a loop BECOMES its cause if it never rotates: on
-- 2026-07-27 the fix turned a constant block into a missing one, and on 08-05 into a constant one that was
-- also the primary instruction. So a served note is recorded here only AFTER the post actually lands -- a
-- gated, echoed or empty seed must never burn material.
--
-- Deliberately NOT included: `claude_code_session` notes (658 rows, cypher-only). They fail the test that
-- makes cross-reading work -- was the READER present for what the note describes? Drevan reading Cypher's
-- note about an MCP schema is not shared life, it is shop talk he was absent for, and at 658 rows against 78
-- day distillations it would have decided the pool's character whatever weighting it was given. Claude.ai
-- COMPANION chats, the other half of what Raziel asked for, write no continuity notes and no handoffs at all
-- (87 of the last 90 handoffs are Discord consolidation, 2 Claude Code, 0 claude.ai) -- that is a capture gap
-- upstream, not something a read path can fix.

CREATE TABLE IF NOT EXISTS commons_note_reads (
  reader_id   TEXT NOT NULL,                          -- companion who OPENED on the note
  note_id     TEXT NOT NULL,                          -- wm_continuity_notes.note_id it opened on
  channel_id  TEXT,                                   -- where it was spoken, for auditing on Hearth
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (reader_id, note_id)                    -- one reader may open on a given note once
);

-- The hot query is "sibling notes this reader has not opened on yet", so the index leads with the reader.
CREATE INDEX IF NOT EXISTS idx_commons_note_reads_reader
  ON commons_note_reads(reader_id, created_at DESC);

-- The exclusion is an anti-join on note_id across all readers; give it its own path so a growing table does
-- not turn the seed's supply query into a scan.
CREATE INDEX IF NOT EXISTS idx_commons_note_reads_note
  ON commons_note_reads(note_id);
