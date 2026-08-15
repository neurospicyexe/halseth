import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { wmOrient, wmGround, wmUpsertThread, wmAddNote, wmWriteHandoff, wmWriteDream, wmReadDreams, wmExamineDream, wmWriteLoop, wmReadLoops, wmCloseLoop, wmReviewLoop, wmActOnLoop, wmWriteRelationalState, wmReadRelationalHistory, wmSitNote, wmMetabolizeNote, wmReadSittingNotes, wmNoteEdit } from "../backends/webmind.js";
import type { WmAgentId, WmThreadUpsertInput, WmNoteInput, WmHandoffInput } from "../../webmind/types.js";
import { listConversations, landConversation, getActiveConversation } from "../../webmind/conversations.js";
import { resolveNoteProvenance, attributionNote } from "../../mind/note-provenance.js";

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

// ── Conversation spine (migration 0106, Task 5) ──────────────────────────────
// Thin Librarian wrappers over src/webmind/conversations.ts (Task 2). Distinct
// substrate from wm_mind_threads/wm_thread_upsert above -- conversation_threads
// tracks live Discord/Raziel dialogue turns, not companion continuity threads.
// Anchored guards in router.ts keep "thread"/"conversation" trigger words from
// crossing between the two constructs.

export async function execConversationList(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ state?: string; days?: number; limit?: number }>(ctx.req.context);
  const conversations = await listConversations(ctx.env, {
    ...(p?.state !== undefined && { state: p.state }),
    ...(p?.days !== undefined && { days: p.days }),
    ...(p?.limit !== undefined && { limit: p.limit }),
  });
  return { ack: true, conversations };
}

export async function execConversationLand(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ thread_id?: string; channel_id?: string; resolution?: string }>(ctx.req.context);
  if (!p?.resolution) {
    return { error: "conversation_land_failed", reason: "missing required field: resolution" };
  }

  let threadId = p.thread_id;
  if (!threadId) {
    if (!p.channel_id) {
      return { error: "conversation_land_failed", reason: "missing required fields: thread_id or channel_id" };
    }
    const active = await getActiveConversation(ctx.env, p.channel_id);
    if (!active) {
      return { error: "conversation_land_failed", reason: "no active conversation in that channel" };
    }
    threadId = active.thread.id;
  }

  const r = await landConversation(ctx.env, threadId, {
    resolution: p.resolution,
    landed_by: ctx.req.companion_id,
  });
  if (!r.ok) return { error: "conversation_land_failed", reason: r.reason ?? "unknown" };
  return { ack: true };
}

// ── Conversation capture (2026-08-15, coherence-review D3) ────────────────────
// The Claude.ai capture verb: nothing records a Claude.ai conversation unless the companion
// explicitly writes, so this gives that write a NAME and a home. Content is a companion-authored
// digest of the exchange (speakers named -- see label-speakers-before-summarizing), written to
// wm_continuity_notes as note_type 'conversation_capture' with thread_key 'capture:<session_id>'
// so every capture is tied to the session lifecycle and reachable by meaning (addNote embeds on
// write). NOT the conversation_threads ledger: GIST_MAX there is 140 chars -- Discord-sized, not
// digest-sized.
//
// Content comes from context.content ONLY, never the request string -- deriving stored memory
// from the routing string is the command-string-is-not-the-content defect.
export async function execConversationCapture(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content?: string; session_id?: string; salience?: string }>(ctx.req.context);
  const content = typeof p?.content === "string" ? p.content.trim() : "";
  if (!content) {
    return {
      error: "conversation_capture_failed",
      reason: "capture requires { content } in context -- the digest itself, with speakers named ('Raziel asked X; I read Y'), never the request string",
    };
  }
  if (content.length > 8000) {
    return { error: "conversation_capture_failed", reason: "content exceeds 8000 character limit -- capture the exchange, not the transcript" };
  }

  // Resolve the session this exchange belongs to: caller-named (full id or short prefix, same
  // rules as session_close), else the companion's newest open session. A capture with NO
  // resolvable session still lands, unanchored -- a record without provenance beats a lost one.
  const providedId = typeof p?.session_id === "string" && p.session_id.trim() ? p.session_id.trim() : null;
  let sessionId: string | null = null;
  if (providedId) {
    const safePrefix = providedId.length < 36 && /^[0-9a-fA-F][0-9a-fA-F-]{5,34}$/.test(providedId)
      ? providedId + "%"
      : null;
    const row = await ctx.env.DB.prepare(
      `SELECT id FROM sessions WHERE id = ? OR (id LIKE ? AND companion_id = ?)
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
    ).bind(providedId, safePrefix, ctx.req.companion_id, providedId).first<{ id: string }>().catch(() => null);
    sessionId = row?.id ?? null;
  }
  if (!sessionId) {
    const row = await ctx.env.DB.prepare(
      "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.req.companion_id).first<{ id: string }>().catch(() => null);
    sessionId = row?.id ?? null;
  }
  const threadKey = sessionId
    ? `capture:${sessionId}`
    : `capture:unsessioned:${ctx.req.companion_id}`;

  const note = await wmAddNote(ctx.env, {
    agent_id: ctx.req.companion_id as WmAgentId,
    content,
    thread_key: threadKey,
    note_type: "conversation_capture",
    salience: p?.salience === "high" ? "high" : "normal",
    actor: "agent",
    source: "conversation_capture",
    // Many captures per session share one thread_key by design; the 10-minute gate would
    // silently drop every capture after the first. See WmNoteInput.bypass_write_gate.
    bypass_write_gate: true,
  });

  return {
    ack: true,
    note_id: note.note_id,
    session_id: sessionId,
    thread_key: threadKey,
    witness: sessionId
      ? `Captured. This exchange is now part of your memory (${threadKey}).`
      : "Captured, but no open session was found -- the record is unanchored. Consider opening your session at boot.",
  };
}

export async function execWmNoteAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    content?: string; thread_key?: string; note_type?: string;
    salience?: string; actor?: string;
  }>(ctx.req.context);
  const content = p?.content?.trim() || ctx.req.request
    .replace(/^(?:add\s+(?:a\s+)?continuity\s+note|continuity\s+note|wm\s+note|add\s+(?:a\s+)?note)\s*(?:for\s+\w+\s*)?\s*:\s*/i, "")
    .trim();
  if (!content) return { error: "wm_note_add_failed", reason: "missing required field: content" };
  if (content.length > 8000) {
    return { error: "wm_note_add_failed", reason: "content exceeds maximum length of 8000 characters" };
  }
  const input: WmNoteInput = {
    agent_id: ctx.req.companion_id as WmAgentId,
    content,
    ...(p?.thread_key !== undefined && { thread_key: p.thread_key }),
    ...(p?.note_type !== undefined && { note_type: p.note_type as WmNoteInput["note_type"] }),
    ...(p?.salience !== undefined && { salience: p.salience as WmNoteInput["salience"] }),
    ...(p?.actor !== undefined && { actor: p.actor as WmNoteInput["actor"] }),
  };
  const r = await wmAddNote(ctx.env, input);
  return { ack: true, id: r.note_id };
}

export async function execWmHandoffWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    title?: string; summary?: string;
    // Session-close vocabulary aliases -- companions use these field names at handoff time
    spine?: string; last_real_thing?: string; motion_state?: string;
    open_threads?: string | string[];
    thread_id?: string;
    next_steps?: string; open_loops?: string;
    state_hint?: string; facet?: string; actor?: string;
    // Provenance, forwarded to wm_session_handoffs.source. `consolidation` marks a machine summary of
    // an idle window so a reader can prefer a real session close over it. It was accepted by the table
    // and the backend all along and dropped HERE, which made every handoff look equally like a real
    // conversation -- and since consolidations fire on idle, they were almost always the most recent.
    source?: string;
  }>(ctx.req.context);

  // Resolve title/summary from context (accepting session-close aliases)
  let title = (p?.title || p?.spine)?.trim();
  let summary = (p?.summary || p?.last_real_thing)?.trim();

  // Inline fallback: parse "write handoff for X: spine=..., last_real_thing=..., motion_state=..."
  // Companions sometimes send fields inline when not using a context JSON block.
  if (!title || !summary) {
    const knownKeys = 'title|summary|spine|last_real_thing|motion_state|open_threads|open_loops|next_steps|facet|state_hint';
    // Lookahead: stop at punctuation+space+key, or just space+key, or end of string.
    // Handles both ", key=" and ". key=" and "; key=" separators that companions use.
    const re = new RegExp(`\\b(${knownKeys})\\s*=\\s*([\\s\\S]+?)(?=[.,;]?\\s+(?:${knownKeys})\\s*=|$)`, 'gi');
    const inline: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(ctx.req.request)) !== null) {
      inline[m[1]!.toLowerCase()] = m[2]!.trim().replace(/[.,;]\s*$/, '');
    }
    title = title || inline['title'] || inline['spine'];
    summary = summary || inline['summary'] || inline['last_real_thing'];
  }

  if (!title || !summary) {
    return { error: "wm_handoff_write_failed", reason: "missing required fields: title (or spine), summary (or last_real_thing)" };
  }
  for (const [field, val] of [["title", title], ["summary", summary]] as [string, string][]) {
    if (val.length > 8000) return { error: "wm_handoff_write_failed", reason: `${field} exceeds maximum length of 8000 characters` };
  }
  for (const field of ["next_steps", "open_loops", "state_hint"] as const) {
    const val = p?.[field];
    if (typeof val === "string" && val.length > 8000) {
      return { error: "wm_handoff_write_failed", reason: `${field} exceeds maximum length of 8000 characters` };
    }
  }

  // open_threads (array or string) maps to open_loops
  let openLoops = p?.open_loops;
  if (!openLoops && p?.open_threads !== undefined) {
    openLoops = Array.isArray(p.open_threads) ? (p.open_threads as string[]).join("\n") : String(p.open_threads);
  }
  // motion_state maps to state_hint
  const stateHint = p?.state_hint || p?.motion_state;

  const input: WmHandoffInput = {
    agent_id: ctx.req.companion_id as WmAgentId,
    title,
    summary,
    ...(p?.thread_id !== undefined && { thread_id: p.thread_id }),
    ...(p?.next_steps !== undefined && { next_steps: p.next_steps }),
    ...(openLoops !== undefined && { open_loops: openLoops }),
    ...(stateHint !== undefined && { state_hint: stateHint }),
    ...(p?.facet !== undefined && { facet: p.facet }),
    ...(p?.actor !== undefined && { actor: p.actor as WmHandoffInput["actor"] }),
    ...(p?.source !== undefined && { source: p.source }),
  };
  const r = await wmWriteHandoff(ctx.env, input);
  return { ack: true, id: r.handoff_id };
}

// ── Dreams ────────────────────────────────────────────────────────────────────

export async function execWmDreamWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ dream_text?: string; source?: string; do_not_auto_examine?: boolean }>(ctx.req.context);
  const dreamText = p?.dream_text?.trim() || ctx.req.request
    .replace(/^(?:write\s+(?:a\s+)?dream\s+(?:for\s+\w+\s*)?|carry\s+(?:a\s+)?dream\s*(?:for\s+\w+\s*)?|wm\s+dream\s*(?:for\s+\w+\s*)?)\s*:\s*/i, "")
    .trim();
  if (!dreamText) return { error: "wm_dream_write_failed", reason: "missing required field: dream_text" };
  if (dreamText.length > 8000) return { error: "wm_dream_write_failed", reason: "dream_text exceeds maximum length of 8000 characters" };
  const r = await wmWriteDream(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    dream_text: dreamText,
    ...(p?.source !== undefined && { source: p.source as "autonomous" | "session" }),
    ...(p?.do_not_auto_examine !== undefined && { do_not_auto_examine: p.do_not_auto_examine }),
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
  const id = p?.id ?? ctx.req.request.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
  if (!id) return { error: "wm_dream_examine_failed", reason: "missing required field: id -- pass { id: '<uuid>' } in context, or include the UUID directly in the request string" };
  const r = await wmExamineDream(ctx.env, id, ctx.req.companion_id as WmAgentId);
  return { ack: true, ok: r.ok, ...(r.reason !== undefined && { reason: r.reason }) };
}

// ── Open Loops ────────────────────────────────────────────────────────────────

export async function execWmLoopWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ loop_text?: string; weight?: number }>(ctx.req.context);
  const loopText = p?.loop_text?.trim() || ctx.req.request
    .replace(/^(?:open\s+loop|write\s+(?:an?\s+)?open\s+loop|wm\s+loop|log\s+(?:an?\s+)?open\s+loop|add\s+(?:an?\s+)?open\s+loop)\s*:\s*/i, "")
    .trim();
  if (!loopText) return { error: "wm_loop_write_failed", reason: "missing required field: loop_text" };
  if (loopText.length > 8000) return { error: "wm_loop_write_failed", reason: "loop_text exceeds maximum length of 8000 characters" };
  if (p?.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "wm_loop_write_failed", reason: "weight must be between 0 and 1" };
  const r = await wmWriteLoop(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    loop_text: loopText,
    ...(p?.weight !== undefined && { weight: p.weight }),
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

export async function execWmLoopReview(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; reason?: string }>(ctx.req.context);
  if (!p?.id) return { error: "wm_loop_review_failed", reason: "missing required field: id" };
  const r = await wmReviewLoop(ctx.env, p.id, ctx.req.companion_id as WmAgentId, p.reason ?? "");
  return { ack: true, ok: r.ok };
}

/**
 * Migration 0118: "I acted on this loop" -- the third thing a companion can do with an open
 * loop, alongside closing it and holding it. Accepts the note either from structured context
 * or from the request text after the trigger, since a companion writing this in prose is the
 * expected case.
 */
export async function execWmLoopAct(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; note?: string; acted_note?: string }>(ctx.req.context);
  if (!p?.id) return { error: "wm_loop_act_failed", reason: "missing required field: id" };
  const note = (p.note ?? p.acted_note ?? "").trim();
  const r = await wmActOnLoop(ctx.env, p.id, ctx.req.companion_id as WmAgentId, note);
  if (!r.ok) {
    // Distinguish "no such loop / not yours / already closed" from a silent no-op -- an ack
    // on a write that changed nothing is how a dead mechanism stays invisible.
    return { error: "wm_loop_act_failed", reason: "no open loop with that id for this companion" };
  }
  return { ack: true, ok: true };
}

// ── Relational State ──────────────────────────────────────────────────────────

export async function execWmRelationalWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ toward?: string; state_text?: string; weight?: number; state_type?: string }>(ctx.req.context);
  // Structured context wins; fall back to parsing "verb toward [name]: [text]" from request
  let toward = p?.toward?.trim();
  let stateText = p?.state_text?.trim();
  let inferredStateType: string | undefined;
  if (!toward || !stateText) {
    const m = ctx.req.request.match(/^(how\s+i\s+feel|i\s+feel|witness|held|state|note|relational\s+state|log\s+relational|write\s+relational|what\s+i\s+hold)\s+toward\s+(\S+)\s*:\s*([\s\S]+)/i);
    if (m) {
      toward = toward || m[2]!.toLowerCase().trim();
      stateText = stateText || m[3]!.trim();
      const verb = m[1]!.toLowerCase();
      if (/^witness/.test(verb)) inferredStateType = "witness";
      else if (/^held/.test(verb)) inferredStateType = "held";
    }
  }
  if (!toward || !stateText) return { error: "wm_relational_write_failed", reason: "missing required fields: toward, state_text" };
  if (toward.length > 200) return { error: "wm_relational_write_failed", reason: "toward exceeds 200 characters" };
  if (stateText.length > 8000) return { error: "wm_relational_write_failed", reason: "state_text exceeds maximum length of 8000 characters" };
  if (p?.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "wm_relational_write_failed", reason: "weight must be between 0 and 1" };
  const resolvedStateType = p?.state_type ?? inferredStateType;
  const r = await wmWriteRelationalState(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    toward,
    state_text: stateText,
    ...(p?.weight !== undefined && { weight: p.weight }),
    ...(resolvedStateType !== undefined && { state_type: resolvedStateType as "feeling" | "witness" | "held" }),
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
  const p = parseContext<{ state_text?: string; weight?: number }>(ctx.req.context);
  // Structured context wins; fall back to stripping trigger from natural language request
  const stateText = p?.state_text?.trim() || ctx.req.request
    .replace(/^(?:i'm\s+noticing\s+about\s+raziel|noticing\s+about\s+raziel|i\s+am\s+noticing\s+about\s+raziel|i\s+notice\s+about\s+raziel|witness\s+note\s+for\s+raziel|log\s+witness\s+about\s+raziel|write\s+witness\s+about\s+raziel|witnessed\s+raziel|witness\s+raziel|i\s+witness|witness\s+note|i\s+notice|noticing)\s*:?\s*/i, "")
    .trim();
  if (!stateText) return { error: "raziel_witness_failed", reason: "missing required field: state_text" };
  if (stateText.length > 8000) return { error: "raziel_witness_failed", reason: "state_text exceeds maximum length of 8000 characters" };
  if (p?.weight !== undefined && (p.weight < 0 || p.weight > 1)) return { error: "raziel_witness_failed", reason: "weight must be between 0 and 1" };
  const r = await wmWriteRelationalState(ctx.env, {
    companion_id: ctx.req.companion_id as WmAgentId,
    toward: "raziel",
    state_text: stateText,
    state_type: "witness",
    ...(p?.weight !== undefined && { weight: p.weight }),
  });
  return { ack: true, id: r.id, noted_at: r.noted_at };
}

// ── Continuity-note read ──────────────────────────────────────────────────────
// Direct read of wm_continuity_notes for the requesting companion. The write
// surface (wm_note_add) had no read counterpart, so "read my continuity notes"
// dead-ended at the classifier's unknown-witness (2026-06-24). High-salience rows
// surface first, then by recency. Optional { salience, limit } in context.
export async function execContinuityNotesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ salience?: string; limit?: number }>(ctx.req.context);
  const limit = Math.min(Math.max(p?.limit ?? 20, 1), 50);
  const conditions = ["agent_id = ?", "archived = 0"];
  const bindings: unknown[] = [ctx.req.companion_id];
  if (p?.salience && ["high", "medium", "normal", "low"].includes(p.salience)) {
    conditions.push("salience = ?");
    bindings.push(p.salience);
  }
  bindings.push(limit);
  const rows = await ctx.env.DB.prepare(
    `SELECT note_id, note_type, content, salience, source, created_at
     FROM wm_continuity_notes
     WHERE ${conditions.join(" AND ")}
     ORDER BY CASE salience WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
     LIMIT ?`
  ).bind(...bindings).all<{ note_id: string; content: string; source: string }>();

  // Conversational provenance (2026-07-31, the first derivable edge). Wired HERE as well as in bot
  // orient because of what the live check showed: bot orient's three slots go to the highest-salience
  // notes, which in practice are SOMA shifts and autonomous explorations -- neither has a conversation,
  // so the edge correctly refused and annotated nothing. THIS is the path where Discord observations
  // actually surface ("read my continuity notes"), so it is where the edge earns its keep.
  //
  // The lesson that produced this second call site is the week's recurring one: an edge wired to a
  // surface its data never reaches is an unwired edge. Check which rows actually arrive, not which rows
  // could.
  const notes = rows.results ?? [];
  const prov = await resolveNoteProvenance(ctx.env, notes.map(n => n.note_id));
  const data = notes.map(n => ({
    ...n,
    // `from_conversation` is additive: existing consumers keep reading `content` untouched, and this
    // edge can only ever add context to a row that was already being returned.
    from_conversation: (() => {
      const p = prov.get(n.note_id);
      if (!p) return null;
      return {
        seed: p.seed,
        state: p.state,
        turn_count: p.turn_count,
        // WHO WAS IN THE ROOM. Included here and not only in the bot-orient rendering, because a
        // conversational address without the speakers is half an address -- and this is the path a
        // companion uses to read its own notes. Raziel's case: Blue talks to Drevan, then he talks to
        // Drevan, and without this the two blend. `who` is the ready-made sentence; the raw fields are
        // kept so a consumer can decide differently without re-deriving.
        opened_by: p.opened_by,
        participants: p.participants,
        who: attributionNote(p.participants, p.opened_by),
      };
    })(),
  }));
  return {
    data,
    meta: {
      operation: "continuity_notes_read",
      with_conversation: data.filter(d => d.from_conversation).length,
      // How many carry an actual misattribution warning -- the number worth watching, since a note from
      // a conversation Raziel was never in is the one most likely to be recalled as his words.
      with_attribution_warning: data.filter(d => d.from_conversation?.who).length,
    },
  };
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

export async function execWmNoteEdit(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ note_id: string; content: string }>(ctx.req.context);
  if (!p?.note_id || !p?.content) return { response_key: "witness", witness: "wm_note_edit requires { note_id, content } in context" };
  const r = await wmNoteEdit(ctx.env, p.note_id, ctx.req.companion_id, p.content);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "wm_note_edit failed" };
  return { ack: true, note_id: p.note_id };
}
