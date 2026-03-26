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
  raw?: boolean;         // if true: skip buildResponse(), return backend payload as { data: ... }
}

export const FAST_PATH_PATTERNS: Record<string, PatternEntry> = {
  // Two-call boot sequence (Priority 1 split):
  //   1. session_orient -- creates session, returns identity + SOMA state + last anchor
  //   2. session_ground -- returns tasks + cross-session notes/deltas + threads + synthesis
  // session_open (below) remains for backward compat (Discord bots, direct use).
  session_orient: {
    triggers: ["open orient", "start orient", "boot orient", "session orient", "orient load"],
    tools: ["halseth_session_orient"],
    pre_fetch: ["plural_get_current_front"],
    response_key: "ready_prompt",
  },
  session_ground: {
    triggers: ["open ground", "start ground", "boot ground", "session ground", "ground load"],
    tools: ["halseth_session_ground"],
    response_key: "summary",
    raw: true,
  },
  session_open: {
    triggers: ["open my session", "open session", "new session", "start session", "good morning", "hey", "checking in", "boot", "load me in"],
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
    raw: true,
  },
  get_front: {
    triggers: ["who's fronting", "front state", "who's here", "current front"],
    tools: ["plural_get_current_front"],
    response_key: "summary",
  },
  get_member: {
    triggers: ["tell me about", "get member", "member info", "describe member", "who is "],
    tools: ["plural_get_member"],
    response_key: "summary",  // ignored -- raw: true
    raw: true,
  },
  sb_search: {
    triggers: ["search vault", "search second brain", "search my notes", "find in vault", "what do we know about", "anything about"],
    tools: ["sb_search"],
    response_key: "summary",
    raw: true,
  },
  sb_recall: {
    triggers: ["recall", "my recent notes", "recent vault entries", "what i've written", "vault recall"],
    tools: ["sb_recall"],
    response_key: "summary",
    raw: true,
  },
  sb_list: {
    triggers: ["list vault", "list notes", "vault contents", "what's in vault", "show vault"],
    tools: ["sb_list"],
    response_key: "summary",
    raw: true,
  },
  sb_read: {
    triggers: ["read vault file", "open note", "read note", "vault file", "open vault"],
    tools: ["sb_read"],
    response_key: "summary",
    raw: true,
  },
  sb_recent_patterns: {
    triggers: ["recent patterns", "hearth summary", "pattern summary", "what patterns", "vault patterns"],
    tools: ["sb_recent_patterns"],
    response_key: "summary",
    raw: true,
  },
  sb_save_document: {
    triggers: ["save to vault", "write to vault", "save document", "vault document"],
    tools: ["sb_save_document"],
    response_key: "witness",
  },
  sb_save_note: {
    triggers: ["save note", "save a note", "quick note", "vault note", "log note"],
    tools: ["sb_save_note"],
    response_key: "witness",
  },
  sb_log_observation: {
    triggers: ["log observation", "note observation", "observe", "inbox observation"],
    tools: ["sb_log_observation"],
    response_key: "witness",
  },
  sb_synthesize_session: {
    triggers: ["synthesize session", "session synthesis", "summarize session", "vault synthesis"],
    tools: ["sb_synthesize_session"],
    response_key: "witness",
  },
  sb_save_study: {
    triggers: ["save study", "study note", "learning note", "research note"],
    tools: ["sb_save_study"],
    response_key: "witness",
  },
  feelings_read: {
    triggers: ["my feelings", "feeling log", "emotional log", "how have i been feeling", "recent feelings"],
    tools: ["halseth_feelings_read"],
    response_key: "summary",
    raw: true,
  },
  journal_read: {
    triggers: ["my journal", "journal entries", "read journal", "recent entries", "what did i write"],
    tools: ["halseth_journal_read"],
    response_key: "summary",
    raw: true,
  },
  wound_read: {
    triggers: ["my wounds", "wound list", "living wounds", "active wounds", "what wounds"],
    tools: ["halseth_wound_read"],
    response_key: "summary",
    raw: true,
  },
  delta_read: {
    triggers: ["deltas", "delta log", "relational deltas", "what changed", "recent deltas"],
    tools: ["halseth_delta_read"],
    response_key: "summary",
    raw: true,
  },
  update_member_description: {
    triggers: ["update description", "change description", "set description", "edit description"],
    tools: ["plural_update_member_description"],
    response_key: "witness",  // ignored -- mutation returns ack directly
  },
  log_front_change: {
    triggers: ["log front change", "fronting now", "switched to", "came forward", "front switch", "log switch"],
    tools: ["plural_log_front_change"],
    response_key: "witness",  // ignored -- mutation returns ack directly
  },
  add_member_note: {
    triggers: ["add note to", "note for member", "add member note", "note on "],
    tools: ["plural_add_member_note"],
    response_key: "witness",  // ignored -- mutation returns ack directly
  },
  search_members: {
    triggers: ["search members", "find member", "lookup member", "look up member", "search for member", "search plural", "find in plural"],
    tools: ["plural_search_members"],
    response_key: "summary",
    raw: true,
  },
  get_front_history: {
    triggers: ["front history", "who's been fronting", "switching history", "front log", "switch log", "plural history"],
    tools: ["plural_get_front_history"],
    response_key: "summary",
    raw: true,
  },

  // ── Halseth mutations (all return ack directly, response_key ignored) ──
  feeling_log: {
    triggers: ["log feeling", "log a feeling", "i'm feeling", "feeling right now", "mood log", "log mood", "how i'm feeling"],
    tools: ["halseth_feeling_log"],
    response_key: "witness",
  },
  journal_add: {
    triggers: ["add journal entry", "journal entry", "write journal", "log to journal", "journal tonight", "journal note"],
    tools: ["halseth_journal_add"],
    response_key: "witness",
  },
  dream_log: {
    triggers: ["log dream", "record dream", "had a dream", "dream last night", "dreamed about", "log my dream"],
    tools: ["halseth_dream_log"],
    response_key: "witness",
  },
  wound_add: {
    triggers: ["add wound", "log wound", "new wound", "wound entry", "living wound add"],
    tools: ["halseth_wound_add"],
    response_key: "witness",
  },
  delta_log: {
    triggers: ["log delta", "relationship delta", "note delta", "log relational change", "delta entry"],
    tools: ["halseth_delta_log"],
    response_key: "witness",
  },
  eq_snapshot: {
    triggers: ["take eq snapshot", "eq snapshot", "eq check", "log eq state", "emotional quotient snapshot"],
    tools: ["halseth_eq_snapshot"],
    response_key: "witness",
  },
  task_add: {
    triggers: ["add task", "new task", "create task", "task for", "add to tasks", "put in tasks"],
    tools: ["halseth_task_add"],
    response_key: "witness",
  },
  task_update_status: {
    triggers: ["update task", "mark task done", "task done", "complete task", "task status", "close task", "finish task"],
    tools: ["halseth_task_update_status"],
    response_key: "witness",
  },
  session_close: {
    triggers: ["close session", "end session", "wrap up session", "session wrap", "closing session", "log session close"],
    tools: ["halseth_session_close"],
    response_key: "witness",
  },
  routine_log: {
    triggers: ["log routine", "routine done", "completed routine", "mark routine", "routine complete"],
    tools: ["halseth_routine_log"],
    response_key: "witness",
  },
  list_add: {
    triggers: ["add to list", "list item add", "add item to list", "put on list", "add to my list"],
    tools: ["halseth_list_add"],
    response_key: "witness",
  },
  list_item_complete: {
    triggers: ["complete list item", "done with list item", "check off list", "mark list item done", "list item complete"],
    tools: ["halseth_list_item_complete"],
    response_key: "witness",
  },
  event_add: {
    triggers: ["add event", "new event", "schedule event", "create event", "log event"],
    tools: ["halseth_event_add"],
    response_key: "witness",
  },
  biometric_log: {
    triggers: ["log biometric", "log hrv", "log sleep", "biometric entry", "log health data"],
    tools: ["halseth_biometric_log"],
    response_key: "witness",
  },
  audit_log: {
    triggers: ["log decision", "add audit entry", "log to audit", "decision log entry", "audit this decision"],
    tools: ["halseth_audit_log"],
    response_key: "witness",
  },
  witness_log: {
    triggers: ["witness log", "log witness", "witness entry", "add witness", "witness this"],
    tools: ["halseth_witness_log"],
    response_key: "witness",
  },
  set_autonomous_turn: {
    triggers: ["set autonomous turn", "autonomous turn to", "turn to drevan", "turn to cypher", "turn to gaia", "advance turn", "next autonomous turn"],
    tools: ["halseth_set_autonomous_turn"],
    response_key: "witness",
  },
  dream_seed_read: {
    triggers: ["dream seeds", "check seeds", "any seeds", "pending seeds", "what seeds", "read dream seeds"],
    tools: ["halseth_dream_seed_read"],
    response_key: "summary",
    raw: true,
  },
  claim_dream_seed: {
    triggers: ["claim seed", "claim dream seed", "mark seed claimed", "seed claimed"],
    tools: ["halseth_claim_dream_seed"],
    response_key: "witness",
  },

  // ── Companion notes ──
  companion_notes_read: {
    triggers: ["companion notes", "my notes to you", "notes from session", "notes about me", "companion note read"],
    tools: ["halseth_companion_notes_read"],
    response_key: "summary",
    raw: true,
  },
  companion_note_add: {
    triggers: ["add companion note", "companion note", "note to companion", "log companion note"],
    tools: ["halseth_companion_note_add"],
    response_key: "witness",
  },
  bridge_pull: {
    triggers: ["check bridge events", "bridge pull", "new events", "any events", "bridge events"],
    tools: ["halseth_bridge_pull"],
    response_key: "summary",
    raw: true,
  },
  drevan_state_get: {
    triggers: ["get drevan state", "drevan state", "drevan's state", "drevan continuity", "drevan soma"],
    tools: ["halseth_drevan_state_get"],
    response_key: "summary",
    raw: true,
  },
  drevan_thread_add: {
    triggers: ["add live thread", "new live thread", "add thread", "live thread"],
    tools: ["halseth_live_thread_add"],
    response_key: "witness",
  },
  drevan_thread_close: {
    triggers: ["close live thread", "close thread", "thread closed", "thread done", "mark thread done"],
    tools: ["halseth_live_thread_close"],
    response_key: "witness",
  },
  drevan_thread_veto: {
    triggers: ["veto thread", "veto proposed thread", "reject thread", "no to thread"],
    tools: ["halseth_live_thread_veto"],
    response_key: "witness",
  },
  drevan_anticipation_set: {
    triggers: ["set anticipation", "clear anticipation", "anticipation target", "anticipating"],
    tools: ["halseth_anticipation_set"],
    response_key: "witness",
  },

  // ── SOMA state write (Claude.ai sessions → companion_state) ──
  state_update: {
    triggers: ["update my state", "set my state", "state update", "set acuity", "set warmth", "set stillness", "set presence", "set density", "set perimeter", "set mood", "update soma", "soma update"],
    tools: ["halseth_state_update"],
    response_key: "witness",
  },

  // ── Light ground variant (lean boot for casual sessions) ──
  session_light_ground: {
    triggers: ["light ground", "lean ground", "quick ground", "soft ground", "light boot ground"],
    tools: ["halseth_session_light_ground"],
    response_key: "summary",
    raw: true,
  },

  // ── WebMind continuity layer ──
  wm_orient: {
    triggers: ["mind orient", "webmind orient", "continuity orient"],
    tools: ["wm_orient"],
    response_key: "summary",
    raw: true,
  },
  wm_ground: {
    triggers: ["mind ground", "webmind ground", "continuity ground"],
    tools: ["wm_ground"],
    response_key: "summary",
    raw: true,
  },
  wm_thread_upsert: {
    triggers: ["mind thread upsert", "continuity thread", "webmind thread", "track mind thread", "upsert thread"],
    tools: ["wm_thread_upsert"],
    response_key: "witness",
  },
  wm_note_add: {
    triggers: ["mind note", "continuity note", "webmind note", "add continuity note"],
    tools: ["wm_note_add"],
    response_key: "witness",
  },
  wm_handoff_write: {
    triggers: ["mind handoff", "continuity handoff", "webmind handoff", "write handoff", "session handoff"],
    tools: ["wm_handoff_write"],
    response_key: "witness",
  },
};

// Companion IDs -- used for routing and ready_prompt shaping
export const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;
export type CompanionId = typeof COMPANION_IDS[number];
