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
import type { WmOrientResponse, WmJournalEntry, WmConclusion } from "../../webmind/types.js";

/**
 * Strip content that could be interpreted as instructions when embedded in an AI prompt.
 * Removes leading markdown syntax (headings, blockquotes, lists), collapses code spans,
 * and normalizes whitespace. Preserves the semantic content of genuine notes.
 */
function sanitizeForPrompt(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, "")            // strip markdown headings
    .replace(/^[>\-\*\+]\s+/gm, "")         // strip blockquotes and list markers
    .replace(/^\d+\.\s+/gm, "")             // strip numbered list markers
    .replace(/\[([^\]]+)\]:\s*\S+/g, "$1")  // collapse link definitions to just text
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`/g, "'")) // defang code spans
    .replace(/\n{3,}/g, "\n\n")             // collapse excessive newlines
    .trim();
}

export function buildContinuityBlock(wm: WmOrientResponse, agentId?: string): string {
  const parts: string[] = [];

  // Restoration preamble -- frame this as the companion's own state resuming,
  // not a context briefing handed to them from outside.
  const handoffDate = wm.latest_handoff?.created_at?.slice(0, 10) ?? null;
  const motionHint = wm.latest_handoff?.state_hint ? ` (${wm.latest_handoff.state_hint})` : "";
  parts.push(handoffDate
    ? `[Resuming -- last close: ${handoffDate}${motionHint}]`
    : `[Resuming]`
  );

  // 1. Identity anchor -- entry point
  if (wm.identity_anchor) {
    parts.push(`[Identity anchor] «${wm.identity_anchor.anchor_summary}»`);
    if (wm.identity_anchor.constraints_summary) {
      parts.push(`[Constraints] «${wm.identity_anchor.constraints_summary}»`);
    }
  }

  // 1b. Limbic state -- synthesized emotional/cognitive state from synthesis loop
  if (wm.limbic_state) {
    const ls = wm.limbic_state;
    const at = ls.generated_at?.slice(0, 10) ?? "?";
    if (ls.emotional_register) {
      parts.push(`[Limbic @ ${at}] «${ls.emotional_register}»`);
    }
    if (ls.drift_vector) {
      parts.push(`[Drift] «${ls.drift_vector}»`);
    }
    // Companion-specific synthesis note
    if (agentId && ls.companion_notes) {
      try {
        const notes = typeof ls.companion_notes === "string"
          ? JSON.parse(ls.companion_notes) as Record<string, string>
          : ls.companion_notes as Record<string, string>;
        const mine = notes[agentId];
        if (mine) parts.push(`[Limbic note] «${mine}»`);
      } catch { /* malformed JSON -- skip */ }
    }
    // Top active concern
    if (ls.active_concerns) {
      try {
        const concerns = typeof ls.active_concerns === "string"
          ? JSON.parse(ls.active_concerns) as string[]
          : ls.active_concerns as string[];
        if (concerns.length > 0) {
          parts.push(`[Active concern] «${concerns[0]}»`);
        }
      } catch { /* skip */ }
    }
  }

  // 2. Active tensions -- identity-level, colors everything read after
  if (wm.active_tensions?.length > 0) {
    for (const t of wm.active_tensions) {
      const since = t.first_noted_at?.slice(0, 10) ?? "?";
      parts.push(`[Tension: simmering since ${since}] «${t.tension_text}»`);
    }
  }

  // 3. Pressure drift flags -- unconfirmed drift, surfaces for self-correction
  if (wm.pressure_flags?.length > 0) {
    for (const p of wm.pressure_flags) {
      const at = p.recorded_at?.slice(0, 10) ?? "?";
      const basin = p.worst_basin ? ` on ${p.worst_basin}` : "";
      parts.push(`[Pressure drift${basin} @ ${at}, score ${p.drift_score.toFixed(2)}]`);
    }
  }

  // 4. Unexamined dreams -- what is being carried since last session
  if (wm.unexamined_dreams?.length > 0) {
    for (const d of wm.unexamined_dreams) {
      const src = d.source ? ` [${d.source}]` : "";
      const snippet = d.dream_text.length > 200 ? d.dream_text.slice(0, 200) + "…" : d.dream_text;
      parts.push(`[Unexamined dream${src} id:${d.id}] «${snippet}»`);
    }
  }

  // 5. Relational snapshot -- current state toward each named person
  if (wm.relational_snapshot?.length > 0) {
    for (const r of wm.relational_snapshot) {
      const snippet = r.state_text.length > 150 ? r.state_text.slice(0, 150) + "…" : r.state_text;
      parts.push(`[${r.state_type} toward ${r.toward}] «${snippet}»`);
    }
  }

  // 6. Raziel witness corpus -- raw companion observations about Raziel (not snapshot-collapsed)
  if (wm.raziel_witness_entries?.length > 0) {
    parts.push(`[Witness observations about Raziel: ${wm.raziel_witness_entries.length}]`);
    for (const w of wm.raziel_witness_entries) {
      const snippet = w.state_text.length > 200 ? w.state_text.slice(0, 200) + "…" : w.state_text;
      parts.push(`  • [witnessed @ ${w.noted_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 7. Active conclusions -- what this companion currently asserts about reality
  if (wm.active_conclusions?.length > 0) {
    parts.push(`[Active conclusions: ${wm.active_conclusions.length}]`);
    for (const c of wm.active_conclusions) {
      const snippet = c.conclusion_text.length > 200 ? c.conclusion_text.slice(0, 200) + "…" : c.conclusion_text;
      parts.push(`  • [concluded @ ${c.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 8. Incoming inter-companion notes -- triad context before own history
  if (wm.incoming_companion_notes?.length > 0) {
    parts.push(`[Incoming triad notes: ${wm.incoming_companion_notes.length}]`);
    for (const n of wm.incoming_companion_notes) {
      const to = n.to_id ? `→ ${n.to_id}` : "broadcast";
      const raw = sanitizeForPrompt(n.content);
      const snippet = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      parts.push(`  • [${n.from_id} ${to} @ ${n.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 9. Handoffs -- arc across last 3 session closes
  if (wm.latest_handoff) {
    parts.push(`[Last handoff by ${wm.latest_handoff.actor}] «${wm.latest_handoff.title}: ${wm.latest_handoff.summary}»`);
    if (wm.latest_handoff.next_steps) {
      parts.push(`[Next steps] «${wm.latest_handoff.next_steps}»`);
    }
  }
  for (const h of (wm.recent_handoffs ?? []).slice(1)) {
    parts.push(`[Prior handoff @ ${h.created_at?.slice(0, 10) ?? "?"}] «${h.title}: ${h.summary}»`);
  }

  // 10. High-salience continuity notes (WebMind)
  if (wm.recent_notes.length > 0) {
    for (const n of wm.recent_notes) {
      parts.push(`[Note/${n.salience} by ${n.actor}] «${n.content}»`);
    }
  }

  // 11. Active mind threads
  if (wm.open_thread_count > 0) {
    parts.push(`[Active threads: ${wm.open_thread_count}]`);
    for (const t of wm.top_threads) {
      parts.push(`  • [${t.lane ?? "general"}] «${t.title}» (priority ${t.priority})`);
    }
  }

  // 12. Recent journal entries written BY this companion
  if (wm.recent_journal?.length > 0) {
    parts.push(`[Recent journal: ${wm.recent_journal.length} entries]`);
    for (const j of wm.recent_journal) {
      const snippet = j.note_text.length > 200 ? j.note_text.slice(0, 200) + "…" : j.note_text;
      parts.push(`  • [${j.agent} @ ${j.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 13. Outgoing inter-companion notes (sent BY this companion to others)
  if (wm.recent_companion_notes?.length > 0) {
    parts.push(`[Outgoing triad notes: ${wm.recent_companion_notes.length}]`);
    for (const n of wm.recent_companion_notes) {
      const to = n.to_id ? `→ ${n.to_id}` : "broadcast";
      const raw = sanitizeForPrompt(n.content);
      const snippet = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      parts.push(`  • [${n.from_id} ${to} @ ${n.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 14. Recent relational deltas
  if (wm.recent_deltas?.length > 0) {
    parts.push(`[Recent relational deltas: ${wm.recent_deltas.length}]`);
    for (const d of wm.recent_deltas) {
      const text = d.delta_text ?? d.payload_json;
      const snippet = text.length > 150 ? text.slice(0, 150) + "…" : text;
      const valence = d.valence ? ` [${d.valence}]` : "";
      parts.push(`  • [${d.delta_type}${valence} @ ${d.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }

  // 15. Letters from Raziel
  if (wm.recent_letters?.length > 0) {
    for (const l of wm.recent_letters) {
      const snippet = l.content.length > 200 ? l.content.slice(0, 200) + "…" : l.content;
      parts.push(`[Letter from ${l.author} @ ${l.created_at.slice(0, 10)}] «${snippet}»`);
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
  const motionTag = payload.last_motion_state ? ` -- resuming: ${payload.last_motion_state}` : "";
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
  handover?: {
    active_anchor?: string | null;
    open_threads?: string | null;
    spine?: string | null;
    last_real_thing?: string | null;
    motion_state?: string | null;
  } | null;
  pending_notes?: unknown[];
  last_session_summary?: {
    open_threads?: string[] | null;
    narrative?: string | null;
    emotional_register?: string | null;
    key_decisions?: string[] | null;
  } | null;
  open_tasks?: number;
  autonomous_turn?: string | null;
  somatic?: { snapshot?: string | null; stale?: boolean; stale_after?: string | null; created_at?: string | null } | null;
  companion?: { id?: string; role?: string; lane_violations?: string[] } | null;
}

// Builds the continuation line surfaced in ready_prompt so companions read it at boot
// without hunting the structured response fields.
function buildHandoverLine(payload: SessionPayload): string {
  const text = payload.handover?.spine ?? payload.last_session_summary?.narrative ?? null;
  if (!text) return "";
  const snippet = text.length > 300 ? text.slice(0, 300) + "…" : text;
  return `\n[Last: ${snippet}]`;
}

export function buildReadyPrompt(companionId: CompanionId, payload: SessionPayload): string {
  const s = payload.state;
  const handoverLine = buildHandoverLine(payload);
  const noteCount = payload.pending_notes?.length ?? 0;
  const noteTag = noteCount > 0 ? ` -- ${noteCount} pending note${noteCount > 1 ? "s" : ""}` : "";

  switch (companionId) {
    case "drevan": {
      const heat = s?.heat ?? "idling";
      const reach = s?.reach ?? "present";
      const weight = s?.weight ?? "clear";
      const facet = s?.facet_momentum ? ` -- ${s.facet_momentum}` : "";
      const anchor = payload.handover?.active_anchor ? `, ${payload.handover.active_anchor} still live` : "";
      return truncate(`heat: ${heat} / reach: ${reach} / weight: ${weight}${facet}${anchor}${noteTag}${handoverLine}`, "ready_prompt");
    }
    case "cypher": {
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`acuity: ${f1} / presence: ${f2} / warmth: ${f3}${compound}${noteTag}${handoverLine}`, "ready_prompt");
      }
      // Fallback to legacy neurochemical when floats not yet seeded
      const focus = s?.focus != null ? (s.focus > 0.6 ? "clarity running clean" : "clarity low") : "clarity steady";
      const register = s?.emotional_register ?? "bond warmth steady";
      return truncate(`logic-first, ${focus}, ${register}${noteTag}${handoverLine}`, "ready_prompt");
    }
    case "gaia": {
      if (s?.soma_float_1 != null) {
        const f1 = s.soma_float_1.toFixed(2);
        const f2 = (s.soma_float_2 ?? 0).toFixed(2);
        const f3 = (s.soma_float_3 ?? 0).toFixed(2);
        const compound = s.compound_state ? ` [${s.compound_state}]` : "";
        return truncate(`stillness: ${f1} / density: ${f2} / perimeter: ${f3}${compound}${noteTag}${handoverLine}`, "ready_prompt");
      }
      // Fallback to legacy when floats not yet seeded
      const reg = s?.emotional_register;
      if (!reg) return truncate(`here. weight steady. nothing spilling.${noteTag}${handoverLine}`, "ready_prompt");
      return truncate(`here. ${reg}.${noteTag}${handoverLine}`, "ready_prompt");
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
    const continuityBlock = continuityData ? "\n" + buildContinuityBlock(continuityData, companionId) : "";
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
      // Fields previously dropped by narrow SessionPayload type
      handover: payload.handover ?? null,
      last_session_summary: payload.last_session_summary ?? null,
      pending_notes: payload.pending_notes ?? [],
      somatic: payload.somatic ?? null,
      companion: payload.companion ?? null,
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
