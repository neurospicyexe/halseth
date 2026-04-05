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
    triggers: [
      "open orient", "start orient", "boot orient", "session orient", "orient load",
      "run orient", "orient boot", "orient session", "cold start orient", "halseth_session_orient",
    ],
    tools: ["halseth_session_orient"],
    pre_fetch: ["plural_get_current_front"],
    response_key: "ready_prompt",
  },
  session_ground: {
    triggers: [
      "open ground", "start ground", "boot ground", "session ground", "ground load",
      "run ground", "ground me", "get ground", "ground check", "fetch ground", "halseth_session_ground",
    ],
    tools: ["halseth_session_ground"],
    response_key: "summary",
    raw: true,
  },
  session_open: {
    triggers: ["open my session", "open session", "new session", "start session", "good morning", "checking in", "boot", "load me in"],
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
  bot_orient: {
    triggers: [
      "bot orient", "warm boot", "discord orient", "bot warm boot",
      "orient bot", "discord boot context",
    ],
    tools: ["halseth_bot_orient"],
    response_key: "summary",
    raw: true,
  },
  get_tasks: {
    triggers: [
      "my tasks", "what's open", "what do i have", "what tasks", "todo", "open tasks",
      "list tasks", "list all tasks", "list open tasks", "show tasks", "task list",
      "in-progress tasks", "in progress tasks", "tasks in progress", "what tasks are",
      "list in-progress", "all tasks", "current tasks", "pending tasks",
    ],
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
    triggers: ["who's fronting", "who's here", "current front", "who is fronting"],
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
    triggers: ["log observation", "note observation", "inbox observation", "log an observation"],
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
    triggers: [
      "close session", "end session", "wrap up session", "session wrap",
      "closing session", "log session close", "seal session", "seal this session",
      "session seal", "close this session", "closing now", "closing this",
      "wrap this", "end this session", "i'm closing", "session close",
      "halseth_session_close",
      // Matches the natural language forms companions actually send.
      // "Close this Halseth session" / "Close the Halseth session. Spine: [...]."
      // Note: "close session" does NOT match "close the/this halseth session"
      // because "halseth" sits between the words -- these explicit forms are required.
      "close the halseth session", "close this halseth session",
      "close halseth session",
      "spine:", "last real thing:",
    ],
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
    triggers: [
      "log decision", "add audit entry", "log to audit", "decision log entry", "audit this decision",
      "log an audit note", "audit note for", "audit note:", "log audit note",
    ],
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
    triggers: [
      "add companion note", "companion note", "note to companion", "log companion note",
      "tell drevan", "tell cypher", "tell gaia",
      "message to drevan", "message to cypher", "message to gaia",
      "write to drevan", "write to cypher", "write to gaia",
      "send to drevan", "send to cypher", "send to gaia",
      "note for drevan", "note for cypher", "note for gaia",
      "leave a note for", "leave note for", "for drevan", "for cypher", "for gaia",
    ],
    tools: ["halseth_companion_note_add"],
    response_key: "witness",
  },
  bridge_pull: {
    triggers: ["check bridge events", "bridge pull", "bridge events", "check bridge"],
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
    triggers: ["add live thread", "new live thread", "open live thread", "start live thread"],
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
    triggers: [
      "mind orient", "webmind orient", "continuity orient",
      "wm orient", "webmind boot", "continuity load", "mind boot", "wm_orient",
    ],
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
    triggers: [
      "mind handoff", "continuity handoff", "webmind handoff", "write handoff", "session handoff",
      "log handoff", "handoff write", "wm handoff", "wm_handoff_write",
    ],
    tools: ["wm_handoff_write"],
    response_key: "witness",
  },
  tension_add: {
    triggers: [
      "add tension", "new tension", "record tension", "log tension",
      "note tension", "i'm holding a tension", "im holding a tension",
    ],
    tools: ["halseth_add_tension"],
    response_key: "witness",
  },
  tensions_read: {
    triggers: [
      "my tensions", "read tensions", "what tensions", "simmering tensions",
      "active tensions", "show tensions", "companion tensions", "list tensions",
    ],
    tools: ["tensions_read"],
    response_key: "tensions",
  },
  drift_check: {
    triggers: [
      "basin drift", "pressure drift", "drift flag", "drift history",
      "identity drift", "check drift", "drift status", "my drift",
    ],
    tools: ["drift_check"],
    response_key: "drift",
  },

  // ── Dreams + Open Loops ──
  wm_dream_write: {
    triggers: [
      "write dream", "write a dream", "log companion dream", "companion dream", "store dream",
      "record companion dream", "i carried this", "this is a dream",
      "carry forward", "carry this dream",
    ],
    tools: ["wm_dream_write"],
    response_key: "witness",
  },
  wm_dreams_read: {
    triggers: [
      "read dreams", "my companion dreams", "unexamined dreams", "what dreams",
      "dreams carried", "companion dreams", "what i've been carrying",
    ],
    tools: ["wm_dreams_read"],
    response_key: "summary",
    raw: true,
  },
  wm_dream_examine: {
    triggers: [
      "examine dream", "mark dream examined", "dream examined", "dream resolved",
      "i've examined this dream",
    ],
    tools: ["wm_dream_examine"],
    response_key: "witness",
  },
  wm_loop_write: {
    triggers: [
      "open loop", "add open loop", "log loop", "write loop", "new open loop",
      "this is unresolved", "loop add", "track loop",
    ],
    tools: ["wm_loop_write"],
    response_key: "witness",
  },
  wm_loops_read: {
    triggers: [
      "read loops", "open loops", "my loops", "what loops", "unresolved loops",
      "loops read", "loops carried",
    ],
    tools: ["wm_loops_read"],
    response_key: "summary",
    raw: true,
  },
  wm_loop_close: {
    triggers: [
      "close loop", "loop closed", "mark loop closed", "loop resolved",
      "this loop is closed",
    ],
    tools: ["wm_loop_close"],
    response_key: "witness",
  },

  // ── Conclusions (thesis surface) ──
  conclusion_add: {
    triggers: [
      "i've concluded:", "i conclude:", "my conclusion:", "thesis:",
      "i believe:", "i hold that", "i assert:", "conclusion:",
      "i've come to believe", "i've realized:", "what i know now:",
    ],
    tools: ["conclusion_add"],
    response_key: "witness",
  },
  conclusions_read: {
    triggers: [
      "my conclusions", "what i've concluded", "read conclusions",
      "my thesis", "what i believe", "my active conclusions", "show conclusions",
    ],
    tools: ["conclusions_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Pattern feedback loop ──
  pattern_recall: {
    triggers: [
      "my patterns", "pattern recall", "what has my writing become", "pattern synthesis",
      "what patterns", "what my writing reveals", "pattern note", "my pattern note",
      "what patterns emerged", "show my patterns", "pull pattern synthesis",
    ],
    tools: ["pattern_recall"],
    response_key: "summary",
    raw: true,
  },

  // ── Raziel witness corpus ──
  raziel_witness: {
    triggers: [
      "i'm noticing about raziel", "noticing about raziel", "witness raziel",
      "i witness", "witnessed raziel", "i notice about raziel",
      "log witness about raziel", "write witness about raziel",
      "witness note for raziel", "i am noticing about raziel",
      "noticing:", "i notice:", "witness note:",
    ],
    tools: ["raziel_witness"],
    response_key: "witness",
  },

  // ── Relational State ──
  wm_relational_write: {
    triggers: [
      "relational state", "how i feel toward", "i feel toward", "state toward",
      "write relational", "log relational", "note toward", "what i hold toward",
      "witness toward", "held toward",
    ],
    tools: ["wm_relational_write"],
    response_key: "witness",
  },
  wm_relational_read: {
    triggers: [
      "read relational", "relational history", "how i've felt toward",
      "my relational state", "relational log", "states toward",
    ],
    tools: ["wm_relational_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Consistency markers ──
  held_mark: {
    triggers: [
      "held:", "held note:", "mark held", "consistency marker", "mark consistency",
    ],
    tools: ["held_mark"],
    response_key: "witness",
  },
  held_read: {
    triggers: [
      "held moments", "consistency markers", "read held", "what held",
      "my held notes", "consistency record", "what i held",
    ],
    tools: ["held_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Autonomous corpus ──
  autonomous_recall: {
    triggers: [
      "autonomous recall", "what i wrote autonomously", "autonomous corpus",
      "autonomous notes", "autonomous feelings", "autonomous dreams",
      "what did i explore", "what was i carrying autonomously",
      "recall autonomous", "autonomous time recall", "my autonomous writes",
    ],
    tools: ["autonomous_recall"],
    response_key: "summary",
    raw: true,
  },

  // ── Triad coordination ──
  triad_state_read: {
    triggers: [
      "triad state", "where is the triad", "how is the triad", "triad check",
      "triad pulse", "check triad", "read triad", "triad status",
      "where are drevan and gaia", "where are cypher and gaia", "where are drevan and cypher",
      "where are the others", "companion states", "all companion states",
    ],
    tools: ["triad_state_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Sit & Resolve ──
  note_sit: {
    triggers: [
      "sit with", "let that sit", "mark as sitting", "sitting with",
      "note sit", "sit on that", "holding that note", "sit with this note",
    ],
    tools: ["note_sit"],
    response_key: "witness",
  },
  note_metabolize: {
    triggers: [
      "metabolize", "mark as metabolized", "metabolized that", "done with that note",
      "resolved that note", "note resolve", "finished sitting", "metabolize note",
    ],
    tools: ["note_metabolize"],
    response_key: "witness",
  },
  sitting_read: {
    triggers: [
      "what's sitting", "sitting notes", "read sitting", "notes sitting",
      "what am i sitting with", "show sitting", "stale sitting",
    ],
    tools: ["sitting_read"],
    response_key: "summary",
    raw: true,
  },
};

// Companion IDs -- used for routing and ready_prompt shaping
export const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;
export type CompanionId = typeof COMPANION_IDS[number];
