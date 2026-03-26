// src/webmind/threads.ts
//
// Mind thread operations: list and upsert.
// Upsert creates a thread_event alongside the thread mutation when event_type is provided.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import {
  WmAgentId, WmMindThread, WmThreadEvent,
  WmThreadUpsertInput, WmThreadStatus,
} from "./types.js";

export async function listThreads(
  env: Env, agentId: WmAgentId, status: WmThreadStatus = "open", limit = 20,
): Promise<WmMindThread[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM wm_mind_threads WHERE agent_id = ? AND status = ? ORDER BY priority DESC, last_touched_at DESC LIMIT ?"
  ).bind(agentId, status, limit).all<WmMindThread>();
  return r.results ?? [];
}

export async function upsertThread(
  env: Env, input: WmThreadUpsertInput,
): Promise<{ thread: WmMindThread; event: WmThreadEvent | null }> {
  const now = new Date().toISOString();
  const status = input.status ?? "open";
  const priority = input.priority ?? 0;

  await env.DB.prepare(`
    INSERT INTO wm_mind_threads (thread_key, agent_id, title, status, priority, lane, context, do_not_archive, do_not_resolve, actor, source, correlation_id, last_touched_at, updated_at, status_changed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_key, agent_id) DO UPDATE SET
      title = excluded.title,
      status = CASE WHEN excluded.status != wm_mind_threads.status THEN excluded.status ELSE wm_mind_threads.status END,
      priority = excluded.priority,
      lane = COALESCE(excluded.lane, wm_mind_threads.lane),
      context = COALESCE(excluded.context, wm_mind_threads.context),
      do_not_archive = excluded.do_not_archive,
      do_not_resolve = excluded.do_not_resolve,
      actor = excluded.actor,
      source = excluded.source,
      correlation_id = excluded.correlation_id,
      last_touched_at = excluded.last_touched_at,
      updated_at = excluded.updated_at,
      status_changed = CASE WHEN excluded.status != wm_mind_threads.status THEN excluded.last_touched_at ELSE wm_mind_threads.status_changed END
  `).bind(
    input.thread_key, input.agent_id, input.title,
    status, priority,
    input.lane ?? null, input.context ?? null,
    input.do_not_archive ? 1 : 0,
    input.do_not_resolve ? 1 : 0,
    input.actor ?? "agent", input.source ?? "system",
    input.correlation_id ?? null,
    now, now,
    status !== "open" ? now : null, now,
  ).run();

  let event: WmThreadEvent | null = null;
  if (input.event_type) {
    const eventId = generateId();
    await env.DB.prepare(`
      INSERT INTO wm_thread_events (event_id, thread_key, agent_id, event_type, content, actor, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId, input.thread_key, input.agent_id,
      input.event_type, input.event_content ?? null,
      input.actor ?? "agent", input.source ?? "system",
      input.correlation_id ?? null, now,
    ).run();
    event = {
      event_id: eventId,
      thread_key: input.thread_key,
      agent_id: input.agent_id,
      event_type: input.event_type,
      content: input.event_content ?? null,
      actor: (input.actor ?? "agent") as "agent",
      source: input.source ?? "system",
      correlation_id: input.correlation_id ?? null,
      created_at: now,
    };
  }

  const thread = await env.DB.prepare(
    "SELECT * FROM wm_mind_threads WHERE thread_key = ? AND agent_id = ?"
  ).bind(input.thread_key, input.agent_id).first<WmMindThread>();

  return { thread: thread!, event };
}
