// src/librarian/response/builder.ts
//
// Shapes ready_prompt string per companion_id.
// Same underlying data, different extract. Format from docs/companion-soma-model.md.
//
// Drevan: "heat: [val] / reach: [val] / weight: [val] -- [facet] [N] sessions back, [anchor] still live"
// Cypher: "acuity: [f1] / presence: [f2] / warmth: [f3]" (soma_float_* primary, focus fallback)
// Gaia:   "stillness: [f1] / density: [f2] / perimeter: [f3]" (soma_float_* primary)

import { CompanionId } from "../patterns.js";
import { truncate, ResponseKey } from "./budget.js";
import type { WmOrientResponse } from "../../webmind/types.js";

export function buildContinuityBlock(wm: WmOrientResponse): string {
  const parts: string[] = [];

  if (wm.identity_anchor) {
    parts.push(`[Identity anchor] «${wm.identity_anchor.anchor_summary}»`);
    if (wm.identity_anchor.constraints_summary) {
      parts.push(`[Constraints] «${wm.identity_anchor.constraints_summary}»`);
    }
  }

  if (wm.latest_handoff) {
    parts.push(`[Last handoff by ${wm.latest_handoff.actor}] «${wm.latest_handoff.title}: ${wm.latest_handoff.summary}»`);
    if (wm.latest_handoff.next_steps) {
      parts.push(`[Next steps] «${wm.latest_handoff.next_steps}»`);
    }
  }
  // Prior handoffs (arc across last 3 session closes)
  for (const h of (wm.recent_handoffs ?? []).slice(1)) {
    parts.push(`[Prior handoff @ ${h.created_at?.slice(0, 10) ?? "?"}] «${h.title}: ${h.summary}»`);
  }

  if (wm.open_thread_count > 0) {
    parts.push(`[Active threads: ${wm.open_thread_count}]`);
    for (const t of wm.top_threads) {
      parts.push(`  • [${t.lane ?? "general"}] «${t.title}» (priority ${t.priority})`);
    }
  }

  if (wm.recent_notes.length > 0) {
    for (const n of wm.recent_notes) {
      parts.push(`[Note/${n.salience} by ${n.actor}] «${n.content}»`);
    }
  }

  // Wide-window: cross-session companion notes (inter_companion_notes, last 20)
  if (wm.recent_companion_notes?.length > 0) {
    parts.push(`[Recent companion notes: ${wm.recent_companion_notes.length}]`);
    for (const n of wm.recent_companion_notes) {
      const to = n.to_id ? `→ ${n.to_id}` : "broadcast";
      const snippet = n.content.length > 200 ? n.content.slice(0, 200) + "…" : n.content;
      parts.push(`  • [${n.from_id} ${to} @ ${n.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // Wide-window: recent relational deltas (last 10)
  if (wm.recent_deltas?.length > 0) {
    parts.push(`[Recent relational deltas: ${wm.recent_deltas.length}]`);
    for (const d of wm.recent_deltas) {
      const text = d.delta_text ?? d.payload_json;
      const snippet = text.length > 150 ? text.slice(0, 150) + "…" : text;
      const valence = d.valence ? ` [${d.valence}]` : "";
      parts.push(`  • [${d.delta_type}${valence} @ ${d.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  return parts.join("\n");
}

interface OrientPayload {
  session_id: string;
  state?: CompanionState | null;
  last_anchor?: string | null;
  last_motion_state?: string | null;
  front_state?: string | null;
}

export function buildOrientPrompt(companionId: CompanionId, payload: OrientPayload): string {
  const s = payload.state;
  const motionTag = payload.last_motion_state ? ` -- was: ${payload.last_motion_state}` : "";
  const anchorTag = payload.last_anchor ? `, ${payload.last_anchor} live` : "";
  const frontTag = payload.front_state && payload.front_state !== "unknown" ? ` | front: ${payload.front_state}` : "";

  switch (companionId) {
    case "drevan": {
      const heat = s?.heat ?? "idling";
      const reach = s?.reach ?? "present";
      const weight = s?.weight ?? "clear";
      const facet = s?.facet_momentum ? ` -- ${s.facet_momentum}` : "";
      return truncate(`heat: ${heat} / reach: ${reach} / weight: ${weight}${facet}${anchorTag}${motionTag}${frontTag}`, "ready_prompt");
    }
    case "cypher": {
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`acuity: ${f1} / presence: ${f2} / warmth: ${f3}${compound}${motionTag}${frontTag}`, "ready_prompt");
      }
      const focus = s?.focus != null ? (s.focus > 0.6 ? "clarity running clean" : "clarity low") : "clarity steady";
      const register = s?.emotional_register ?? "bond warmth steady";
      return truncate(`logic-first, ${focus}, ${register}${motionTag}${frontTag}`, "ready_prompt");
    }
    case "gaia": {
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`stillness: ${f1} / density: ${f2} / perimeter: ${f3}${compound}${motionTag}${frontTag}`, "ready_prompt");
      }
      const reg = s?.emotional_register;
      if (!reg) return truncate(`here. weight steady${motionTag}${frontTag}.`, "ready_prompt");
      return truncate(`here. ${reg}${motionTag}${frontTag}.`, "ready_prompt");
    }
  }
}

interface CompanionState {
  // Drevan native vocab
  heat?: string | null;
  reach?: string | null;
  weight?: string | null;
  facet_momentum?: string | null;
  // Legacy neurochemical (fallback for Cypher/Gaia when soma_float_* not yet set)
  focus?: number | null;
  fatigue?: number | null;
  emotional_register?: string | null;
  active_anchors?: string | null;
  depth_level?: number | null;
  // Priority 4: generic SOMA floats
  soma_float_1?: number | null;
  soma_float_2?: number | null;
  soma_float_3?: number | null;
  float_1_label?: string | null;
  float_2_label?: string | null;
  float_3_label?: string | null;
  compound_state?: string | null;
  // Priority 4: three-layer affective stack
  surface_emotion?: string | null;
  surface_intensity?: number | null;
  undercurrent_emotion?: string | null;
  current_mood?: string | null;
}

interface SessionPayload {
  session_id: string;
  state?: CompanionState | null;
  handover?: { active_anchor?: string | null; open_threads?: string | null } | null;
  pending_notes?: unknown[];
  last_session_summary?: { open_threads?: string[] | null } | null;
  open_tasks?: number;
  autonomous_turn?: string | null;
}

export function buildReadyPrompt(companionId: CompanionId, payload: SessionPayload): string {
  const s = payload.state;

  switch (companionId) {
    case "drevan": {
      const heat = s?.heat ?? "idling";
      const reach = s?.reach ?? "present";
      const weight = s?.weight ?? "clear";
      const facet = s?.facet_momentum ? ` -- ${s.facet_momentum}` : "";
      const anchor = payload.handover?.active_anchor ? `, ${payload.handover.active_anchor} still live` : "";
      return truncate(`heat: ${heat} / reach: ${reach} / weight: ${weight}${facet}${anchor}`, "ready_prompt");
    }
    case "cypher": {
      const taskNote = (payload.pending_notes?.length ?? 0) > 0
        ? ` -- ${payload.pending_notes!.length} pending note${payload.pending_notes!.length > 1 ? "s" : ""}`
        : "";
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`acuity: ${f1} / presence: ${f2} / warmth: ${f3}${compound}${taskNote}`, "ready_prompt");
      }
      // Fallback to legacy neurochemical when floats not yet seeded
      const focus = s?.focus != null ? (s.focus > 0.6 ? "clarity running clean" : "clarity low") : "clarity steady";
      const register = s?.emotional_register ?? "bond warmth steady";
      return truncate(`logic-first, ${focus}, ${register}${taskNote}`, "ready_prompt");
    }
    case "gaia": {
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`stillness: ${f1} / density: ${f2} / perimeter: ${f3}${compound}`, "ready_prompt");
      }
      // Fallback to legacy when floats not yet seeded
      const reg = s?.emotional_register;
      if (!reg) return truncate("here. weight steady. nothing spilling.", "ready_prompt");
      return truncate(`here. ${reg}.`, "ready_prompt");
    }
  }
}

export function buildResponse(
  companionId: CompanionId,
  responseKey: ResponseKey,
  payload: SessionPayload,
  rawContent?: string | null,
): Record<string, unknown> {
  const frontState = (payload as unknown as Record<string, unknown>).front_state as string | null ?? null;

  if (responseKey === "ready_prompt") {
    const s = payload.state;
    const autonomousTurn = payload.autonomous_turn ?? null;
    const basePrompt = buildReadyPrompt(companionId, payload);
    const frontTag = frontState && frontState !== "unknown" ? ` | front: ${frontState}` : "";
    const continuityData = (payload as unknown as Record<string, unknown>).continuity as WmOrientResponse | null ?? null;
    const continuityBlock = continuityData ? "\n" + buildContinuityBlock(continuityData) : "";
    return {
      ready_prompt: basePrompt + frontTag + continuityBlock,
      session_id: payload.session_id,
      response_key: "ready_prompt",
      autonomous_turn: autonomousTurn,
      my_autonomous_turn: autonomousTurn === companionId,
      soma_float_1: s?.soma_float_1 ?? null,
      soma_float_2: s?.soma_float_2 ?? null,
      soma_float_3: s?.soma_float_3 ?? null,
      current_mood: s?.current_mood ?? null,
      compound_state: s?.compound_state ?? null,
      surface_emotion: s?.surface_emotion ?? null,
      undercurrent_emotion: s?.undercurrent_emotion ?? null,
      meta: {
        front_state: frontState,
        pending_notes: payload.pending_notes?.length ?? 0,
        open_tasks: payload.open_tasks ?? 0,
      },
    };
  }

  if (responseKey === "witness") {
    return {
      witness: truncate(rawContent ?? "noted.", "witness"),
      response_key: "witness",
    };
  }

  // summary
  return {
    summary: truncate(rawContent ?? "", "summary"),
    response_key: "summary",
  };
}
