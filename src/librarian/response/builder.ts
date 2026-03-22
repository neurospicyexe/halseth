// src/librarian/response/builder.ts
//
// Shapes ready_prompt string per companion_id.
// Same underlying data, different extract. Format from docs/companion-soma-model.md.
//
// Drevan: "heat: [val] / reach: [val] / weight: [val] -- [facet] [N] sessions back, [anchor] still live"
// Cypher: "logic-first, [clarity], [register] -- N pending notes"
// Gaia:   "here. [register]. weight [weight]."

import { CompanionId } from "../patterns.js";
import { truncate, ResponseKey } from "./budget.js";

interface CompanionState {
  heat?: string | null;
  reach?: string | null;
  weight?: string | null;
  facet_momentum?: string | null;
  focus?: number | null;
  fatigue?: number | null;
  emotional_register?: string | null;
  active_anchors?: string | null;
  depth_level?: number | null;
}

interface SessionPayload {
  session_id: string;
  state?: CompanionState | null;
  handover?: { active_anchor?: string | null; open_threads?: string | null } | null;
  pending_notes?: unknown[];
  last_session_summary?: { open_threads?: string[] | null } | null;
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
      const focus = s?.focus != null ? (s.focus > 0.6 ? "clarity running clean" : "clarity low") : "clarity steady";
      const register = s?.emotional_register ?? "bond warmth steady";
      const taskNote = (payload.pending_notes?.length ?? 0) > 0
        ? ` -- ${payload.pending_notes!.length} pending note${payload.pending_notes!.length > 1 ? "s" : ""}`
        : "";
      return truncate(`logic-first, ${focus}, ${register}${taskNote}`, "ready_prompt");
    }
    case "gaia": {
      const weight = s?.weight ?? "steady";
      const reg = s?.emotional_register;
      if (!reg) return truncate("here. weight steady. nothing spilling.", "ready_prompt");
      return truncate(`here. ${reg}. weight ${weight}.`, "ready_prompt");
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
    return {
      ready_prompt: buildReadyPrompt(companionId, payload),
      session_id: payload.session_id,
      response_key: "ready_prompt",
      meta: {
        front_state: frontState,
        pending_notes: payload.pending_notes?.length ?? 0,
        open_tasks: 0, // Lean phase: hardcoded. session_open does not fetch task list.
                       // Phase 2: call taskList() and pass count through here.
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
