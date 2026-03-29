// src/webmind/ground.ts
//
// mind_ground: detailed continuity context.
// Retrieval order: open threads (priority desc, last_touched_at desc) -> recent handoffs -> recent notes.

import { Env } from "../types.js";
import { WmAgentId, WmGroundResponse, WmMindThread, WmSessionHandoff, WmContinuityNote, WmOpenLoop, WmSittingNote } from "./types.js";

export async function mindGround(env: Env, agentId: WmAgentId): Promise<WmGroundResponse> {
  const [threads, handoffs, notes, openLoops, sittingNotes] = await Promise.all([
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
      "SELECT * FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL ORDER BY weight DESC LIMIT 5"
    ).bind(agentId).all<WmOpenLoop>(),
    // Sitting notes: oldest first (longest waiting for metabolization)
    env.DB.prepare(
      `SELECT cn.id AS note_id, cn.content, cn.note_type, cn.created_at,
              cns.sit_text, cns.sat_at
       FROM companion_notes cn
       JOIN companion_note_sits cns ON cns.note_id = cn.id AND cns.companion_id = ?
       WHERE cn.processing_status = 'sitting'
       ORDER BY cns.sat_at ASC LIMIT 5`
    ).bind(agentId).all<WmSittingNote>(),
  ]);

  return {
    threads: threads.results ?? [],
    recent_handoffs: handoffs.results ?? [],
    recent_notes: notes.results ?? [],
    open_loops: openLoops.results ?? [],
    sitting_notes: sittingNotes.results ?? [],
  };
}
