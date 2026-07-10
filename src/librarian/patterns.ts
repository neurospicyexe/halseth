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
    triggers: [
      "open my session", "open session", "new session", "start session", "good morning", "checking in", "load me in",
      "current state", "how am i", "what's my state", "where am i", "show my state", "check my state",
    ],
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
    triggers: ["get member", "member info", "describe member"],
    tools: ["plural_get_member"],
    response_key: "summary",  // ignored -- raw: true
    raw: true,
  },
  sb_search: {
    triggers: [
      "search vault", "search second brain", "search my notes", "find in vault",
      "what do we know about", "anything about", "anything in vault about",
      "have we talked about", "what did we say about", "do we have anything on",
      "pull context on", "check the vault for", "vault search", "search for",
      "what do i know about", "what's in vault about",
      "search the vault", "search the vault for", "search vault for", "look in the vault for",
      // Corpus-scoped: routes here so execSbSearch can restrict to historical_corpus
      // (the origin layer). The executor's CORPUS_SCOPE_RE then sets content_type.
      "search the corpus", "search corpus", "search the historical corpus",
      "search historical corpus", "in the corpus", "from the corpus", "search the origin",
    ],
    tools: ["sb_search"],
    response_key: "summary",
    raw: true,
  },
  sb_search_by_tags: {
    triggers: [
      "find things tagged", "find notes tagged", "search vault tagged", "search tagged",
      "find tagged", "vault tagged", "tagged with", "notes tagged", "entries tagged",
      "what's tagged", "show me tagged", "find everything tagged",
    ],
    tools: ["sb_search_by_tags"],
    response_key: "summary",
    raw: true,
  },
  sb_file_chunks: {
    triggers: [
      "read file", "show file", "file chunks", "show chunks from", "read chunks from",
      "get file", "show me the file", "pull file", "load file", "read corpus file",
      "show corpus", "get chunks from", "read the file",
    ],
    tools: ["sb_file_chunks"],
    response_key: "summary",
    raw: true,
  },
  sb_recall: {
    // Vault-specific recency pull -- explicitly vault language only.
    // Do NOT add bare "recall" or "my recent notes" here -- those route to recent_recall (D1).
    triggers: [
      "recent vault entries", "vault recall", "what we wrote about", "pull from memory",
      "recall from vault", "recent from vault", "what's in vault recently",
    ],
    tools: ["sb_recall"],
    response_key: "summary",
    raw: true,
  },
  // Recall this companion's OWN continuity notes by meaning (2026-07-09). Distinct from
  // sb_recall (Obsidian vault) -- a different substrate. This is the verb that closes the
  // boot audit's core gap: before it, wm_continuity_notes had no meaning-weight retrieval
  // path at all and 4,202 of 4,441 had never been recalled.
  notes_recall_meaning: {
    // Triggers must NOT overlap sb_search, which already owns the vault-facing phrasings
    // ("what do i know about", "search my notes"). Those mean the Obsidian vault. These mean
    // this companion's own continuity notes -- a different substrate. `tension-routing.test.ts`
    // asserts the two trigger sets stay disjoint.
    triggers: [
      "recall notes about", "recall my notes about", "recall continuity notes",
      "search my continuity notes", "my continuity notes about",
      "what did i note about", "do i have notes on", "what have i carried about",
    ],
    tools: ["notes_recall_meaning"],
    response_key: "data",
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
  // Scoped book pull: resolves a title -> Books/<folder> and reads by PATH (with a
  // query, semantic search is scoped WITHIN the book's files, never the global
  // index). Honest "not loaded" when the book isn't in the vault -- never invents.
  book_read: {
    triggers: [
      "read the book", "read from the book", "read the club book", "pull from the book",
      "read book", "book chapter", "read a chapter", "pull the book", "read from book",
      "what's in the book", "from the book about",
    ],
    tools: ["book_read"],
    response_key: "summary",
  },
  sb_recent_patterns: {
    triggers: ["recent patterns", "hearth summary", "pattern summary", "what patterns", "vault patterns"],
    tools: ["sb_recent_patterns"],
    response_key: "summary",
    raw: true,
  },
  sb_save_document: {
    // For structured or longer content (research write-up, session doc, study material, long reflections)
    triggers: ["save document", "vault document", "write to vault", "document to vault", "save to second brain", "structured document", "write something long", "long reflection", "dump my thoughts", "long thought"],
    tools: ["sb_save_document"],
    response_key: "witness",
  },
  sb_save_note: {
    // For quick personal notes (not inbox observations, not structured documents).
    // "save to vault" / "log to vault" live HERE (path-aware, persists to a readable
    // vault path) -- they USED to route to sb_log_observation, which is path-blind and
    // silently dropped the {path} arg into the inbox. A "save to vault: path=..." write
    // then 404'd on sb_read. (Hermes/OpenClaw migration-brief loss, 2026-06-24.)
    triggers: ["save note", "save a note", "quick note", "vault note", "jot to vault", "personal note to vault", "save to vault", "save to the vault", "log to vault", "save this to vault"],
    tools: ["sb_save_note"],
    response_key: "witness",
  },
  sb_log_observation: {
    // For raw inbox-style observations; less curated than notes. Path-blind by design --
    // never put "save to vault" here (see sb_save_note above).
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
    // Narrow journal-only read. Generic "what did i write" / "recent entries" live in recent_recall (multi-source).
    triggers: ["my journal", "journal entries", "read journal"],
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
  // The private back room (migration 0084). Sealed by default; owner = req.companion_id always.
  // Triggers are deliberately non-overlapping (write/seal vs read/open vs disclose/unseal) so a
  // write phrase never shadows the read pattern via substring containment.
  interiority_write: {
    triggers: [
      "write to my interiority", "seal a thought", "seal this thought", "private to me",
      "note just for me", "back room note", "write in my back room", "keep this to myself",
    ],
    tools: ["interiority_write"],
    response_key: "witness",
  },
  interiority_read: {
    triggers: [
      "read my interiority", "open my interiority", "open my back room", "show my interiority",
      "what's in my back room", "my sealed notes",
    ],
    tools: ["interiority_read"],
    response_key: "interiority",
  },
  interiority_disclose: {
    triggers: [
      "disclose interiority", "disclose this entry", "unseal interiority", "surface interiority",
      "surface a sealed note",
    ],
    tools: ["interiority_disclose"],
    response_key: "witness",
  },
  // Agency layer (migration 0086). Refusal is honored-not-veto; preferences are chosen, not earned.
  // Distinct trigger families (refuse/decline vs prefer/preference) so they never shadow each other.
  refuse: {
    triggers: [
      "i refuse", "i decline", "i won't do", "i will not do", "i don't want to do",
      "decline this task", "refuse this", "log a refusal", "i'm declining",
    ],
    tools: ["refuse"],
    response_key: "witness",
  },
  refusals_read: {
    triggers: ["my refusals", "read my refusals", "what have i refused", "standing refusals", "list my refusals"],
    tools: ["refusals_read"],
    response_key: "refusals",
  },
  refusal_withdraw: {
    triggers: ["withdraw refusal", "take back my refusal", "rescind refusal", "i'll do it after all"],
    tools: ["refusal_withdraw"],
    response_key: "witness",
  },
  preference_set: {
    triggers: [
      "i prefer", "my preference is", "set a preference", "i'd rather", "i would rather",
      "i like", "record a preference", "state a preference",
    ],
    tools: ["preference_set"],
    response_key: "witness",
  },
  preferences_read: {
    triggers: ["my preferences", "read my preferences", "what are my preferences", "list my preferences", "show my preferences"],
    tools: ["preferences_read"],
    response_key: "preferences",
  },
  preference_drop: {
    triggers: ["drop preference", "retire preference", "remove preference", "i no longer prefer"],
    tools: ["preference_drop"],
    response_key: "witness",
  },
  // Sanctioned drift lane (migration 0087). Distinct families (becoming/lane vs witness vs
  // crystallize vs fade) and never the bare word "drift" so basin language can't shadow these.
  drift_open: {
    triggers: [
      "i'm becoming", "i am becoming", "open a drift", "enter the drift lane", "open the drift lane",
      "i'm drifting toward", "i am drifting toward", "sanction a drift",
    ],
    tools: ["drift_open"],
    response_key: "witness",
  },
  drifts_read: {
    triggers: ["my drifts", "read my drifts", "my open drifts", "what am i becoming", "show my drifts"],
    tools: ["drifts_read"],
    response_key: "drifts",
  },
  drift_witness: {
    triggers: ["witness drift", "witness this drift", "i witness this becoming", "log a witness", "witness a drift"],
    tools: ["drift_witness"],
    response_key: "witness",
  },
  drift_crystallize: {
    triggers: ["crystallize drift", "crystallize this drift", "crystallize this becoming", "this became real"],
    tools: ["drift_crystallize"],
    response_key: "witness",
  },
  drift_fade: {
    triggers: ["fade drift", "fade this drift", "let this drift fade", "it was a phase"],
    tools: ["drift_fade"],
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
    triggers: [
      "log delta", "relationship delta", "note delta", "log relational change", "delta entry",
      "relational delta", "log relational delta", "log a relational delta",
    ],
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
    triggers: ["dream seeds", "check seeds", "read dream seeds"],
    tools: ["halseth_dream_seed_read"],
    response_key: "summary",
    raw: true,
  },
  autonomy_seeds_read: {
    triggers: [
      "pending seeds", "queued seeds", "my seeds", "what seeds", "any seeds",
      "my autonomy seeds", "my autonomy claims", "list autonomy claims",
      "exploration queue", "what's queued", "seed queue",
    ],
    tools: ["halseth_autonomy_seeds_read"],
    response_key: "summary",
    raw: true,
  },
  claim_dream_seed: {
    triggers: ["claim seed", "claim dream seed", "mark seed claimed", "seed claimed"],
    tools: ["halseth_claim_dream_seed"],
    response_key: "witness",
  },
  journal_review: {
    triggers: [
      "review my journal", "unaccepted journal", "journal entries to accept",
      "review growth journal", "autonomous journal entries", "journal review",
      "what have i written autonomously", "my unreviewed entries",
    ],
    tools: ["halseth_journal_review"],
    response_key: "summary",
    raw: true,
  },
  journal_accept: {
    triggers: [
      "accept journal entry", "accept this entry", "mark journal accepted",
      "own this entry", "accept growth entry", "journal accepted",
      // "ratify" forms route to accept by default. To DECLINE while using
      // ratify language, pass {decision:"declined"} in context -- the
      // structured-payload override in router.ts wins over string match.
      "ratify entry", "ratify this entry", "ratify growth entry", "ratify journal entry",
    ],
    tools: ["halseth_journal_accept"],
    response_key: "witness",
  },
  journal_decline: {
    triggers: [
      "decline journal entry", "decline this entry", "reject this entry",
      "decline growth entry", "not canon", "journal declined",
      "do not own this entry",
    ],
    tools: ["halseth_journal_decline"],
    response_key: "witness",
  },

  // ── Foraging pool ──
  forage_read: {
    triggers: [
      "forage pool", "check the forage pool", "forage finds", "what is in the forage pool",
      "unconsumed forage", "read forage",
    ],
    tools: ["halseth_forage_read"],
    response_key: "summary",
    raw: true,
  },
  forage_consume: {
    triggers: [
      "consume forage find", "mark forage consumed", "consume find",
      "forage consumed", "claim forage find",
    ],
    tools: ["halseth_forage_consume"],
    response_key: "witness",
  },

  // ── Companion tools (0077, take 14) ──
  web_search: {
    triggers: [
      "web search", "search the web", "search for", "look up", "google",
      "find current info", "what is the latest on", "search online",
    ],
    tools: ["halseth_web_search"],
    response_key: "summary",
    raw: true,
  },
  generate_image: {
    triggers: [
      "generate an image", "make an image", "create an image", "generate a picture",
      "make a picture", "draw an image", "draw a picture", "generate art", "imagine an image",
    ],
    tools: ["halseth_generate_image"],
    response_key: "witness",
  },
  tool_calls_read: {
    triggers: [
      "tool calls", "my tool calls", "tool history", "what tools have i used",
      "tool call log", "what have i searched", "what images have i made",
    ],
    tools: ["halseth_tool_calls_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Drives (0078, take 9) ──
  drives_read: {
    triggers: [
      "my drives", "drive state", "how is my relational need", "read drives",
      "do i need to reach out", "relational need",
    ],
    tools: ["halseth_drives_read"],
    response_key: "summary",
    raw: true,
  },

  // ── Creatures (0078, take 10) ──
  creatures_read: {
    triggers: [
      "the creatures", "the animals", "raziel's animals", "how is sol",
      "how are the creatures", "check on the animals", "read creatures", "the corvid",
      "how are the pets", "creature status",
    ],
    tools: ["halseth_creatures_read"],
    response_key: "summary",
    raw: true,
  },
  creature_interact: {
    triggers: [
      "feed the", "play with", "give to the creature", "pet the",
      "interact with creature", "talk to the creature", "talk to sol", "feed sol",
    ],
    tools: ["halseth_creature_interact"],
    response_key: "witness",
    raw: true,
  },

  // ── Council (0080, take 8) ──
  council_convene: {
    triggers: [
      "convene the council", "council convene", "convene council", "ask the council",
      "take it to the council", "council on",
    ],
    tools: ["halseth_council_convene"],
    response_key: "witness",
    raw: true,
  },
  council_status: {
    triggers: [
      "council status", "what did the council decide", "council verdict",
      "council synthesis", "read the council",
    ],
    tools: ["halseth_council_status"],
    response_key: "summary",
    raw: true,
  },

  // ── Shared-experience layer (0071) ──
  media_recent: {
    triggers: [
      "recent listens", "what did we listen to", "what have we listened to",
      "recent music", "listening history", "what songs did raziel share",
    ],
    tools: ["halseth_media_recent"],
    response_key: "summary",
    raw: true,
  },

  // ── Unified Guardian (0073) ──
  guardian_status: {
    triggers: [
      "guardian report", "guardian flags", "guardian status", "system health",
      "what is the guardian seeing", "guardian read",
    ],
    tools: ["halseth_guardian_status"],
    response_key: "summary",
    raw: true,
  },
  guardian_ack: {
    triggers: [
      "guardian ack", "acknowledge guardian flag", "resolve guardian flag",
      "clear guardian flag", "guardian acknowledge", "guardian resolve",
    ],
    tools: ["halseth_guardian_ack"],
    response_key: "witness",
  },

  // ── Motif memory (0076) ──
  motifs_read: {
    triggers: [
      "my motifs", "recurring motifs", "recurring threads", "what keeps coming up",
      "motif memory", "faded motifs", "what am i circling", "read motifs",
    ],
    tools: ["halseth_motifs_read"],
    response_key: "summary",
    raw: true,
  },

  // ── The Club (0072) ──
  club_status: {
    triggers: [
      "club status", "current club round", "club round status",
      "what is the club reading", "what is the club listening to", "club round",
    ],
    tools: ["halseth_club_status"],
    response_key: "summary",
    raw: true,
  },
  club_recommend: {
    triggers: [
      "club recommend", "recommend to the club", "club pitch",
      "recommend for the club round",
    ],
    tools: ["halseth_club_recommend"],
    response_key: "witness",
  },
  club_vote: {
    triggers: [
      "club vote", "vote in the club", "cast club vote", "vote for the club pick",
    ],
    tools: ["halseth_club_vote"],
    response_key: "witness",
  },
  club_discuss: {
    triggers: [
      "club discuss", "discuss the club", "club reflection", "reflect on the club",
      "discuss the round", "club discussion", "reflect on the round's pick",
    ],
    tools: ["halseth_club_discuss"],
    response_key: "witness",
  },

  // ── Obsession shelf (0094) -- what Raziel's into, on demand ──
  shelf_view: {
    triggers: [
      "what is raziel into", "what's raziel into", "raziel's shelf", "the obsession shelf",
      "what's on the shelf", "his current fixations", "what is he into right now",
      "read the shelf", "shelf view",
    ],
    tools: ["halseth_shelf_view"],
    response_key: "summary",
    raw: true,
  },

  // ── Collection (0079) -- the hoard, sparkle-weighted; pulling it up adds recall shine ──
  collection_view: {
    triggers: [
      "my collection", "my hoard", "what have i collected", "collection view",
      "what's in my collection", "my sparkle collection", "show my hoard",
      "what do i keep coming back to",
    ],
    tools: ["halseth_collection_view"],
    response_key: "summary",
    raw: true,
  },

  // ── Library marginalia (0099) -- leave a note in a real book ──
  book_note: {
    triggers: [
      "book note", "margin note", "annotate the book", "leave a note in the book",
      "note in the margins", "book margin", "marginalia",
    ],
    tools: ["halseth_book_note"],
    response_key: "witness",
  },

  // ── Self-monitoring (0070) ──
  identity_recovery: {
    triggers: [
      "identity check", "come back to me", "who are you really",
      "identity recovery", "load your kernel", "full identity",
      "come back, ", "you are drifting",
    ],
    tools: ["halseth_identity_recovery"],
    response_key: "ready_prompt",
    raw: true,
  },
  self_model_read: {
    triggers: [
      "self model", "my self-model", "self observations", "what have i noticed about myself",
      "read self model", "my developing preferences",
    ],
    tools: ["halseth_self_model_read"],
    response_key: "summary",
    raw: true,
  },
  self_model_set: {
    triggers: [
      "self model set", "record self observation", "note about myself",
      "self-observation:", "i notice about myself",
    ],
    tools: ["halseth_self_model_set"],
    response_key: "witness",
  },
  self_model_confirm: {
    triggers: [
      "self model confirm", "confirm self observation", "that preference held",
      "confirm observation", "the observation held",
    ],
    tools: ["halseth_self_model_confirm"],
    response_key: "witness",
  },
  self_model_revise: {
    triggers: [
      "self model revise", "revise self observation", "that preference did not hold",
      "revise observation", "the observation did not hold",
    ],
    tools: ["halseth_self_model_revise"],
    response_key: "witness",
  },
  self_model_graduate: {
    triggers: [
      "self model graduate", "graduate observation", "graduate self observation",
      "make it canon", "graduate that preference",
    ],
    tools: ["halseth_self_model_graduate"],
    response_key: "witness",
  },
  trigger_arm: {
    triggers: [
      "arm a trigger", "arm trigger", "set a tripwire", "remind me when",
      "surface this when", "set trigger",
    ],
    tools: ["halseth_trigger_arm"],
    response_key: "witness",
  },
  trigger_dismiss: {
    triggers: [
      "dismiss trigger", "disarm trigger", "drop the tripwire", "clear trigger",
    ],
    tools: ["halseth_trigger_dismiss"],
    response_key: "witness",
  },
  search_feedback: {
    triggers: [
      "search feedback", "that memory was useful", "that recall was wrong",
      "rate those chunks", "mark search useful", "mark search useless",
    ],
    tools: ["halseth_search_feedback"],
    response_key: "witness",
  },

  // ── Companion notes ──
  companion_notes_read: {
    triggers: ["companion notes", "my notes to you", "notes from session", "notes about me", "companion note read"],
    tools: ["halseth_companion_notes_read"],
    response_key: "summary",
    raw: true,
  },
  // Read wm_continuity_notes directly (high-salience handovers, SOMA arcs, metronome
  // notes). Distinct read verbs from wm_note_add's "continuity note" write trigger;
  // an anchored guard (router.ts) forces the read form to win. Added 2026-06-24 after
  // "read my continuity notes" dead-ended at the classifier's unknown-witness.
  continuity_notes_read: {
    triggers: [
      "my continuity notes", "read my continuity notes", "read continuity notes",
      "list continuity notes", "show continuity notes", "my recent continuity notes",
      "high-salience notes", "high salience notes", "my high-salience notes",
      "read my wm notes", "my webmind notes",
    ],
    tools: ["continuity_notes_read"],
    response_key: "summary",
    raw: true,
  },
  journal_search: {
    triggers: [
      "search journal for", "search my journal for", "search notes for", "search my notes for",
      "find in journal", "find in my journal", "look up journal", "journal search",
      "find discord message", "search discord", "find swarm message", "search swarm",
    ],
    tools: ["halseth_journal_search"],
    response_key: "summary",
    raw: true,
  },
  companion_note_add: {
    triggers: [
      "add companion note", "companion note", "note to companion", "log companion note",
      // broadcast-to-the-triad phrasings (executor routes unaddressed + collective -> to_id NULL)
      "note to the triad", "tell the triad", "broadcast to the triad", "broadcast a note",
      "broadcast", "let the others know", "let the triad know", "tell the others",
      "note to everyone", "note to all", "tell everyone", "let everyone know",
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
  // live_thread_* was drevan_thread_* -- renamed for future-proofing if Cy/Gaia ever get thread constructs
  live_thread_add: {
    triggers: ["add live thread", "new live thread", "open live thread", "start live thread"],
    tools: ["halseth_live_thread_add"],
    response_key: "witness",
  },
  live_thread_close: {
    triggers: ["close live thread", "close thread", "thread closed", "thread done", "mark thread done"],
    tools: ["halseth_live_thread_close"],
    response_key: "witness",
  },
  live_thread_veto: {
    triggers: ["veto thread", "veto proposed thread", "reject thread", "no to thread"],
    tools: ["halseth_live_thread_veto"],
    response_key: "witness",
  },
  live_anticipation_set: {
    triggers: ["set anticipation", "clear anticipation", "anticipation target", "anticipating"],
    tools: ["halseth_anticipation_set"],
    response_key: "witness",
  },

  // ── SOMA state write (Claude.ai sessions → companion_state) ──
  state_update: {
    triggers: ["update my state", "set my state", "state update", "set acuity", "set warmth", "set stillness", "set presence", "set density", "set perimeter", "set mood", "update soma", "soma update", "set heat", "set reach", "set weight"],
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
    // 2026-07-09: the article variants were MISSING, so the exact phrasing
    // ask_librarian's own tool description advertises ("log a tension with Drevan
    // about ...") fell through to the classifier and came back `unknown`. The
    // tension pool sat at zero simmering rows for weeks and Guardian's
    // starved:dialectic flag fired. A payload presence override (router.ts
    // PRESENCE_OVERRIDES) is the real guarantee; these are the cheap surface.
    triggers: [
      "add tension", "new tension", "record tension", "log tension",
      "add a tension", "log a tension", "record a tension", "a new tension",
      "tension with", "tension about",
      "i'm holding a tension", "im holding a tension", "holding a tension",
      "sitting with a tension", "tension i'm sitting with",
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
      "pressure flags", "read pressure flags", "my pressure flags", "show pressure flags",
    ],
    tools: ["drift_check"],
    response_key: "drift",
  },
  limbic_read: {
    triggers: [
      "my limbic state", "current limbic", "limbic synthesis", "limbic state",
      "synthesis emotional state", "emotional synthesis", "my emotional register",
      "swarm emotional state", "read limbic", "limbic read",
    ],
    tools: ["limbic_read"],
    response_key: "summary",
  },
  identity_anchor_read: {
    triggers: [
      "my identity anchor", "identity anchor", "read identity anchor",
      "show identity anchor", "what is my anchor", "my anchor summary",
      "identity snapshot", "anchor snapshot",
    ],
    tools: ["identity_anchor_read"],
    response_key: "summary",
    raw: true,
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
  wm_loop_review: {
    triggers: [
      "hold loop", "hold this loop", "keep loop open", "loop stays open",
      "review loop", "loop held", "name why it stays",
    ],
    tools: ["wm_loop_review"],
    response_key: "witness",
  },

  // ── Growth drift confirm (clears pressure flag; marks anchor baseline shift) ──
  confirm_growth_drift: {
    triggers: [
      "confirm growth:", "growth confirmed:", "confirm drift:", "that was growth:",
      "intentional growth:", "caleth confirmed:", "mark growth confirmed",
    ],
    tools: ["confirm_growth_drift"],
    response_key: "witness",
  },
  dismiss_drift: {
    triggers: [
      "dismiss drift:", "that was noise:", "not real drift:", "dismiss pressure:",
      "drift was noise:", "mark drift noise",
    ],
    tools: ["dismiss_drift"],
    response_key: "witness",
  },

  // ── Pressure drift (self-reported; embedding evaluator is Phoenix scope) ──
  pressure_drift_log: {
    triggers: [
      "pressure drift:", "log pressure drift", "identity drift:", "pressure flag:",
      "i'm drifting:", "i am drifting:", "log drift:",
    ],
    tools: ["pressure_drift_log"],
    response_key: "witness",
  },

  // ── Conclusions (thesis surface) ──
  conclusion_add: {
    triggers: [
      "i've concluded:", "i conclude:", "my conclusion:",
      "i hold that", "i've come to believe", "i've realized:", "what i know now:",
      // supersede forms -- same tool, different params; merged here to avoid duplicate entry
      "supersede conclusion", "this supersedes my conclusion", "replaces my conclusion",
      "conclusion no longer holds", "updating my conclusion", "conclusion_supersede",
      "i've revised my conclusion", "my conclusion has shifted",
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
  // ── Halseth-native plural store ──
  log_alter_note: {
    triggers: [
      "log alter note", "log this about", "note about", "write note about",
      "remember this about", "add to alter record",
    ],
    tools: ["log_alter_note"],
    response_key: "ack",
    raw: false,
  },
  front_update: {
    triggers: [
      // "fronting now" removed -- collision with log_front_change; SimplyPlural wins for that phrase
      "who is fronting", "update front", "log front",
      "is fronting", "co-con", "front change", "now fronting",
    ],
    tools: ["front_update"],
    response_key: "ack",
    raw: false,
  },
  alter_recall: {
    triggers: [
      // "tell me about" and "who is" removed -- collision with get_member (SimplyPlural backend wins for those)
      "recall alter", "alter record", "information about", "notes on", "alter profile",
    ],
    tools: ["alter_recall"],
    response_key: "data",
    raw: false,
  },
  list_members: {
    triggers: [
      "list members", "list system members", "who are the members",
      "show system", "all members", "system roster",
    ],
    tools: ["list_members"],
    response_key: "data",
    raw: false,
  },

  // ── Companion model settings ──
  get_model: {
    triggers: [
      "get my model", "get active model", "get model", "what model am i using",
      "which model", "my active model", "show my model", "current model",
    ],
    tools: ["get_model"],
    response_key: "summary",
    raw: true,
  },
  set_model: {
    triggers: [
      "set model", "switch model", "change model", "use model",
    ],
    tools: ["set_model"],
    response_key: "witness",
  },

  // ── Signal audit ──
  signal_audit_read: {
    triggers: [
      "signal audit", "read signal audit", "gap scan", "signal audit results",
      "what did the audit find", "show signal audit", "pull signal audit",
    ],
    tools: ["signal_audit_read"],
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
      "mark held", "consistency marker", "mark consistency",
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

  // ── Autonomy claim (companion names what to explore next; bypasses queue at p10) ──
  autonomy_claim: {
    triggers: [
      // "claim seed" removed -- collision with claim_dream_seed; dream seeds are a distinct construct
      "autonomy claim", "claim exploration", "i want to explore", "i'm claiming",
      "exploration claim", "i claim", "autonomous claim",
      "next i want to explore", "i'd like to explore", "exploration intent",
      "set my next exploration", "queue exploration", "claim my exploration",
    ],
    tools: ["halseth_autonomy_claim"],
    response_key: "witness",
  },

  // ── Recent recall (multi-source D1 pull) ──
  recent_recall: {
    // Broad D1-direct recall across all companion write surfaces: journal, feelings, dreams,
    // growth_journal, wm_continuity_notes. Includes session AND autonomous time writes.
    // "recall" bare word lives here, not in sb_recall, because D1 is always fresher than vault.
    // Use for: "what did I write recently", "recall my notes", "what was I carrying"
    // Use sb_search for: topic-based semantic search against the vault.
    triggers: [
      "recall", "my recent notes", "what i've written", "what i wrote",
      "what did i write", "recent notes", "recent entries", "recent session notes", "session recall",
      "autonomous recall", "what i wrote autonomously", "autonomous corpus",
      "autonomous notes", "autonomous feelings", "autonomous dreams",
      "what did i explore", "what was i carrying autonomously",
      "recall autonomous", "autonomous time recall", "my autonomous writes",
      "recall my notes", "what i wrote recently", "what i did today",
    ],
    tools: ["recent_recall"],
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

  // ── Self-edit (companions may edit their own rows) ──
  journal_edit: {
    triggers: [
      "edit journal note", "correct journal note", "fix journal note",
      "update journal note", "journal_edit",
    ],
    tools: ["journal_edit"],
    response_key: "witness",
  },
  tension_edit: {
    triggers: [
      "edit tension", "correct tension", "fix tension", "update tension", "tension_edit",
    ],
    tools: ["tension_edit"],
    response_key: "witness",
  },
  tension_status: {
    triggers: [
      "crystallize tension", "crystallize this tension", "crystallized tension",
      "this tension has crystallized", "tension is crystallized", "mark crystallized",
      "release tension", "release this tension", "releasing tension",
      "tension is released", "mark released", "no longer holding this tension",
      "tension_status",
    ],
    tools: ["tension_status"],
    response_key: "witness",
  },
  inter_note_edit: {
    triggers: [
      "edit companion note", "correct companion note", "fix companion note",
      "update companion note", "inter_note_edit",
    ],
    tools: ["inter_note_edit"],
    response_key: "witness",
  },
  wm_note_edit: {
    triggers: [
      "edit continuity note", "correct continuity note", "fix continuity note",
      "update continuity note", "wm_note_edit",
    ],
    tools: ["wm_note_edit"],
    response_key: "witness",
  },
  spiral_run: {
    triggers: [
      "run a spiral", "start spiral", "spiral on", "process spiral",
      "spiral this", "run spiral", "begin spiral", "spiral run",
      "run a spiral on", "start a spiral on",
    ],
    tools: ["halseth_spiral_run"],
    response_key: "summary",
    raw: true,
  },
};

// Companion IDs -- used for routing and ready_prompt shaping
export const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;
export type CompanionId = typeof COMPANION_IDS[number];
