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

  const threadStmt = env.DB.prepare(`
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
  );

  let event: WmThreadEvent | null = null;
  const stmts: Parameters<typeof env.DB.batch>[0] = [threadStmt];

  if (input.event_type) {
    const eventId = generateId();
    const eventStmt = env.DB.prepare(`
      INSERT INTO wm_thread_events (event_id, thread_key, agent_id, event_type, content, actor, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId, input.thread_key, input.agent_id,
      input.event_type, input.event_content ?? null,
      input.actor ?? "agent", input.source ?? "system",
      input.correlation_id ?? null, now,
    );
    stmts.push(eventStmt);
    event = {
      event_id: eventId,
      thread_key: input.thread_key,
      agent_id: input.agent_id,
      event_type: input.event_type,
      content: input.event_content ?? null,
      actor: input.actor ?? "agent",
      source: input.source ?? "system",
      correlation_id: input.correlation_id ?? null,
      created_at: now,
    };
  }

  await env.DB.batch(stmts);

  const thread = await env.DB.prepare(
    "SELECT * FROM wm_mind_threads WHERE thread_key = ? AND agent_id = ?"
  ).bind(input.thread_key, input.agent_id).first<WmMindThread>();

  if (!thread) {
    throw new Error(`upsertThread: thread not found after insert: ${input.thread_key}`);
  }

  return { thread, event };
}

// Bulk-resolve open threads that will never be revisited. Two modes, combinable:
//   prefix + olderThanDays -- stale machine-opened threads (the autonomous worker
//     opens `auto:<runId>` per run and its conclude path rarely fires, so they
//     accumulate: ~220 open per companion by 2026-07-02).
//   invalidKeys -- threads whose key is over the 64-char cap (model prose written
//     as a key before postMindThread validated shape).
// Respects do_not_resolve. datetime() normalizes the two timestamp formats that
// coexist in last_touched_at ('YYYY-MM-DD HH:MM:SS' and ISO-8601).
export async function sweepThreads(
  env: Env,
  input: { agent_id: WmAgentId; older_than_days?: number; prefix?: string; invalid_keys?: boolean },
): Promise<{ swept: number }> {
  const days = Math.min(365, Math.max(1, Math.round(input.older_than_days ?? 14)));
  const prefix = input.prefix ?? "auto:";
  const now = new Date().toISOString();

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (prefix) {
    // ESCAPE so a literal '%'/'_' in the prefix can't widen the match.
    conditions.push(`(thread_key LIKE ? ESCAPE '\\' AND datetime(last_touched_at) < datetime('now', ?))`);
    bindings.push(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%", `-${days} days`);
  }
  if (input.invalid_keys) {
    conditions.push("length(thread_key) > 64");
  }
  if (conditions.length === 0) return { swept: 0 };

  const res = await env.DB.prepare(`
    UPDATE wm_mind_threads
    SET status = 'resolved', status_changed = ?, updated_at = ?
    WHERE agent_id = ? AND status = 'open' AND do_not_resolve = 0
      AND (${conditions.join(" OR ")})
  `).bind(now, now, input.agent_id, ...bindings).run();

  return { swept: res.meta?.changes ?? 0 };
}
