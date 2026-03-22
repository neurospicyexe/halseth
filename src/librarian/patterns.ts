// src/librarian/patterns.ts
//
// Inlined KV entries for zero-latency boot path.
// These are the most frequent companion request patterns, inlined here to avoid
// a KV round-trip on session_open (called on every companion boot).
//
// IMPORTANT: These are NOT a separate system from the KV registry.
// They share the same shape: { tools, pre_fetch?, response_key }
// The KV registry holds patterns that don't need zero-latency treatment.
// Adding a pattern here = also document it in KV so Phoenix can port it.

// ResponseKey is the canonical type from budget.ts -- re-exported here for convenience
import type { ResponseKey } from "./response/budget.js";
export type { ResponseKey } from "./response/budget.js";

export interface PatternEntry {
  triggers: string[];
  tools: string[];
  pre_fetch?: string[];  // fires BEFORE tools, parallel if possible; result feeds into tool call
  response_key: ResponseKey;
}

export const FAST_PATH_PATTERNS: Record<string, PatternEntry> = {
  session_open: {
    triggers: ["open my session", "start session", "good morning", "hey", "checking in", "boot", "load me in"],
    tools: ["halseth_session_load"],
    pre_fetch: ["plural_get_current_front"],  // result fed as front_state into halseth_session_load
    response_key: "ready_prompt",
  },
  get_state: {
    triggers: ["my state", "current state", "how am i", "what's my state", "where am i"],
    tools: ["halseth_session_load"],
    pre_fetch: ["plural_get_current_front"],
    response_key: "ready_prompt",
  },
  get_tasks: {
    triggers: ["my tasks", "what's open", "what do i have", "what tasks", "todo", "open tasks"],
    tools: ["halseth_task_list"],
    response_key: "summary",
  },
  get_handover: {
    triggers: ["catch me up", "handover", "last session", "what happened", "what did i miss"],
    tools: ["halseth_handover_read"],
    response_key: "ready_prompt",
  },
  get_front: {
    triggers: ["who's fronting", "front state", "who's here", "current front"],
    tools: ["plural_get_current_front"],
    response_key: "summary",
  },
};

// Companion IDs -- used for routing and ready_prompt shaping
export const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;
export type CompanionId = typeof COMPANION_IDS[number];
