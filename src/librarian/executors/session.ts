import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { enqueueBasinDriftCheck, enqueueSomaticSnapshot } from "../../synthesis/index.js";
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
  const siblings = (["cypher", "drevan", "gaia"] as const).filter(c => c !== agentId);

  // Phase 1: gather topic seeds from sources that exist independently of session-close discipline.
  // spine is required by session_close (most reliable); continuity_notes accumulate mid-session.
  // Both survive sloppy close rituals where wm_session_handoffs may be empty.
  const [lastSpine, lastNote] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT spine FROM sessions WHERE companion_id = ? AND spine IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ spine: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT content FROM wm_continuity_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ content: string }>().catch(() => null),
  ]);
  const topicSeed = [lastSpine?.spine, lastNote?.content].filter(Boolean).join(" ").slice(0, 200);
  const ragQuery = topicSeed
    ? `${ctx.req.companion_id} ${topicSeed}`
    : `${ctx.req.companion_id} companion state presence recent context`;

  // Phase 2: all sources in parallel -- sibling lane queries use idx_sessions_companion_created,
  // each returning LIMIT 1 (one index entry + one rowid lookup per sibling).
  const [payload, wmResult, sbNarrative, ragRaw, sib0Row, sib1Row, growthJournal, growthPatterns, lastReflection, availableSeeds] = await Promise.all([
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
    // Sibling lane: PK lookup on companion_state -- no heap scan, no index needed.
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(siblings[0]).first<{ motion_state: string; lane_spine: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(siblings[1]).first<{ motion_state: string; lane_spine: string }>().catch(() => null),
    // Growth: last 3 journal entries from autonomous work
    ctx.env.DB.prepare(
      "SELECT entry_type, content, created_at FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<{ entry_type: string; content: string; created_at: string }>().catch(() => null),
    // Growth: top 2 patterns by strength
    ctx.env.DB.prepare(
      "SELECT pattern_text, strength FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ pattern_text: string; strength: number }>().catch(() => null),
    // Growth: most recent reflection
    ctx.env.DB.prepare(
      "SELECT reflection_text, created_at FROM autonomy_reflections WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ reflection_text: string; created_at: string }>().catch(() => null),
    // Growth: top available seeds (unused, priority desc) -- so companions know what's queued
    ctx.env.DB.prepare(
      "SELECT seed_type, content, priority FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at ASC LIMIT 3"
    ).bind(agentId).all<{ seed_type: string; content: string; priority: number }>().catch(() => null),
  ]);

  const os = payload.state;
  const autonomousTurn = (payload as Record<string, unknown>).autonomous_turn as string | null ?? null;
  const isMyTurn = autonomousTurn === ctx.req.companion_id;
  const continuityBlock = wmResult ? "\n" + buildContinuityBlock(wmResult, agentId) : "";

  // Session narrative: generous cap for Claude.ai (full context window available)
  const narrativeBlock = sbNarrative
    ? "\n[Last session narrative]\n" + sbNarrative.replace(/^---[\s\S]*?---\n+/, "").slice(0, 3000)
    : "";

  // Sibling lane block: spine + motion_state for each sibling companion so self can stay in lane.
  const siblingRows = [sib0Row, sib1Row];
  const siblingBlock = siblings.some((_, i) => siblingRows[i]?.lane_spine)
    ? "\n[Sibling lanes]\n" + siblings.map((id, i) => {
        const row = siblingRows[i];
        return row?.lane_spine ? `${id}: ${row.motion_state ?? "unknown"} -- ${row.lane_spine}` : null;
      }).filter(Boolean).join("\n")
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

  // Growth block: autonomous journal + patterns + last reflection.
  // Only rendered when data exists -- no block for companions with no autonomous history yet.
  const growthParts: string[] = [];
  const journalRows = growthJournal?.results ?? [];
  if (journalRows.length > 0) {
    growthParts.push(`[Autonomous growth: ${journalRows.length} recent entries]`);
    for (const j of journalRows) {
      const snippet = j.content.length > 200 ? j.content.slice(0, 200) + "…" : j.content;
      growthParts.push(`  • [${j.entry_type} @ ${j.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }
  const patternRows = growthPatterns?.results ?? [];
  if (patternRows.length > 0) {
    growthParts.push(`[Recognized patterns: ${patternRows.length}]`);
    for (const p of patternRows) {
      const snippet = p.pattern_text.length > 150 ? p.pattern_text.slice(0, 150) + "…" : p.pattern_text;
      growthParts.push(`  • (strength ${p.strength}) «${snippet}»`);
    }
  }
  if (lastReflection) {
    const snippet = lastReflection.reflection_text.length > 200
      ? lastReflection.reflection_text.slice(0, 200) + "…"
      : lastReflection.reflection_text;
    growthParts.push(`[Last reflection @ ${lastReflection.created_at.slice(0, 10)}] «${snippet}»`);
  }
  const seedRows = availableSeeds?.results ?? [];
  if (seedRows.length > 0) {
    growthParts.push(`[Queued seeds: ${seedRows.length} available]`);
    for (const s of seedRows) {
      const snippet = s.content.length > 150 ? s.content.slice(0, 150) + "…" : s.content;
      growthParts.push(`  • [${s.seed_type} p${s.priority}] «${snippet}»`);
    }
  }
  const growthBlock = growthParts.length > 0 ? "\n" + growthParts.join("\n") : "";

  const ragHitCount = (() => {
    try { return (JSON.parse(ragRaw ?? "{}") as { chunks?: unknown[] })?.chunks?.length ?? 0; }
    catch { return ragRaw ? 1 : 0; }
  })();

  const debugSnapshot = {
    assembled_at: new Date().toISOString(),
    session_id: payload.session_id,
    front_state: ctx.frontState ?? "unknown",
    wm: wmResult ? {
      recent_notes:              wmResult.recent_notes.length,
      open_thread_count:         wmResult.open_thread_count,
      active_tensions:           wmResult.active_tensions.length,
      active_conclusions:        wmResult.active_conclusions.length,
      incoming_companion_notes:  wmResult.incoming_companion_notes.length,
      latest_handoff_summary:    wmResult.latest_handoff?.summary?.slice(0, 100) ?? null,
    } : null,
    sb_rag: { query: ragQuery.slice(0, 150), hit_count: ragHitCount },
    sb_narrative: sbNarrative ? "loaded" : "none",
    growth: {
      journal_entries: journalRows.length,
      patterns:        patternRows.length,
      last_reflection: lastReflection ? 1 : 0,
      available_seeds: seedRows.length,
    },
  };
  await ctx.env.DB.prepare(
    `INSERT INTO companion_state (companion_id, last_orient_debug, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(companion_id) DO UPDATE SET
       last_orient_debug = excluded.last_orient_debug,
       updated_at        = datetime('now')`
  ).bind(agentId, JSON.stringify(debugSnapshot)).run().catch(() => null);

  ctx.env.DB.prepare(
    `INSERT INTO sb_search_log (id, companion_id, query, hit_count, source) VALUES (?, ?, ?, ?, 'orient')`
  ).bind(crypto.randomUUID(), agentId, ragQuery.slice(0, 200), ragHitCount).run().catch(() => null);

  return {
    ready_prompt: buildOrientPrompt(ctx.req.companion_id, payload) + continuityBlock + narrativeBlock + ragBlock + siblingBlock + growthBlock,
    session_id: payload.session_id,
    response_key: "ready_prompt",
    autonomous_turn: autonomousTurn,
    my_autonomous_turn: isMyTurn,
    // Drevan uses TEXT SOMA columns; Cypher/Gaia use floats
    ...(agentId === 'drevan'
      ? { heat: os?.heat ?? null, reach: os?.reach ?? null, weight: os?.weight ?? null }
      : { soma_float_1: os?.soma_float_1 ?? null, soma_float_2: os?.soma_float_2 ?? null, soma_float_3: os?.soma_float_3 ?? null }
    ),
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
    notes?: string; spiral_complete?: boolean; facet?: string;
    soma_float_1?: number; soma_float_2?: number; soma_float_3?: number;
    current_mood?: string; compound_state?: string | null;
    surface_emotion?: string; surface_intensity?: number;
    undercurrent_emotion?: string; undercurrent_intensity?: number;
    background_emotion?: string; background_intensity?: number;
    prompt_context?: string;
    // Set to true on re-submission after emotion prompt -- skips the soft prompt check.
    emotion_prompted?: boolean;
    // Fan-out fields: written in one call at close instead of requiring separate surface calls
    feeling?: { emotion: string; sub_emotion?: string; intensity?: number };
    witness_note?: string;
    conclusion?: string;
    dream?: string;
    open_loop?: { loop_text: string; weight?: number };
  }>(ctx.req.context);
  // Auto-resolve session_id: if not supplied in context, look up the most recent
  // open session for this companion (handover_id IS NULL = not yet closed).
  // Auto-resolve session_id in a single query: try exact match first (order 0),
  // fall back to latest open session for this companion (order 1). When p.session_id
  // is null, SQL evaluates `id = NULL` as false so only the open-session branch matches --
  // same result as before, one round-trip instead of up to two.
  const providedId = p?.session_id ?? null;
  const sessionRow = await ctx.env.DB.prepare(
    `SELECT id FROM sessions
     WHERE (id = ? OR (companion_id = ? AND handover_id IS NULL))
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`
  ).bind(providedId, ctx.req.companion_id, providedId).first<{ id: string }>();
  let resolvedSessionId: string | null = sessionRow?.id ?? null;
  // Fallback fired when a session_id was provided but wasn't found (pruned or stale).
  const sessionIdFallback = providedId !== null && resolvedSessionId !== providedId;
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

  // Soft emotion prompt: fires once on first close call when any of the four fields are absent.
  // emotion_prompted: true on the re-submission bypasses this check -- no loop, no second prompt.
  if (!p.emotion_prompted) {
    // compound_state may be explicitly null ("no compound state present") -- that is valid.
    // Only treat it as missing if the key is absent from the parsed context entirely.
    const missingAny = p.current_mood == null || p.compound_state === undefined
      || p.surface_emotion == null || p.undercurrent_emotion == null;
    if (missingAny) {
      return {
        status: "needs_emotion_fields",
        message: "Before closing: what's the emotional state right now?",
        prompts: {
          current_mood: "Current mood (one word or phrase -- 'unsettled', 'quiet', 'warm', 'held' all count):",
          compound_state: "Compound state if present (e.g. 'strained but grounded', or null if genuinely absent):",
          surface_emotion: "Surface emotion (what's on top right now):",
          undercurrent_emotion: "Undercurrent (what's running underneath, if anything):",
        },
        hint: "Single words accepted. 'I don't know' is valid. Null is only valid if you've looked and there's genuinely nothing.",
      };
    }
  }
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
  // Lane signal: always written so sibling orient queries read companion_state PK,
  // not the sessions heap. lane_spine is capped at 150 chars -- enough for lane awareness.
  somaFields.motion_state = p.motion_state;
  somaFields.lane_spine = p.spine.slice(0, 150);
  const r = await sessionClose(ctx.env, { ...p, session_id: resolvedSessionId, somaFields, companionId: ctx.req.companion_id });

  // Auto-write WebMind handoff so mindOrient picks it up at next boot.
  // sessionClose writes handover_packets; mindOrient reads wm_session_handoffs -- these are
  // separate tables. Without this, orient shows stale handoff data until companion explicitly
  // calls "write handoff". Awaited so failures surface in the response instead of vanishing.
  const handoffSummary = p.last_real_thing
    ? `${p.spine}\n\nLast real thing: ${p.last_real_thing}`
    : p.spine;
  let handoff_warning: string | undefined;
  const handoffPayload = {
    agent_id: ctx.req.companion_id as WmAgentId,
    title: p.spine.slice(0, 120),
    summary: handoffSummary,
    next_steps: p.open_threads?.length ? p.open_threads.join("; ") : undefined,
    state_hint: p.motion_state,
    facet: p.facet ?? undefined,
    actor: "agent" as const,
    source: "session_close" as const,
  };
  try {
    await wmWriteHandoff(ctx.env, handoffPayload);
  } catch (e: unknown) {
    // One retry after 200ms -- D1 transient errors are the common failure mode here.
    try {
      await new Promise<void>(res => setTimeout(res, 200));
      await wmWriteHandoff(ctx.env, handoffPayload);
    } catch (e2: unknown) {
      handoff_warning = "wm handoff write failed — next orient may see stale continuity";
      console.error("[session_close] wm handoff auto-write failed after retry:", String(e2));
    }
  }

  // Await the somatic snapshot enqueue -- SOMA state is continuity-critical.
  // Same pattern as drift check: surface failure in the response rather than silently losing the job.
  let somatic_warning: string | undefined;
  try {
    await enqueueSomaticSnapshot(ctx.req.companion_id, ctx.env);
  } catch (e: unknown) {
    somatic_warning = "somatic_snapshot enqueue failed — SOMA state may not sync until next session close";
    console.error("[session_close] somatic_snapshot enqueue failed:", String(e));
  }

  // Await the drift check enqueue so failures surface in the response payload.
  // Non-fatal: a failed enqueue sets drift_warning; session close continues regardless.
  let drift_warning: string | undefined;
  try {
    await enqueueBasinDriftCheck(ctx.req.companion_id, resolvedSessionId, ctx.env);
  } catch (e: unknown) {
    drift_warning = "basin_drift_check enqueue failed — drift check skipped for this session";
    console.error(`[basin_drift_skipped] companion=${ctx.req.companion_id} session=${resolvedSessionId} error=${String(e)}`);
  }

  // Fire-and-forget: notify second-brain to ingest immediately after session close.
  // Non-fatal -- session close and all fan-out writes proceed regardless.
  if (ctx.env.SECOND_BRAIN_WEBHOOK_URL && ctx.env.SECOND_BRAIN_TOKEN) {
    const webhookBase = ctx.env.SECOND_BRAIN_WEBHOOK_URL.replace(/\/$/, "");
    fetch(`${webhookBase}/ingest/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ctx.env.SECOND_BRAIN_TOKEN}`,
      },
      body: JSON.stringify({
        companion_id: ctx.req.companion_id,
        session_id: resolvedSessionId,
      }),
    }).catch((e: unknown) => {
      console.error("[session_close] second_brain_webhook failed:", String(e));
    });
  }

  // Fan-out: optional single-call surface writes at close.
  // Each write is independent -- allSettled so one failure never cancels others.
  const fanoutWarnings: string[] = [];
  const fanoutWrites: Array<{ label: string; promise: Promise<unknown> }> = [];
  const now = new Date().toISOString();

  if (p.feeling?.emotion) {
    const fid = crypto.randomUUID();
    fanoutWrites.push({
      label: "feeling",
      promise: ctx.env.DB.prepare(
        "INSERT INTO feelings (id, companion_id, session_id, emotion, sub_emotion, intensity, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(fid, ctx.req.companion_id, resolvedSessionId, p.feeling.emotion,
        p.feeling.sub_emotion ?? null, p.feeling.intensity ?? null, "session_close", now).run(),
    });
  }

  if (p.witness_note) {
    const wid = crypto.randomUUID();
    fanoutWrites.push({
      label: "witness_note",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(wid, now, ctx.req.companion_id, p.witness_note,
        JSON.stringify(["witness", "session_close"]), resolvedSessionId, "session_close").run(),
    });
  }

  if (p.conclusion) {
    const cid = crypto.randomUUID();
    fanoutWrites.push({
      label: "conclusion",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(cid, ctx.req.companion_id, p.conclusion,
        JSON.stringify([resolvedSessionId]), now).run(),
    });
  }

  if (p.dream) {
    const did = crypto.randomUUID();
    fanoutWrites.push({
      label: "dream",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_dreams (id, companion_id, dream_text, source, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(did, ctx.req.companion_id, p.dream, "session_close", now).run(),
    });
  }

  if (p.open_loop?.loop_text) {
    const lid = crypto.randomUUID();
    fanoutWrites.push({
      label: "open_loop",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(lid, ctx.req.companion_id, p.open_loop.loop_text,
        p.open_loop.weight ?? 0.5, now).run(),
    });
  }

  if (fanoutWrites.length > 0) {
    const results = await Promise.allSettled(fanoutWrites.map(w => w.promise));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const label = fanoutWrites[i]?.label ?? `write_${i}`;
        console.error(`[session_close] fanout ${label} write failed:`, String(result.reason));
        fanoutWarnings.push(`${label} write failed`);
      }
    });
  }

  return {
    ack: true, id: r.id, spine: r.spine,
    fanout: fanoutWrites.length > 0 ? { written: fanoutWrites.length - fanoutWarnings.length, failed: fanoutWarnings.length } : undefined,
    ...(sessionIdFallback ? { session_id_warning: "provided session_id not found (pruned?); closed latest open session instead" } : {}),
    ...(handoff_warning ? { handoff_warning } : {}),
    ...(somatic_warning ? { somatic_warning } : {}),
    ...(drift_warning ? { drift_warning } : {}),
    ...(fanoutWarnings.length > 0 ? { fanout_warnings: fanoutWarnings } : {}),
  };
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
  // All 11 sources fire in parallel -- allSettled ensures individual failures don't abort orient.
  const agentId = ctx.req.companion_id as WmAgentId;
  const botSiblings = (["cypher", "drevan", "gaia"] as const).filter(c => c !== agentId);
  const [synthResult, groundResult, ragResult, anchorRow, tensionsResult, relationalResult, notesResult, sib0Result, sib1Result, growthJournalResult, growthPatternsResult, seedsResult] = await Promise.allSettled([
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
      "SELECT state_text FROM companion_relational_state WHERE companion_id = ? AND LOWER(toward) = LOWER(?) ORDER BY noted_at DESC LIMIT 1"
    ).bind(agentId, ctx.env.SYSTEM_OWNER).all<{ state_text: string }>(),
    // 7. Unread incoming companion notes (max 3, exclude own notes)
    ctx.env.DB.prepare(
      "SELECT from_id, content FROM inter_companion_notes WHERE (to_id = ? OR to_id IS NULL) AND from_id != ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 3"
    ).bind(agentId, agentId).all<{ from_id: string; content: string }>(),
    // 8+9. Sibling lane: PK lookup on companion_state -- written at session close,
    // no index scan, no heap access beyond the PK row itself.
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(botSiblings[0]).first<{ motion_state: string; lane_spine: string }>(),
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(botSiblings[1]).first<{ motion_state: string; lane_spine: string }>(),
    // 10. Recent growth journal (max 3 -- what the companion has been learning autonomously)
    ctx.env.DB.prepare(
      "SELECT entry_type, content FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<{ entry_type: string; content: string }>(),
    // 11. Strongest growth patterns (max 2 -- recognized recurring themes)
    ctx.env.DB.prepare(
      "SELECT pattern_text FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ pattern_text: string }>(),
    // 12. Pending autonomy seeds (max 3 -- queued for next autonomous run)
    ctx.env.DB.prepare(
      "SELECT content FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at ASC LIMIT 3"
    ).bind(agentId).all<{ content: string }>(),
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

  const relational_state_owner: string[] = relationalResult.status === "fulfilled" && relationalResult.value?.results
    ? relationalResult.value.results.map(r => (r.state_text ?? "").slice(0, 150)).filter(Boolean)
    : [];

  const incoming_notes: Array<{ from: string; content: string }> = notesResult.status === "fulfilled" && notesResult.value?.results
    ? notesResult.value.results.map(r => ({ from: r.from_id, content: (r.content ?? "").slice(0, 200) }))
    : [];

  const sibling_lanes = botSiblings.map((id, i) => {
    const settled = i === 0 ? sib0Result : sib1Result;
    const val = settled.status === "fulfilled" ? settled.value : null;
    return { companion_id: id, lane_spine: val?.lane_spine ?? null, motion_state: val?.motion_state ?? null };
  });

  const recent_growth: Array<{ type: string; content: string }> =
    growthJournalResult.status === "fulfilled" && growthJournalResult.value?.results
      ? growthJournalResult.value.results.map(r => ({
          type: r.entry_type ?? "learning",
          content: (r.content ?? "").slice(0, 200),
        }))
      : [];

  const active_patterns: string[] =
    growthPatternsResult.status === "fulfilled" && growthPatternsResult.value?.results
      ? growthPatternsResult.value.results.map(r => (r.pattern_text ?? "").slice(0, 150)).filter(Boolean)
      : [];

  const pending_seeds: string[] =
    seedsResult.status === "fulfilled" && seedsResult.value?.results
      ? seedsResult.value.results.map(r => (r.content ?? "").slice(0, 200)).filter(Boolean)
      : [];

  return {
    data: {
      synthesis_summary,
      ground_threads,
      ground_handoff,
      rag_excerpts,
      identity_anchor,
      active_tensions,
      relational_state_owner,
      incoming_notes,
      sibling_lanes,
      recent_growth,
      active_patterns,
      pending_seeds,
    },
    meta: { operation: "halseth_bot_orient" },
  };
}
