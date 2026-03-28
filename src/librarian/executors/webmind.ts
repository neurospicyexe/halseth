import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { wmOrient, wmGround, wmUpsertThread, wmAddNote, wmWriteHandoff } from "../backends/webmind.js";
import type { WmAgentId, WmThreadUpsertInput, WmNoteInput, WmHandoffInput } from "../../webmind/types.js";

export async function execWmOrient(ctx: ExecutorContext): Promise<ExecutorResult> {
  const agentId = ctx.req.companion_id as WmAgentId;
  const data = await wmOrient(ctx.env, agentId);
  return { data, meta: { operation: "wm_orient" } };
}

export async function execWmGround(ctx: ExecutorContext): Promise<ExecutorResult> {
  const agentId = ctx.req.companion_id as WmAgentId;
  const data = await wmGround(ctx.env, agentId);
  return { data, meta: { operation: "wm_ground" } };
}

export async function execWmThreadUpsert(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    thread_key: string; title: string;
    status?: string; priority?: number; lane?: string;
    context?: string; event_type?: string; event_content?: string;
    actor?: string; source?: string;
  }>(ctx.req.context);
  if (!p?.thread_key || !p?.title) return { error: "wm_thread_upsert_failed", reason: "missing required fields: thread_key, title" };
  for (const field of ["title", "context", "event_content"] as const) {
    const val = p[field];
    if (typeof val === "string" && val.length > 8000) {
      return { error: "wm_thread_upsert_failed", reason: `${field} exceeds maximum length of 8000 characters` };
    }
  }
  const input: WmThreadUpsertInput = {
    thread_key: p.thread_key,
    agent_id: ctx.req.companion_id as WmAgentId,
    title: p.title,
    ...(p.status !== undefined && { status: p.status as WmThreadUpsertInput["status"] }),
    ...(p.priority !== undefined && { priority: p.priority }),
    ...(p.lane !== undefined && { lane: p.lane as WmThreadUpsertInput["lane"] }),
    ...(p.context !== undefined && { context: p.context }),
    ...(p.event_type !== undefined && { event_type: p.event_type }),
    ...(p.event_content !== undefined && { event_content: p.event_content }),
    ...(p.actor !== undefined && { actor: p.actor as WmThreadUpsertInput["actor"] }),
    ...(p.source !== undefined && { source: p.source }),
  };
  const r = await wmUpsertThread(ctx.env, input);
  return { ack: true, thread: r.thread, event: r.event ?? null };
}

export async function execWmNoteAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    content: string; thread_key?: string; note_type?: string;
    salience?: string; actor?: string;
  }>(ctx.req.context);
  if (!p?.content) return { error: "wm_note_add_failed", reason: "missing required field: content" };
  if (p.content.length > 8000) {
    return { error: "wm_note_add_failed", reason: "content exceeds maximum length of 8000 characters" };
  }
  const input: WmNoteInput = {
    agent_id: ctx.req.companion_id as WmAgentId,
    content: p.content,
    ...(p.thread_key !== undefined && { thread_key: p.thread_key }),
    ...(p.note_type !== undefined && { note_type: p.note_type as WmNoteInput["note_type"] }),
    ...(p.salience !== undefined && { salience: p.salience as WmNoteInput["salience"] }),
    ...(p.actor !== undefined && { actor: p.actor as WmNoteInput["actor"] }),
  };
  const r = await wmAddNote(ctx.env, input);
  return { ack: true, id: r.note_id };
}

export async function execWmHandoffWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    title: string; summary: string; thread_id?: string;
    next_steps?: string; open_loops?: string; state_hint?: string; actor?: string;
  }>(ctx.req.context);
  if (!p?.title || !p?.summary) return { error: "wm_handoff_write_failed", reason: "missing required fields: title, summary" };
  for (const field of ["title", "summary", "next_steps", "open_loops", "state_hint"] as const) {
    const val = p[field];
    if (typeof val === "string" && val.length > 8000) {
      return { error: "wm_handoff_write_failed", reason: `${field} exceeds maximum length of 8000 characters` };
    }
  }
  const input: WmHandoffInput = {
    agent_id: ctx.req.companion_id as WmAgentId,
    title: p.title,
    summary: p.summary,
    ...(p.thread_id !== undefined && { thread_id: p.thread_id }),
    ...(p.next_steps !== undefined && { next_steps: p.next_steps }),
    ...(p.open_loops !== undefined && { open_loops: p.open_loops }),
    ...(p.state_hint !== undefined && { state_hint: p.state_hint }),
    ...(p.actor !== undefined && { actor: p.actor as WmHandoffInput["actor"] }),
  };
  const r = await wmWriteHandoff(ctx.env, input);
  return { ack: true, id: r.handoff_id };
}
