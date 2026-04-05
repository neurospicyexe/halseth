import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  sessionLoad, sessionOrient, sessionGround, sessionClose,
  sessionLightGround, updateCompanionState, type CompanionStateUpdate,
} from "../backends/halseth.js";
import { wmOrient, wmGround, wmWriteHandoff } from "../backends/webmind.js";
import { semanticSearch } from "../backends/second-brain.js";
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
  const [payload, wmResult] = await Promise.all([
    sessionOrient(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
    }),
    wmOrient(ctx.env, agentId).catch(() => null),
  ]);
  const os = payload.state;
  const autonomousTurn = (payload as Record<string, unknown>).autonomous_turn as string | null ?? null;
  const isMyTurn = autonomousTurn === ctx.req.companion_id;
  const continuityBlock = wmResult ? "\n" + buildContinuityBlock(wmResult) : "";
  return {
    ready_prompt: buildOrientPrompt(ctx.req.companion_id, payload) + continuityBlock,
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
  // Aggregate three sources in parallel: synthesis summary, WebMind ground, RAG excerpts.
  const agentId = ctx.req.companion_id as WmAgentId;
  const [synthResult, groundResult, ragResult] = await Promise.allSettled([
    // Most recent synthesis summary for this companion
    ctx.env.DB.prepare(
      `SELECT content FROM synthesis_summary WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(ctx.req.companion_id).first<{ content: string }>(),
    // WebMind ground: open threads + recent handoffs + notes
    wmGround(ctx.env, agentId),
    // Second Brain RAG: semantic search for recent companion context
    semanticSearch(ctx.env, `companion state presence recent context ${ctx.req.companion_id}`),
  ]);

  const synthesis_summary = synthResult.status === "fulfilled" && synthResult.value
    ? String(synthResult.value.content ?? "")
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
          return chunks.slice(0, 2).map(c => String(c.chunk_text ?? c.text ?? "").slice(0, 120)).filter(Boolean);
        } catch {
          return [ragRaw.slice(0, 120)];
        }
      })()
    : [];

  return {
    data: { synthesis_summary, ground_threads, ground_handoff, rag_excerpts },
    meta: { operation: "halseth_bot_orient" },
  };
}
