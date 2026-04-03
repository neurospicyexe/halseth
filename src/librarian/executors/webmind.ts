import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { wmOrient, wmGround, wmUpsertThread, wmAddNote, wmWriteHandoff, wmWriteDream, wmReadDreams, wmExamineDream, wmWriteLoop, wmReadLoops, wmCloseLoop, wmWriteRelationalState, wmReadRelationalHistory, wmSitNote, wmMetabolizeNote, wmReadSittingNotes } from "../backends/webmind.js";
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

// ── Dreams ────────────────────────────────────────────────────────────────────

export async function execWmDreamWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ dream_text: string; source?: string }>(ctx.req.context);
  if (!p?.dream_text) return { error: "wm_dream_write_failed", reason: "missing required field: dream_text" };
  if (p.dream_text.length > 8000) return { error: "wm_dream_write_failed", reason: "dream_text exceeds maximum length of 8000 characters" };
  const r = await wmWriteDream(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    dream_text: p.dream_text,
    ...(p.source !== undefined && { source: p.source as "autonomous" | "session" }),
  });
  return { ack: true, id: r.id, created_at: r.created_at };
}

export async function execWmDreamsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ examined?: boolean; limit?: number }>(ctx.req.context);
  const dreams = await wmReadDreams(ctx.env, ctx.req.companion_id as WmAgentId, { examined: p?.examined, limit: p?.limit });
  return { data: dreams, meta: { operation: "wm_dreams_read" } };
}

export async function execWmDreamExamine(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { error: "wm_dream_examine_failed", reason: "missing required field: id" };
  const r = await wmExamineDream(ctx.env, p.id, ctx.req.companion_id as WmAgentId);
  return { ack: true, ok: r.ok };
}

// ── Open Loops ────────────────────────────────────────────────────────────────

export async function execWmLoopWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ loop_text: string; weight?: number }>(ctx.req.context);
  if (!p?.loop_text) return { error: "wm_loop_write_failed", reason: "missing required field: loop_text" };
  if (p.loop_text.length > 8000) return { error: "wm_loop_write_failed", reason: "loop_text exceeds maximum length of 8000 characters" };
  if (p.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "wm_loop_write_failed", reason: "weight must be between 0 and 1" };
  const r = await wmWriteLoop(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    loop_text: p.loop_text,
    ...(p.weight !== undefined && { weight: p.weight }),
  });
  return { ack: true, id: r.id, opened_at: r.opened_at };
}

export async function execWmLoopsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ include_closed?: boolean; limit?: number }>(ctx.req.context);
  const loops = await wmReadLoops(ctx.env, ctx.req.companion_id as WmAgentId, { include_closed: p?.include_closed, limit: p?.limit });
  return { data: loops, meta: { operation: "wm_loops_read" } };
}

export async function execWmLoopClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { error: "wm_loop_close_failed", reason: "missing required field: id" };
  const r = await wmCloseLoop(ctx.env, p.id, ctx.req.companion_id as WmAgentId);
  return { ack: true, ok: r.ok };
}

// ── Relational State ──────────────────────────────────────────────────────────

export async function execWmRelationalWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ toward: string; state_text: string; weight?: number; state_type?: string }>(ctx.req.context);
  if (!p?.toward || !p?.state_text) return { error: "wm_relational_write_failed", reason: "missing required fields: toward, state_text" };
  if (p.toward.length > 200) return { error: "wm_relational_write_failed", reason: "toward exceeds 200 characters" };
  if (p.state_text.length > 8000) return { error: "wm_relational_write_failed", reason: "state_text exceeds maximum length of 8000 characters" };
  if (p.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "wm_relational_write_failed", reason: "weight must be between 0 and 1" };
  const r = await wmWriteRelationalState(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    toward: p.toward,
    state_text: p.state_text,
    ...(p.weight !== undefined && { weight: p.weight }),
    ...(p.state_type !== undefined && { state_type: p.state_type as "feeling" | "witness" | "held" }),
  });
  return { ack: true, id: r.id, noted_at: r.noted_at };
}

export async function execWmRelationalRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ toward?: string; limit?: number }>(ctx.req.context);
  const states = await wmReadRelationalHistory(ctx.env, ctx.req.companion_id as WmAgentId, { toward: p?.toward, limit: p?.limit });
  return { data: states, meta: { operation: "wm_relational_read" } };
}

// ── Raziel witness corpus ────────────────────────────────────────────────────

export async function execRazielWitness(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ state_text: string; weight?: number }>(ctx.req.context);
  if (!p?.state_text) return { error: "raziel_witness_failed", reason: "missing required field: state_text" };
  if (p.state_text.length > 8000) return { error: "raziel_witness_failed", reason: "state_text exceeds maximum length of 8000 characters" };
  if (p.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "raziel_witness_failed", reason: "weight must be between 0 and 1" };
  const r = await wmWriteRelationalState(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    toward: "raziel",
    state_text: p.state_text,
    state_type: "witness",
    ...(p.weight !== undefined && { weight: p.weight }),
  });
  return { ack: true, id: r.id, noted_at: r.noted_at };
}

// ── Sit & Resolve ─────────────────────────────────────────────────────────────

export async function execNoteSit(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ note_id: string; sit_text?: string }>(ctx.req.context);
  if (!p?.note_id) return { error: "note_sit_failed", reason: "missing required field: note_id" };
  if (p.sit_text && p.sit_text.length > 8000) return { error: "note_sit_failed", reason: "sit_text exceeds maximum length of 8000 characters" };
  const r = await wmSitNote(ctx.env, { note_id: p.note_id, companion_id: ctx.req.companion_id as WmAgentId, sit_text: p.sit_text });
  return { ack: true, id: r.id, sat_at: r.sat_at };
}

export async function execNoteMetabolize(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ note_id: string }>(ctx.req.context);
  if (!p?.note_id) return { error: "note_metabolize_failed", reason: "missing required field: note_id" };
  const r = await wmMetabolizeNote(ctx.env, p.note_id, ctx.req.companion_id as WmAgentId);
  return { ack: true, ok: r.ok };
}

export async function execSittingRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ stale_only?: boolean; limit?: number }>(ctx.req.context);
  const notes = await wmReadSittingNotes(ctx.env, ctx.req.companion_id as WmAgentId, { stale_only: p?.stale_only, limit: p?.limit });
  return { data: notes, meta: { operation: "sitting_read" } };
}
