// src/webmind/handoffs.ts
//
// Session handoff operations: write (append-only) and read (list recent).

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmAgentId, WmSessionHandoff, WmHandoffInput } from "./types.js";

export async function writeHandoff(env: Env, input: WmHandoffInput): Promise<WmSessionHandoff> {
  const id = generateId();
  const now = new Date().toISOString();

  // Batch: INSERT then write-time cap. Cap runs after insert so the new row is included
  // in the "keep" set. idx_wm_handoffs_agent(agent_id, created_at DESC) makes the subquery
  // an index scan. Orient reads LIMIT 5, ground reads LIMIT 5 -- 30 is a 6x buffer.
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO wm_session_handoffs (handoff_id, agent_id, thread_id, title, summary, next_steps, open_loops, state_hint, actor, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, input.agent_id, input.thread_id ?? null,
      input.title, input.summary,
      input.next_steps ?? null, input.open_loops ?? null,
      input.state_hint ?? null,
      input.actor ?? "agent", input.source ?? "system",
      input.correlation_id ?? null, now,
    ),
    env.DB.prepare(`
      DELETE FROM wm_session_handoffs
      WHERE agent_id = ? AND handoff_id NOT IN (
        SELECT handoff_id FROM wm_session_handoffs
        WHERE agent_id = ? ORDER BY created_at DESC LIMIT 30
      )
    `).bind(input.agent_id, input.agent_id),
  ]);

  return {
    handoff_id: id,
    agent_id: input.agent_id,
    thread_id: input.thread_id ?? null,
    title: input.title,
    summary: input.summary,
    next_steps: input.next_steps ?? null,
    open_loops: input.open_loops ?? null,
    state_hint: input.state_hint ?? null,
    actor: input.actor ?? "agent",
    source: input.source ?? "system",
    correlation_id: input.correlation_id ?? null,
    created_at: now,
  };
}

export async function readHandoffs(env: Env, agentId: WmAgentId, limit = 5): Promise<WmSessionHandoff[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(agentId, limit).all<WmSessionHandoff>();
  return r.results ?? [];
}
