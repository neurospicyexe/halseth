// src/webmind/orient.ts
//
// mind_orient: continuity recovery read.
// Retrieval order (deterministic, no embeddings in v0):
//   1. Identity anchor snapshot (auto-seed if missing)
//   2. Latest session handoff
//   3. Open thread count + top 5 threads (priority desc, last_touched_at desc)
//   4. Recent high-salience continuity notes (last 5)

import { Env } from "../types.js";
import { WmAgentId, WmOrientResponse, WmIdentityAnchor, WmSessionHandoff, WmMindThread, WmContinuityNote } from "./types.js";
import { seedIdentityAnchor } from "./seed.js";

export async function mindOrient(env: Env, agentId: WmAgentId): Promise<WmOrientResponse> {
  // 1. Identity anchor (auto-seed if missing)
  let anchor = await env.DB.prepare(
    "SELECT * FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first<WmIdentityAnchor>();

  if (!anchor) {
    anchor = await seedIdentityAnchor(env, agentId);
  }

  // 2-4. Remaining queries are independent -- run concurrently
  const [latestHandoff, threadCount, topThreads, recentNotes] = await Promise.all([
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
  ]);

  return {
    identity_anchor: anchor,
    latest_handoff: latestHandoff ?? null,
    open_thread_count: threadCount?.cnt ?? 0,
    top_threads: topThreads.results ?? [],
    recent_notes: recentNotes.results ?? [],
  };
}
