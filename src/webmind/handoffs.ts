// src/webmind/handoffs.ts
//
// Session handoff operations: write (append-only) and read (list recent).

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmAgentId, WmSessionHandoff, WmHandoffInput } from "./types.js";

export async function writeHandoff(env: Env, input: WmHandoffInput): Promise<WmSessionHandoff> {
  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO wm_session_handoffs (handoff_id, agent_id, thread_id, title, summary, next_steps, open_loops, state_hint, actor, source, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, input.agent_id, input.thread_id ?? null,
    input.title, input.summary,
    input.next_steps ?? null, input.open_loops ?? null,
    input.state_hint ?? null,
    input.actor ?? "agent", input.source ?? "system",
    input.correlation_id ?? null, now,
  ).run();

  return {
    handoff_id: id,
    agent_id: input.agent_id,
    thread_id: input.thread_id ?? null,
    title: input.title,
    summary: input.summary,
    next_steps: input.next_steps ?? null,
    open_loops: input.open_loops ?? null,
    state_hint: input.state_hint ?? null,
    actor: (input.actor ?? "agent") as "agent",
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
