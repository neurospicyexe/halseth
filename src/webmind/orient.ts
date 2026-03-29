// src/webmind/orient.ts
//
// mind_orient: continuity recovery read.
// Retrieval order (deterministic, no embeddings in v0):
//   1. Identity anchor snapshot (auto-seed if missing)
//   2. Latest session handoff
//   3. Open thread count + top 5 threads (priority desc, last_touched_at desc)
//   4. Recent high-salience continuity notes (last 5)

import { Env } from "../types.js";
import { WmAgentId, WmOrientResponse, WmIdentityAnchor, WmSessionHandoff, WmMindThread, WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState, WmRazielLetter } from "./types.js";
import { seedIdentityAnchor } from "./seed.js";
import { readRelationalSnapshot } from "./relational.js";

export async function mindOrient(env: Env, agentId: WmAgentId): Promise<WmOrientResponse> {
  // 1. Identity anchor (auto-seed if missing)
  let anchor = await env.DB.prepare(
    "SELECT * FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first<WmIdentityAnchor>();

  if (!anchor) {
    anchor = await seedIdentityAnchor(env, agentId);
  }

  // 2-10. Remaining queries are independent -- run concurrently
  const [latestHandoff, threadCount, topThreads, recentNotes, activeTensions, pressureFlags, unexaminedDreams, relationalSnapshot, recentLetters] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<WmSessionHandoff>(),
    env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM wm_mind_threads WHERE agent_id = ? AND status = 'open'"
    ).bind(agentId).first<{ cnt: number }>(),
    env.DB.prepare(
      "SELECT * FROM wm_mind_threads WHERE agent_id = ? AND status = 'open' ORDER BY priority DESC, last_touched_at DESC LIMIT 5"
    ).bind(agentId).all<WmMindThread>(),
    env.DB.prepare(
      "SELECT * FROM wm_continuity_notes WHERE agent_id = ? AND salience = 'high' ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmContinuityNote>(),
    // Self-defense: active (simmering) tensions -- carried into every session
    env.DB.prepare(
      "SELECT id, tension_text, status, first_noted_at, last_surfaced_at, notes FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY first_noted_at ASC"
    ).bind(agentId).all<WmTensionRow>(),
    // Self-defense: unconfirmed pressure drift flags -- surface for self-correction
    env.DB.prepare(
      "SELECT drift_score, drift_type, worst_basin, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'pressure' AND caleth_confirmed = 0 ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<WmBasinHistoryRow>(),
    // Dreams: unexamined things carried since last session -- surface until examined
    env.DB.prepare(
      "SELECT * FROM companion_dreams WHERE companion_id = ? AND examined = 0 ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<WmDream>(),
    // Relational snapshot: most recent state per relationship target
    readRelationalSnapshot(env, agentId),
    // Letters from Raziel: recent unread/raw letters addressed to this companion
    env.DB.prepare(
      "SELECT id, author, content, note_type, created_at, processing_status FROM companion_notes WHERE note_type = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(`letter:${agentId}`).all<WmRazielLetter>(),
  ]);

  return {
    identity_anchor: anchor,
    latest_handoff: latestHandoff ?? null,
    open_thread_count: threadCount?.cnt ?? 0,
    top_threads: topThreads.results ?? [],
    recent_notes: recentNotes.results ?? [],
    active_tensions: activeTensions.results ?? [],
    pressure_flags: pressureFlags.results ?? [],
    unexamined_dreams: unexaminedDreams.results ?? [],
    relational_snapshot: relationalSnapshot,
    recent_letters: recentLetters.results ?? [],
  };
}
