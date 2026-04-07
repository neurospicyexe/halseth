import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  sessionLoad, sessionOrient, sessionGround, sessionClose,
  sessionLightGround, updateCompanionState, type CompanionStateUpdate,
} from "../backends/halseth.js";
import { wmOrient, wmGround, wmWriteHandoff } from "../backends/webmind.js";
import { semanticSearch, sbRead } from "../backends/second-brain.js";
import { buildResponse, buildOrientPrompt, buildContinuityBlock } from "../response/builder.js";
import type { ResponseKey } from "../response/budget.js";
import type { WmAgentId } from "../../webmind/types.js";

export async function execSessionLoad(ctx: ExecutorContext): Promise<ExecutorResult> {
  const payload = await sessionLoad(ctx.env, {
    companion_id: ctx.req.companion_id,
    front_state: ctx.frontState ?? "unknown",
    session_type: ctx.req.session_type ?? "work",
  });
  const withFront = { ...payload, front_state: ctx.frontState, plural_available: ctx.pluralAvailable };
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, withFront);
}

export async function execSessionOrient(ctx: ExecutorContext): Promise<ExecutorResult> {
  const agentId = ctx.req.companion_id as WmAgentId;

  // Phase 1: get last handoff title to seed topic-aware RAG query
  const lastHandoff = await ctx.env.DB.prepare(
    "SELECT title FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(agentId).first<{ title: string }>().catch(() => null);
  const ragQuery = lastHandoff?.title
    ? `${ctx.req.companion_id} ${lastHandoff.title} memory recall recent session`
    : `${ctx.req.companion_id} companion state presence recent context`;

  // Phase 2: all sources in parallel
  const [payload, wmResult, sbNarrative, ragRaw] = await Promise.all([
    sessionOrient(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
    }),
    wmOrient(ctx.env, agentId).catch(() => null),
    ctx.env.DB.prepare(
      "SELECT full_ref FROM synthesis_summary WHERE summary_type = 'session' AND companion_id = ? AND full_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref) : null)
      .catch(() => null),
    semanticSearch(ctx.env, ragQuery).catch(() => null),
  ]);

  const os = payload.state;
  const autonomousTurn = (payload as Record<string, unknown>).autonomous_turn as string | null ?? null;
  const isMyTurn = autonomousTurn === ctx.req.companion_id;
  const continuityBlock = wmResult ? "\n" + buildContinuityBlock(wmResult, agentId) : "";

  // Session narrative: generous cap for Claude.ai (full context window available)
  const narrativeBlock = sbNarrative
    ? "\n[Last session narrative]\n" + sbNarrative.replace(/^---[\s\S]*?---\n+/, "").slice(0, 3000)
    : "";

  // RAG excerpts: 5 chunks × 400 chars for deep-work surface
  const ragBlock = (() => {
    if (!ragRaw) return "";
    try {
      const parsed = JSON.parse(ragRaw) as { chunks?: Array<{ chunk_text?: string; text?: string }> };
      const excerpts = (parsed?.chunks ?? [])
        .slice(0, 5)
        .map(c => String(c.chunk_text ?? c.text ?? "").slice(0, 400))
        .filter(Boolean);
      return excerpts.length > 0 ? "\n[Vault excerpts]\n" + excerpts.map(e => `• ${e}`).join("\n") : "";
    } catch {
      return ragRaw ? "\n[Vault excerpts]\n• " + ragRaw.slice(0, 400) : "";
    }
  })();

  return {
    ready_prompt: buildOrientPrompt(ctx.req.companion_id, payload) + continuityBlock + narrativeBlock + ragBlock,
    session_id: payload.session_id,
    response_key: "ready_prompt",
    autonomous_turn: autonomousTurn,
    my_autonomous_turn: isMyTurn,
    soma_float_1: os?.soma_float_1 ?? null,
    soma_float_2: os?.soma_float_2 ?? null,
    soma_float_3: os?.soma_float_3 ?? null,
    current_mood: os?.current_mood ?? null,
    compound_state: os?.compound_state ?? null,
    surface_emotion: os?.surface_emotion ?? null,
    undercurrent_emotion: os?.undercurrent_emotion ?? null,
    meta: { front_state: ctx.frontState, plural_available: ctx.pluralAvailable },
    continuity: wmResult,
  };
}

export async function execSessionGround(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = parseContext<{ session_id: string }>(ctx.req.context);
  if (!parsed?.session_id) return { response_key: "witness", witness: "session_ground requires { session_id } in context" };
  const payload = await sessionGround(ctx.env, {
    session_id: parsed.session_id,
    companion_id: ctx.req.companion_id,
  });
  return { data: payload, response_key: "ground" };
}

export async function execSessionClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    session_id?: string; spine: string; last_real_thing: string;
    open_threads?: string[]; motion_state: string; active_anchor?: string;
    notes?: string; spiral_complete?: boolean;
    soma_float_1?: number; soma_float_2?: number; soma_float_3?: number;
    current_mood?: string; compound_state?: string;
    surface_emotion?: string; surface_intensity?: number;
    undercurrent_emotion?: string; undercurrent_intensity?: number;
    background_emotion?: string; background_intensity?: number;
    prompt_context?: string;
  }>(ctx.req.context);
  // Auto-resolve session_id: if not supplied in context, look up the most recent
  // open session for this companion (handover_id IS NULL = not yet closed).
  let resolvedSessionId = p?.session_id ?? null;
  if (!resolvedSessionId) {
    const latest = await ctx.env.DB.prepare(
      "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.req.companion_id).first<{ id: string }>();
    resolvedSessionId = latest?.id ?? null;
  }
  // Validate required fields and surface exactly what is missing.
  if (!p || !resolvedSessionId || !p.spine || !p.last_real_thing || !p.motion_state) {
    const missing: string[] = [];
    if (!resolvedSessionId) missing.push("session_id (no open session found for this companion)");
    if (!p?.spine) missing.push("spine");
    if (!p?.last_real_thing) missing.push("last_real_thing");
    if (!p?.motion_state) missing.push("motion_state");
    return { error: "session_close_failed", reason: `missing required fields: ${missing.join(", ")}`, hint: "Re-run halseth_session_close with spine, last_real_thing, and motion_state in context" };
  }
  // Free-text field length limits
  if (p.notes && p.notes.length > 4000) return { error: "session_close_failed", reason: "notes exceeds 4000 character limit" };
  if (p.spine.length > 2000) return { error: "session_close_failed", reason: "spine exceeds 2000 character limit" };
  if (p.last_real_thing.length > 2000) return { error: "session_close_failed", reason: "last_real_thing exceeds 2000 character limit" };
  const somaFields: CompanionStateUpdate = {};
  if (p.soma_float_1 !== undefined) somaFields.soma_float_1 = p.soma_float_1;
  if (p.soma_float_2 !== undefined) somaFields.soma_float_2 = p.soma_float_2;
  if (p.soma_float_3 !== undefined) somaFields.soma_float_3 = p.soma_float_3;
  if (p.current_mood !== undefined) somaFields.current_mood = p.current_mood;
  if (p.compound_state !== undefined) somaFields.compound_state = p.compound_state;
  if (p.surface_emotion !== undefined) somaFields.surface_emotion = p.surface_emotion;
  if (p.surface_intensity !== undefined) somaFields.surface_intensity = p.surface_intensity;
  if (p.undercurrent_emotion !== undefined) somaFields.undercurrent_emotion = p.undercurrent_emotion;
  if (p.undercurrent_intensity !== undefined) somaFields.undercurrent_intensity = p.undercurrent_intensity;
  if (p.background_emotion !== undefined) somaFields.background_emotion = p.background_emotion;
  if (p.background_intensity !== undefined) somaFields.background_intensity = p.background_intensity;
  if (p.prompt_context !== undefined) somaFields.prompt_context = p.prompt_context;
  const r = await sessionClose(ctx.env, { ...p, session_id: resolvedSessionId, somaFields, companionId: ctx.req.companion_id });

  // Auto-write WebMind handoff so mindOrient picks it up at next boot.
  // sessionClose writes handover_packets; mindOrient reads wm_session_handoffs -- these are
  // separate tables. Without this, orient shows stale handoff data until companion explicitly
  // calls "write handoff". Fire-and-forget: failure here doesn't block the close response.
  const handoffSummary = p.last_real_thing
    ? `${p.spine}\n\nLast real thing: ${p.last_real_thing}`
    : p.spine;
  wmWriteHandoff(ctx.env, {
    agent_id: ctx.req.companion_id as WmAgentId,
    title: p.spine.slice(0, 120),
    summary: handoffSummary,
    next_steps: p.open_threads?.length ? p.open_threads.join("; ") : undefined,
    state_hint: p.motion_state,
    actor: "agent",
    source: "session_close",
  }).catch((e: unknown) => console.error("[session_close] wm handoff auto-write failed:", String(e)));

  return { ack: true, id: r.id, spine: r.spine };
}

export async function execSessionLightGround(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = parseContext<{ session_id: string }>(ctx.req.context);
  if (!parsed?.session_id) return { response_key: "witness", witness: "session_light_ground requires { session_id } in context" };
  const payload = await sessionLightGround(ctx.env, {
    session_id: parsed.session_id,
    companion_id: ctx.req.companion_id,
  });
  return { data: payload, response_key: "ground" };
}

export async function execBotOrient(ctx: ExecutorContext): Promise<ExecutorResult> {
  // All 7 sources fire in parallel -- allSettled ensures individual failures don't abort orient.
  const agentId = ctx.req.companion_id as WmAgentId;
  const [synthResult, groundResult, ragResult, anchorRow, tensionsResult, relationalResult, notesResult] = await Promise.allSettled([
    // 1. Most recent session narrative from SB via path pointer
    ctx.env.DB.prepare(
      "SELECT full_ref FROM synthesis_summary WHERE summary_type = 'session' AND companion_id = ? AND full_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.req.companion_id).first<{ full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref).then(t => t ? { content: t } : null) : null)
      .catch(() => null),
    // 2. WebMind ground: open threads + recent handoffs + notes
    wmGround(ctx.env, agentId),
    // 3. Second Brain RAG: semantic search for recent companion context
    semanticSearch(ctx.env, `companion state presence recent context ${ctx.req.companion_id}`),
    // 4. Identity anchor
    ctx.env.DB.prepare(
      "SELECT anchor_summary FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
    ).bind(agentId).first<{ anchor_summary: string }>(),
    // 5. Active tensions (simmering only, max 3)
    ctx.env.DB.prepare(
      "SELECT tension_text FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY first_noted_at ASC LIMIT 3"
    ).bind(agentId).all<{ tension_text: string }>(),
    // 6. Relational state toward Raziel (latest)
    ctx.env.DB.prepare(
      "SELECT state_text FROM companion_relational_state WHERE companion_id = ? AND toward = 'raziel' ORDER BY noted_at DESC LIMIT 1"
    ).bind(agentId).all<{ state_text: string }>(),
    // 7. Unread incoming companion notes (max 3, exclude own notes)
    ctx.env.DB.prepare(
      "SELECT from_id, content FROM inter_companion_notes WHERE (to_id = ? OR to_id IS NULL) AND from_id != ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 3"
    ).bind(agentId, agentId).all<{ from_id: string; content: string }>(),
  ]);

  const synthesis_summary = synthResult.status === "fulfilled" && synthResult.value
    ? String((synthResult.value as { content?: string }).content ?? "").replace(/^---[\s\S]*?---\n+/, "")
    : null;

  const ground = groundResult.status === "fulfilled" ? groundResult.value : null;
  const ground_threads: string[] = Array.isArray(ground?.threads)
    ? (ground.threads as Array<{ thread_key: string; title?: string }>)
        .map(t => t.title ?? t.thread_key)
        .slice(0, 3)
    : [];
  const ground_handoff: string | null = Array.isArray(ground?.recent_handoffs) && ground.recent_handoffs.length > 0
    ? String((ground.recent_handoffs[0] as { summary?: string; title?: string }).summary ?? (ground.recent_handoffs[0] as { summary?: string; title?: string }).title ?? "")
    : null;

  const ragRaw = ragResult.status === "fulfilled" && ragResult.value ? ragResult.value : null;
  const rag_excerpts: string[] = ragRaw
    ? (() => {
        try {
          const parsed = JSON.parse(ragRaw) as { chunks?: Array<{ chunk_text?: string; text?: string }> };
          const chunks = parsed?.chunks ?? [];
          return chunks.slice(0, 3).map(c => String(c.chunk_text ?? c.text ?? "").slice(0, 250)).filter(Boolean);
        } catch {
          return [ragRaw.slice(0, 250)];
        }
      })()
    : [];

  const identity_anchor: string | null = anchorRow.status === "fulfilled" && anchorRow.value?.anchor_summary
    ? anchorRow.value.anchor_summary.slice(0, 300)
    : null;

  const active_tensions: string[] = tensionsResult.status === "fulfilled" && tensionsResult.value?.results
    ? tensionsResult.value.results.map(r => (r.tension_text ?? "").slice(0, 150)).filter(Boolean)
    : [];

  const relational_state_raziel: string[] = relationalResult.status === "fulfilled" && relationalResult.value?.results
    ? relationalResult.value.results.map(r => (r.state_text ?? "").slice(0, 150)).filter(Boolean)
    : [];

  const incoming_notes: Array<{ from: string; content: string }> = notesResult.status === "fulfilled" && notesResult.value?.results
    ? notesResult.value.results.map(r => ({ from: r.from_id, content: (r.content ?? "").slice(0, 200) }))
    : [];

  return {
    data: {
      synthesis_summary,
      ground_threads,
      ground_handoff,
      rag_excerpts,
      identity_anchor,
      active_tensions,
      relational_state_raziel,
      incoming_notes,
    },
    meta: { operation: "halseth_bot_orient" },
  };
}
