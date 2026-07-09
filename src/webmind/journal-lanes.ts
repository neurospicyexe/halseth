// src/webmind/journal-lanes.ts
//
// Journal lanes (2026-07-09). companion_journal holds two very different kinds of
// entry, and they must not compete for the same retrieval slots:
//
//   SUBSTANTIVE  -- a companion's own reflection, session close, growth, synthesis.
//                   Low volume (~40/day across all three), high density.
//   CHATTER      -- transcripts of Discord speech (swarm replies). High volume
//                   (24-61/day on its own), low density per row.
//
// Both belong in the journal: chatter must be searchable and embedded so it is
// recallable BY MEANING. What chatter must never do is occupy fixed recency slots.
//
// History: orient's recent_journal (LIMIT 3, ORDER BY created_at DESC) and the motif
// miner (document frequency) both read companion_journal with NO source filter. While
// discord_swarm was live it therefore owned both surfaces -- `discord:swarm` reached
// recurrence 336/468 and sat in every boot's top-3 [Motifs] block. That is the drown
// this module exists to prevent.
//
// Rule: write-and-index, never write-and-surface.

/** Sources whose entries are transcripts of speech, not authored reflection. */
export const CHATTER_JOURNAL_SOURCES = ["discord_swarm"] as const;

/**
 * SQL predicate selecting the SUBSTANTIVE lane of companion_journal.
 *
 * Hardcoded literal (never interpolated from input) per the parameterized-query
 * covenant. `journal-lanes.test.ts` fails if CHATTER_JOURNAL_SOURCES gains a member
 * that this clause does not exclude, so the two cannot drift apart.
 *
 * NULL source = legacy/companion-authored entry -> substantive.
 */
export const SUBSTANTIVE_JOURNAL_CLAUSE =
  "(source IS NULL OR source NOT IN ('discord_swarm'))";

/** True when an entry with this source belongs to the high-volume chatter lane. */
export function isChatterSource(source: string | null | undefined): boolean {
  if (source === null || source === undefined) return false;
  return (CHATTER_JOURNAL_SOURCES as readonly string[]).includes(source);
}
