// src/webmind/ground.ts
//
// mind_ground: detailed continuity context.
// Retrieval order: open threads (priority desc, last_touched_at desc) -> recent handoffs -> recent notes.

import { Env } from "../types.js";
import { WmAgentId, WmGroundResponse, WmMindThread, WmSessionHandoff, WmContinuityNote } from "./types.js";

export async function mindGround(env: Env, agentId: WmAgentId): Promise<WmGroundResponse> {
  const threads = await env.DB.prepare(
    "SELECT * FROM wm_mind_threads WHERE agent_id = ? AND status = 'open' ORDER BY priority DESC, last_touched_at DESC LIMIT 10"
  ).bind(agentId).all<WmMindThread>();

  const handoffs = await env.DB.prepare(
    "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5"
  ).bind(agentId).all<WmSessionHandoff>();

  const notes = await env.DB.prepare(
    "SELECT * FROM wm_continuity_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10"
  ).bind(agentId).all<WmContinuityNote>();

  return {
    threads: threads.results ?? [],
    recent_handoffs: handoffs.results ?? [],
    recent_notes: notes.results ?? [],
  };
}
