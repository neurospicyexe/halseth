// src/webmind/ground.ts
//
// mind_ground: detailed continuity context.
// Retrieval order: open threads (priority desc, last_touched_at desc) -> recent handoffs -> recent notes.

import { Env } from "../types.js";
import { WmAgentId, WmGroundResponse, WmMindThread, WmSessionHandoff, WmContinuityNote, WmOpenLoop, WmArchiveDigest } from "./types.js";
import { readSittingNotes } from "./sits.js";

export async function mindGround(env: Env, agentId: WmAgentId): Promise<WmGroundResponse> {
  const [threads, handoffs, notes, openLoops, sittingNotes, archivedDigests] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM wm_mind_threads WHERE agent_id = ? AND status = 'open' ORDER BY priority DESC, last_touched_at DESC LIMIT 10"
    ).bind(agentId).all<WmMindThread>(),
    env.DB.prepare(
      "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmSessionHandoff>(),
    env.DB.prepare(
      "SELECT * FROM wm_continuity_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10"
    ).bind(agentId).all<WmContinuityNote>(),
    // Open loops: unresolved things with weight -- heaviest first
    env.DB.prepare(
      // `opened_at ASC` as tiebreak, added wave 7. This shipped as bare `weight DESC`, which is
      // NONDETERMINISTIC at equal weight -- two boots could legitimately return different loops in a
      // different order with nothing changed in the data. Three copies of this query existed with three
      // different orderings (orient: opened_at ASC, bot: opened_at DESC, here: none). ASC is canonical: at
      // equal weight the loop that has been open LONGEST surfaces first, which is the same tiebreak the
      // tension query uses (charge DESC, first_noted_at ASC). One convention for "what am I carrying".
      "SELECT * FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL ORDER BY weight DESC, opened_at ASC LIMIT 5"
    ).bind(agentId).all<WmOpenLoop>(),
    // Sitting notes: oldest first (longest waiting for metabolization).
    // Migration 0034 moved sits to companion_journal/companion_journal_sits;
    // read through the canonical reader so ground can never drift from the write path again.
    readSittingNotes(env, agentId, { limit: 5 }),
    // Archive digests: compressed remains of cap-evicted continuity notes. The cap
    // digest-then-deletes overflow (notes.ts addNote), and until 2026-07-26 nothing
    // read the digests back -- evicted memory was silently unreachable forever.
    env.DB.prepare(
      "SELECT id, agent_id, summary, note_count, period_from, period_to, created_at FROM wm_archive_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<WmArchiveDigest>(),
  ]);

  return {
    threads: threads.results ?? [],
    recent_handoffs: handoffs.results ?? [],
    recent_notes: notes.results ?? [],
    open_loops: openLoops.results ?? [],
    sitting_notes: sittingNotes,
    archived_digests: archivedDigests.results ?? [],
  };
}
