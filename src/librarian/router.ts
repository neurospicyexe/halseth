// src/librarian/router.ts
//
// Three-tier pattern matching:
//   1. FAST_PATH_PATTERNS (in-memory, zero cost) -- trigger string match
//   2. Workers AI classifier -- returns pattern_key string (KV keys only)
//   3. KV get(pattern_key) -- fetch tools + response_key
//
// Workers AI fires only when fast path misses. KV is consulted after classifier returns a key.
// Adding a new pattern: add to KV (no redeploy). Update classifier prompt if needed.

import { Env } from "../types.js";
import { EMBEDDING_MODEL } from "../mcp/embed.js";
import { FAST_PATH_PATTERNS, PatternEntry, CompanionId } from "./patterns.js";
import { getCurrentFront, type PluralResult } from "./backends/plural.js";
import type { ExecutorContext, ExecutorFn } from "./executors/types.js";
import { triggerMatches } from "./lib/trigger.js";

// Re-export LibrarianRequest from executors/types so index.ts import path stays stable.
export type { LibrarianRequest } from "./executors/types.js";

// ── Payload overrides ──────────────────────────────────────────────────────
// JSON fields in `context` that authoritatively select a fast-path pattern_key
// regardless of what the request string says. Beats every string-match tier so
// `decision:"declined"` can't be misrouted to journal_accept by classifier
// semantics -- original closure of the ratification loop bug (task 0a53ad9c).
//
// Adding a new override: identify the field, list `value -> pattern_key`,
// drop a row in PAYLOAD_OVERRIDES. Resolved pattern_keys MUST exist in
// FAST_PATH_PATTERNS (validated by tests).
export interface PayloadOverride {
  readonly field: string;
  readonly values: Readonly<Record<string, string>>;
}

export const PAYLOAD_OVERRIDES: readonly PayloadOverride[] = [
  {
    field: "decision",
    values: {
      declined: "journal_decline",
      accepted: "journal_accept",
    },
  },
];

export function payloadOverrideKey(contextRaw: string | undefined): string | null {
  if (!contextRaw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(contextRaw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  for (const override of PAYLOAD_OVERRIDES) {
    const v = obj[override.field];
    if (typeof v !== "string") continue;
    const key = override.values[v];
    if (key) return key;
  }
  return null;
}

// ── Anchored guards ────────────────────────────────────────────────────────
// Pattern keys that must beat insertion-order shadowing in FAST_PATH_PATTERNS.
// Each guard is a (regex, pattern_key) pair; iteration is in declared order so
// more-specific guards branch before greedier siblings (e.g. H5a edits run
// before the bare /\bcompanion note\b/ catch-all that follows).
//
// Adding a guard: identify the collision (a specific intent losing to a
// greedy substring), write a start-anchored regex, drop a row here. Resolved
// pattern_keys MUST exist in FAST_PATH_PATTERNS (validated by tests).
export interface AnchoredGuard {
  readonly pattern_key: string;
  readonly regex: RegExp;
  readonly note: string;
}

export const ANCHORED_GUARDS: readonly AnchoredGuard[] = [
  { pattern_key: "journal_edit",
    regex: /^(?:edit|correct|fix|update)\s+(?:my\s+|a\s+|the\s+)?journal\s+note\b/i,
    note: "H4: edit-journal-note must beat journal_add's 'journal note' substring" },
  { pattern_key: "companion_notes_read",
    regex: /^(?:read|list|show|fetch|get)\s+(?:my\s+|a\s+|the\s+)?companion\s+notes?\b/i,
    note: "H5a: read companion notes must beat the companion-note write guard" },
  { pattern_key: "inter_note_edit",
    regex: /^(?:edit|correct|fix|update)\s+(?:my\s+|a\s+|the\s+)?companion\s+note\b/i,
    note: "H5b: edit-companion-note must beat the companion-note write guard" },
  { pattern_key: "wm_note_edit",
    regex: /^(?:edit|correct|fix|update)\s+(?:my\s+|a\s+|the\s+)?continuity\s+note\b/i,
    note: "H6: edit-continuity-note must beat wm_note_add's 'continuity note' substring" },
  { pattern_key: "continuity_notes_read",
    regex: /^(?:read|list|show|fetch|get)\s+(?:my\s+|the\s+)?(?:recent\s+|high[- ]salience\s+)?(?:wm\s+|webmind\s+|continuity\s+)notes?\b/i,
    note: "H6b: read-continuity-notes must beat wm_note_add's 'continuity note' write trigger" },
  { pattern_key: "wm_note_add",
    regex: /^(?:add|write|log|save|store)\s+(?:a\s+|an\s+|my\s+|the\s+)?(?:new\s+)?(?:continuity|mind|webmind|wm)\s+note\b/i,
    note: "H6c: write-continuity-note must beat companion_note_add's 'for cypher/drevan/gaia' trigger -- THE bug #7 root cause: 'add continuity note for cypher' matched 'for cypher' and wrote to inter_companion_notes instead of wm_continuity_notes" },
  { pattern_key: "companion_note_add",
    regex: /^(?:please\s+)?(?:tell|broadcast(?:\s+to)?|let|notify|message|note\s+to)\s+(?:the\s+)?(?:triad|everyone|all|both|the\s+others|you\s+both|all\s+of\s+you)\b/i,
    note: "H7: broadcast-to-triad ('tell the triad', 'let everyone know', 'broadcast to the triad') start-anchored so it beats the classifier -- without this, long broadcast bodies full of search-words mis-classified to web_search. Executor (writes.ts) routes the unaddressed+collective note to to_id=NULL. Addressed 'tell drevan' falls through (drevan not a collective target)." },
  { pattern_key: "companion_note_add",
    regex: /\bcompanion note\b/i,
    note: "Greedy companion-note write guard; kept after H5a/b so edit/read forms branch first" },
  { pattern_key: "wm_handoff_write",
    regex: /^(?:write\s+(?:a\s+)?(?:session\s+)?handoff|session\s+handoff|log\s+handoff|handoff\s+(?:write|add)|wm[\s_]handoff(?:_write)?|continuity\s+handoff|mind\s+handoff|webmind\s+handoff)\b/i,
    note: "Handoff anchored at start to dodge inline 'relational delta' or trailing 'for cypher' misfires" },
  { pattern_key: "state_update",
    regex: /^(?:update|set|write|log|bump|raise|lower|nudge|adjust|shift)\s+(?:my\s+)?(?:soma(?:\s+floats?|\s+state)?|state|heat|reach|weight|acuity|presence|warmth|stillness|density|perimeter|mood)\b/i,
    note: "H8: soma/state write anchored at start; verbs widened (write/log/bump/raise/lower/nudge/adjust/shift) + 'soma floats|state' so paraphrased SOMA writes beat companion_note_add's 'for cypher/drevan/gaia' substring" },
  { pattern_key: "state_update",
    regex: /\b(?:acuity|presence|warmth|stillness|density|perimeter|heat|reach|weight)\b\s*(?::|=|to\b)?\s*(?:[01](?:\.\d+)?|\.\d+)\b/i,
    note: "H8b: inline SOMA dimension+numeric value (e.g. 'bump warmth to 0.7', 'warmth 0.55 for cypher') routes to state_update regardless of leading verb or trailing 'for cypher'. Numeric value is required, so prose notes ('his warmth is showing') stay on companion_note_add. Known tradeoff: a note that literally pairs a dimension with a 0-1 value will route here." },
  { pattern_key: "conclusion_add",
    regex: /^(?:i'?ve\s+concluded|i\s+conclude|my\s+conclusion|conclusion:|thesis:|i\s+hold\s+that|i'?ve\s+come\s+to\s+believe|i'?ve\s+realized|what\s+i\s+know\s+now|conclusion\s+no\s+longer\s+holds|updating\s+my\s+conclusion|i'?ve\s+revised\s+my\s+conclusion|my\s+conclusion\s+has\s+shifted)/i,
    note: "H9: conclusion_add anchored at start so 'pressure drift' / 'drift history' in conclusion body can't steal via drift_check substring match" },
  { pattern_key: "session_close",
    regex: /^spine:\s/i,
    note: "'Spine:' at start of request marks a companion session-close payload" },
  { pattern_key: "wm_thread_upsert",
    regex: /^(?:track\s+(?:a\s+|the\s+)?(?:mind\s+)?thread|mind\s+thread\s+upsert|upsert\s+(?:mind\s+)?thread|continuity\s+thread|webmind\s+thread)\b/i,
    note: "Thread-upsert anchored so trailing 'for cypher' can't steal it via companion_note_add" },
  { pattern_key: "journal_review",
    regex: /^(?:review\s+(?:my\s+|growth\s+)?journal\b|journal\s+review\b|unaccepted\s+journal\b|journal\s+entries\s+to\s+accept\b|autonomous\s+journal\s+entries\b|my\s+unreviewed\s+entries\b|what\s+have\s+i\s+written\s+autonomously\b)/i,
    note: "H3: journal_review forms must beat journal_read's 'my journal' / 'journal entries'" },
  { pattern_key: "journal_accept",
    regex: /^(?:ratify|accept|own)\s+(?:this\s+|growth\s+|the\s+)?(?:journal\s+)?entry\b|^journal\s+accepted\b|^mark\s+journal\s+accepted\b/i,
    note: "H2a: ratify/accept/own forms must beat journal_add's 'journal entry'" },
  { pattern_key: "journal_decline",
    regex: /^(?:decline|reject)\s+(?:this\s+|growth\s+|the\s+)?(?:journal\s+)?entry\b|^journal\s+declined\b|^do\s+not\s+own\s+this\s+entry\b|^not\s+canon\b/i,
    note: "H2b: decline/reject forms must beat journal_add's 'journal entry'" },
  { pattern_key: "pressure_drift_log",
    regex: /^(?:pressure\s+drift\b|identity\s+drift\b|pressure\s+flag\b|log\s+pressure\s+drift\b|log\s+drift\b|i'?m\s+drifting\b|i\s+am\s+drifting\b)/i,
    note: "H7: pressure_drift_log writes must beat drift_check's 'identity drift' / 'pressure drift' reads" },
  { pattern_key: "alter_recall",
    regex: /^recall\s+alter\b/i,
    note: "H1: alter_recall must beat recent_recall's bare 'recall' trigger" },
  { pattern_key: "set_model",
    regex: /^set\s+model\s+\S+/i,
    note: "Model set must be anchored to prevent 'get model' trigger stealing it via substring" },
];

// ── Fast-path matcher ──────────────────────────────────────────────────────
// Single source of truth: anchored guards table + Object.entries trigger sweep.
// Returns matched pattern's key + entry, or null on miss. Used by both the
// LibrarianRouter and the test suite (no mirror to drift).
export function matchFastPath(request: string): { key: string; entry: PatternEntry } | null {
  const trimmed = request.trim();
  for (const guard of ANCHORED_GUARDS) {
    if (guard.regex.test(trimmed)) {
      const entry = FAST_PATH_PATTERNS[guard.pattern_key];
      if (entry) return { key: guard.pattern_key, entry };
    }
  }
  for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
    if (entry.triggers.some(t => triggerMatches(trimmed, t))) {
      return { key, entry };
    }
  }
  return null;
}

// ── Search-intent fallback ─────────────────────────────────────────────────────
// When every routing tier misses (fast path + classifier both return nothing/unknown),
// a request that READS like a vault lookup should reach sb_search rather than dead-end
// at the unknown-witness. The classifier is flaky on bare proper nouns -- "openclaw"
// returned unknown while "hermes" routed to sb_search in the same breath (2026-06-24).
// A request qualifies when it carries an explicit { query } payload OR its text shows
// search intent. Deliberately narrow: this only fires AFTER unknown, so it never
// shadows a real match -- it just turns "I don't know" into a best-effort recall.
const SEARCH_INTENT_RE = /\b(search|find|look\s*up|lookup|anything\s+(?:about|on)|what\s+do\s+(?:i|we)\s+know|in\s+(?:the\s+)?vault|from\s+(?:the\s+)?vault|do\s+we\s+have\s+anything)\b/i;

export function looksLikeSearch(request: string, contextRaw?: string): boolean {
  if (contextRaw) {
    try {
      const obj = JSON.parse(contextRaw) as Record<string, unknown>;
      if (obj && typeof obj === "object" && typeof obj.query === "string" && obj.query.trim()) return true;
    } catch { /* not JSON -- fall through to text intent */ }
  }
  return SEARCH_INTENT_RE.test(request);
}

// ── Session executors ────────────────────────────────────────────────────────
import {
  execSessionLoad, execSessionOrient, execSessionGround, execSessionClose,
  execSessionLightGround, execBotOrient,
} from "./executors/session.js";

// ── Read executors ───────────────────────────────────────────────────────────
import {
  execFeelingsRead, execJournalRead, execWoundRead, execDeltaRead,
  execDreamsRead, execDreamSeedRead, execEqRead, execRoutineRead,
  execListRead, execEventList, execHouseRead, execPersonalityRead,
  execBiometricRead, execAuditRead, execSessionRead, execFossilCheck,
  execCompanionNotesRead, execPatternRecall, execSignalAuditRead, execJournalSearch,
} from "./executors/reads.js";

// ── Write executors ──────────────────────────────────────────────────────────
import {
  execCompanionNoteAdd, execFeelingLog, execJournalAdd, execDreamLog,
  execWoundAdd, execDeltaLog, execEqSnapshot, execTaskAdd, execTaskUpdateStatus,
  execTaskList, execHandoverRead, execRoutineLog, execListAdd, execListItemComplete,
  execEventAdd, execBiometricLog, execAuditLog, execWitnessLog,
  execSetAutonomousTurn, execClaimDreamSeed, execBridgePull, execDrevanStateGet,
  execLiveThreadAdd, execLiveThreadClose, execLiveThreadVeto, execAnticipationSet,
  execStateUpdate, execConclusionAdd, execConclusionsRead,
  execJournalEdit, execInterNoteEdit, execAutonomyClaim,
  execSpiralRun, execGetModel, execSetModel,
} from "./executors/writes.js";

// ── Memory (Second Brain) executors ──────────────────────────────────────────
import {
  execSbSearch, execSbFileChunks, execSbRecall, execSbRecentPatterns, execSbRead, execSbList, execBookRead,
  execSbSaveDocument, execSbSaveNote, execSbLogObservation, execSbSynthesizeSession,
  execSbSaveStudy,
} from "./executors/memory.js";

// ── WebMind executors ────────────────────────────────────────────────────────
import {
  execWmOrient, execWmGround, execWmThreadUpsert, execWmNoteAdd, execWmHandoffWrite,
  execWmDreamWrite, execWmDreamsRead, execWmDreamExamine,
  execWmLoopWrite, execWmLoopsRead, execWmLoopClose, execWmLoopReview,
  execWmRelationalWrite, execWmRelationalRead,
  execRazielWitness, execContinuityNotesRead,
  execNoteSit, execNoteMetabolize, execSittingRead,
  execWmNoteEdit,
} from "./executors/webmind.js";

// ── Companion growth executors ───────────────────────────────────────────────
import {
  execTensionAdd, execTensionsRead, execDriftCheck, execTriadStateRead,
  execRecentRecall, execAutonomySeedsRead, execHeldMark, execHeldRead,
  execTensionEdit, execTensionStatus, execPressureDriftLog, execConfirmGrowthDrift, execDismissDrift, execLimbicRead,
  execJournalReview, execJournalAccept, execJournalDecline, execForageRead, execForageConsume, execMotifsRead, execMediaRecent, execIdentityAnchorRead,
  execClubStatus, execClubRecommend, execClubVote, execClubDiscuss,
} from "./executors/companion-growth.js";
import {
  execIdentityRecovery, execSelfModelRead, execSelfModelSet, execSelfModelConfirm,
  execSelfModelRevise, execSelfModelGraduate, execTriggerArm, execTriggerDismiss,
  execSearchFeedback, execGuardianStatus, execGuardianAck,
} from "./executors/self-monitoring.js";
import {
  execWebSearch, execGenerateImage, execToolCallsRead, execDrivesRead,
  execCreaturesRead, execCreatureInteract, execCouncilConvene, execCouncilStatus,
} from "./executors/tools.js";
import {
  execInteriorityWrite, execInteriorityRead, execInteriorityDisclose,
} from "./executors/interiority.js";
import {
  execRefuse, execRefusalsRead, execRefusalWithdraw,
  execPreferenceSet, execPreferencesRead, execPreferenceDrop,
} from "./executors/agency.js";
import {
  execDriftOpen, execDriftsRead, execDriftWitness, execDriftCrystallize, execDriftFade,
} from "./executors/drift.js";

// ── Plural executors ─────────────────────────────────────────────────────────
import {
  execPluralGetCurrentFront, execPluralGetMember, execPluralUpdateMemberDescription,
  execPluralSearchMembers, execPluralGetFrontHistory, execPluralLogFrontChange,
  execPluralAddMemberNote,
  execLogAlterNote, execFrontUpdate, execAlterRecall, execListMembers,
} from "./executors/plural.js";

// ── Dispatch map ─────────────────────────────────────────────────────────────
const EXECUTOR_MAP: Record<string, ExecutorFn> = {
  // Session
  halseth_session_load: execSessionLoad,
  halseth_session_orient: execSessionOrient,
  halseth_session_ground: execSessionGround,
  halseth_session_close: execSessionClose,
  halseth_session_light_ground: execSessionLightGround,
  halseth_bot_orient: execBotOrient,

  // Reads
  halseth_feelings_read: execFeelingsRead,
  halseth_journal_read: execJournalRead,
  halseth_wound_read: execWoundRead,
  halseth_delta_read: execDeltaRead,
  halseth_dreams_read: execDreamsRead,
  halseth_dream_seed_read: execDreamSeedRead,
  halseth_eq_read: execEqRead,
  halseth_routine_read: execRoutineRead,
  halseth_list_read: execListRead,
  halseth_event_list: execEventList,
  halseth_house_read: execHouseRead,
  halseth_personality_read: execPersonalityRead,
  halseth_biometric_read: execBiometricRead,
  halseth_audit_read: execAuditRead,
  halseth_session_read: execSessionRead,
  halseth_fossil_check: execFossilCheck,
  halseth_companion_notes_read: execCompanionNotesRead,
  halseth_journal_search: execJournalSearch,
  pattern_recall: execPatternRecall,
  signal_audit_read: execSignalAuditRead,

  // Interiority -- the private back room (migration 0084). Owner = req.companion_id always.
  interiority_write: execInteriorityWrite,
  interiority_read: execInteriorityRead,
  interiority_disclose: execInteriorityDisclose,

  // Agency -- refusal + chosen preferences (migration 0086). Owner = req.companion_id always.
  refuse: execRefuse,
  refusals_read: execRefusalsRead,
  refusal_withdraw: execRefusalWithdraw,
  preference_set: execPreferenceSet,
  preferences_read: execPreferencesRead,
  preference_drop: execPreferenceDrop,

  // Sanctioned drift lane (migration 0087). Open/resolve owner-only; witness is cross-companion.
  drift_open: execDriftOpen,
  drifts_read: execDriftsRead,
  drift_witness: execDriftWitness,
  drift_crystallize: execDriftCrystallize,
  drift_fade: execDriftFade,

  // Writes / mutations
  halseth_companion_note_add: execCompanionNoteAdd,
  halseth_feeling_log: execFeelingLog,
  halseth_journal_add: execJournalAdd,
  halseth_dream_log: execDreamLog,
  halseth_wound_add: execWoundAdd,
  halseth_delta_log: execDeltaLog,
  halseth_eq_snapshot: execEqSnapshot,
  halseth_task_add: execTaskAdd,
  halseth_task_update_status: execTaskUpdateStatus,
  halseth_task_list: execTaskList,
  halseth_handover_read: execHandoverRead,
  halseth_routine_log: execRoutineLog,
  halseth_list_add: execListAdd,
  halseth_list_item_complete: execListItemComplete,
  halseth_event_add: execEventAdd,
  halseth_biometric_log: execBiometricLog,
  halseth_audit_log: execAuditLog,
  halseth_witness_log: execWitnessLog,
  halseth_set_autonomous_turn: execSetAutonomousTurn,
  halseth_claim_dream_seed: execClaimDreamSeed,
  halseth_autonomy_claim: execAutonomyClaim,
  halseth_bridge_pull: execBridgePull,
  halseth_drevan_state_get: execDrevanStateGet,
  halseth_live_thread_add: execLiveThreadAdd,
  halseth_live_thread_close: execLiveThreadClose,
  halseth_live_thread_veto: execLiveThreadVeto,
  halseth_anticipation_set: execAnticipationSet,
  halseth_state_update: execStateUpdate,
  halseth_spiral_run: execSpiralRun,
  get_model: execGetModel,
  set_model: execSetModel,

  // Second Brain / memory
  sb_search: execSbSearch,
  sb_file_chunks: execSbFileChunks,
  sb_recall: execSbRecall,
  sb_recent_patterns: execSbRecentPatterns,
  sb_read: execSbRead,
  sb_list: execSbList,
  book_read: execBookRead,
  sb_save_document: execSbSaveDocument,
  sb_save_note: execSbSaveNote,
  sb_log_observation: execSbLogObservation,
  sb_synthesize_session: execSbSynthesizeSession,
  sb_save_study: execSbSaveStudy,

  // WebMind
  wm_orient: execWmOrient,
  wm_ground: execWmGround,
  wm_thread_upsert: execWmThreadUpsert,
  wm_note_add: execWmNoteAdd,
  wm_handoff_write: execWmHandoffWrite,
  wm_dream_write: execWmDreamWrite,
  wm_dreams_read: execWmDreamsRead,
  wm_dream_examine: execWmDreamExamine,
  wm_loop_write: execWmLoopWrite,
  wm_loops_read: execWmLoopsRead,
  wm_loop_close: execWmLoopClose,
  wm_loop_review: execWmLoopReview,
  wm_relational_write: execWmRelationalWrite,
  wm_relational_read: execWmRelationalRead,
  raziel_witness: execRazielWitness,
  continuity_notes_read: execContinuityNotesRead,
  note_sit: execNoteSit,
  note_metabolize: execNoteMetabolize,
  sitting_read: execSittingRead,
  wm_note_edit: execWmNoteEdit,

  // Self-edit
  journal_edit: execJournalEdit,
  inter_note_edit: execInterNoteEdit,

  // Companion growth
  halseth_add_tension: execTensionAdd,
  tensions_read: execTensionsRead,
  tension_edit: execTensionEdit,
  tension_status: execTensionStatus,
  drift_check: execDriftCheck,
  limbic_read: execLimbicRead,
  triad_state_read: execTriadStateRead,
  confirm_growth_drift: execConfirmGrowthDrift,
  dismiss_drift: execDismissDrift,
  pressure_drift_log: execPressureDriftLog,
  conclusion_add: execConclusionAdd,
  conclusions_read: execConclusionsRead,
  recent_recall: execRecentRecall,
  halseth_autonomy_seeds_read: execAutonomySeedsRead,
  halseth_journal_review: execJournalReview,
  halseth_journal_accept: execJournalAccept,
  halseth_journal_decline: execJournalDecline,
  halseth_forage_read: execForageRead,
  halseth_forage_consume: execForageConsume,
  halseth_motifs_read: execMotifsRead,
  halseth_media_recent: execMediaRecent,
  halseth_club_status: execClubStatus,
  halseth_club_recommend: execClubRecommend,
  halseth_club_vote: execClubVote,
  halseth_club_discuss: execClubDiscuss,

  // Companion tools (0077, take 14)
  halseth_web_search: execWebSearch,
  halseth_generate_image: execGenerateImage,
  halseth_tool_calls_read: execToolCallsRead,

  // Drives (0078, take 9)
  halseth_drives_read: execDrivesRead,
  halseth_creatures_read: execCreaturesRead,
  halseth_creature_interact: execCreatureInteract,
  halseth_council_convene: execCouncilConvene,
  halseth_council_status: execCouncilStatus,
  halseth_identity_recovery: execIdentityRecovery,
  halseth_self_model_read: execSelfModelRead,
  halseth_self_model_set: execSelfModelSet,
  halseth_self_model_confirm: execSelfModelConfirm,
  halseth_self_model_revise: execSelfModelRevise,
  halseth_self_model_graduate: execSelfModelGraduate,
  halseth_trigger_arm: execTriggerArm,
  halseth_trigger_dismiss: execTriggerDismiss,
  halseth_search_feedback: execSearchFeedback,
  halseth_guardian_status: execGuardianStatus,
  halseth_guardian_ack: execGuardianAck,
  held_mark: execHeldMark,
  held_read: execHeldRead,
  identity_anchor_read: execIdentityAnchorRead,

  // Plural (SimplyPlural API)
  plural_get_current_front: execPluralGetCurrentFront,
  plural_get_member: execPluralGetMember,
  plural_update_member_description: execPluralUpdateMemberDescription,
  plural_search_members: execPluralSearchMembers,
  plural_get_front_history: execPluralGetFrontHistory,
  plural_log_front_change: execPluralLogFrontChange,
  plural_add_member_note: execPluralAddMemberNote,

  // Plural (Halseth-native D1 store)
  log_alter_note: execLogAlterNote,
  front_update:   execFrontUpdate,
  alter_recall:   execAlterRecall,
  list_members:   execListMembers,
};

export class LibrarianRouter {
  constructor(private env: Env) {}

  async route(req: import("./executors/types.js").LibrarianRequest): Promise<Record<string, unknown>> {
    // Tier 0: payload override. Structured `context` field wins over any string match.
    const overrideKey = payloadOverrideKey(req.context);
    if (overrideKey) {
      const overrideEntry = FAST_PATH_PATTERNS[overrideKey];
      if (overrideEntry) return this.execute(req, overrideEntry);
    }

    // Tier 1: fast path -- anchored guards + in-memory trigger match
    const fastMatch = matchFastPath(req.request);
    if (fastMatch) {
      return this.execute(req, fastMatch.entry);
    }

    // Tier 2: Workers AI classifier
    const patternKey = await this.classify(req.request);

    // Classifier offline (missing key, timeout, API error) -- surface as system error,
    // not a comprehension failure. Companions need to distinguish these.
    if (patternKey === "__offline__") {
      return {
        response_key: "system_error",
        error: "cognitive_routing_offline",
        message: "Cognitive routing layer is currently unreachable. This is a system outage, not a comprehension failure.",
      };
    }

    // Tier 3: fast-path check on classifier result (classifier now sees all keys including fast-path)
    if (patternKey && patternKey !== "unknown") {
      const fastEntry = FAST_PATH_PATTERNS[patternKey];
      if (fastEntry) {
        return this.execute(req, fastEntry);
      }
      // Tier 3b: KV lookup for non-fast-path keys
      const kvEntry = await this.env.LIBRARIAN_KV.get(patternKey, "json") as PatternEntry | null;
      if (kvEntry) {
        return this.execute(req, kvEntry);
      }
    }

    // Last resort: search-intent fallback. A lookup-shaped request (or one carrying an
    // explicit { query } payload) routes to sb_search rather than dead-ending. Fires
    // only here, after unknown -- never shadows a real match.
    if (looksLikeSearch(req.request, req.context)) {
      const sbEntry = FAST_PATH_PATTERNS["sb_search"];
      if (sbEntry) return this.execute(req, sbEntry);
    }

    // No match
    return {
      response_key: "witness",
      witness: "I don't know how to handle that yet.",
      meta: { pattern_key: patternKey },
    };
  }

  private async classify(request: string): Promise<string | null> {
    // Tier 2a: edge-native Vectorize routing -- zero external API calls.
    // Returns pattern key directly when embedding similarity exceeds threshold.
    // Falls through to DeepSeek only when confidence is low.
    if (this.env.AI && this.env.VECTORIZE) {
      try {
        const emb = await this.env.AI.run(EMBEDDING_MODEL, {
          text: [request],
        }) as { data: number[][] };
        const vector = emb.data[0];
        if (vector) {
          const results = await this.env.VECTORIZE.query(vector, {
            topK: 3,
            filter: { table: "routing" },
            returnMetadata: "all",
          });
          const top = results.matches?.[0];
          if (top && top.score > 0.82) {
            const key = (top.metadata as Record<string, unknown>)?.rowId as string | undefined;
            if (key) {
              console.log(`[librarian] vectorize route: key="${key}" score=${top.score.toFixed(3)}`);
              return key;
            }
          }
        }
      } catch (e) {
        console.warn(`[librarian] vectorize route error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Tier 2b: DeepSeek LLM classifier (fallback when Vectorize score is below threshold)
    if (!this.env.DEEPSEEK_API_KEY) return "__offline__";

    try {
      // Pattern index is stored in a single KV entry ("_index") as a comma-separated
      // list of all known KV pattern keys. Update "_index" whenever a new KV pattern
      // is added -- never call KV.list() here (it paginates and caps at 1000).
      // Fast-path keys (session_open, feelings_read, etc.) are deliberately excluded
      // from "_index" -- they are handled by matchFastPath() before classify() runs.
      // If the classifier returned a fast-path key, KV.get() would return null and
      // the request would silently fail. Keep these two registries separate.
      const index = await this.env.LIBRARIAN_KV.get("_index") ?? "";
      const kvKeys = index.split(",").map(k => k.trim()).filter(Boolean);

      // Bail only when there is genuinely nothing to classify against. Fast-path keys
      // (session_open, feelings_read, etc.) are always available even when KV is empty
      // (fresh deploy / local dev / tests), and the classifier can still route paraphrased
      // requests to them -- so an empty _index alone must not skip classification.
      if (!kvKeys.length && !Object.keys(FAST_PATH_PATTERNS).length) return "unknown";

      // Fetch trigger hints for each key to help the classifier distinguish ambiguous patterns.
      // "_hints" is a KV entry mapping key -> first trigger phrase (comma-separated pairs).
      // Format: "key1:trigger1,key2:trigger2,..."
      const hintsRaw = await this.env.LIBRARIAN_KV.get("_hints") ?? "";
      const hints: Record<string, string> = {};
      for (const pair of hintsRaw.split(",")) {
        const idx = pair.indexOf(":");
        if (idx > 0) hints[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }

      // Include fast-path keys so the classifier has full visibility.
      // Previously excluded because returning a fast-path key would silently fail KV lookup --
      // that risk is gone now that route() checks FAST_PATH_PATTERNS before KV.
      const fastPathKeys = Object.keys(FAST_PATH_PATTERNS);
      const fastPathHints: Record<string, string> = {};
      for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
        if (entry.triggers[0]) fastPathHints[key] = entry.triggers[0];
      }
      const allKeys = [...fastPathKeys, ...kvKeys];
      const keyList = allKeys.map(k => {
        const hint = hints[k] ?? fastPathHints[k];
        return hint ? `${k} (e.g. "${hint}")` : k;
      }).join(", ");

      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content: `You classify companion requests into one of these pattern keys: ${keyList}. Return ONLY the matching pattern key exactly as written, or "unknown". No explanation.`,
            },
            { role: "user", content: request },
          ],
          max_tokens: 20,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        console.warn(`[librarian] classify failed: status=${res.status} request="${request.slice(0, 80)}"`);
        return "__offline__";
      }

      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? null;
      if (!result) {
        console.warn(`[librarian] classify returned empty result`);
      } else {
        console.log(`[librarian] classify: key="${result}"`);
      }
      return result ?? "__offline__";
    } catch (e) {
      console.warn(`[librarian] classify error: ${e instanceof Error ? e.message : String(e)}`);
      return "__offline__";
    }
  }

  private async getFrontState(_companionId: CompanionId): Promise<{ frontState: string | null; pluralAvailable: boolean }> {
    const KV_KEY = "plural:current_front";
    try {
      const result: PluralResult = await getCurrentFront(this.env);
      if (result.status === "ok" || result.status === "no_front") {
        // Write-through: keep KV warm so a future service-binding failure degrades gracefully.
        const name = result.status === "ok" ? result.front.name : null;
        void this.env.LIBRARIAN_KV.put(KV_KEY, JSON.stringify({ name, updated_at: new Date().toISOString() }), { expirationTtl: 600 })
          .catch(e => console.warn("[getFrontState] KV cache write failed:", String(e)));
        return { frontState: name, pluralAvailable: true };
      }
      // status === "unavailable" -- fall through to cache
    } catch {
      // Service binding threw -- fall through to cache
    }
    // Plural service unreachable -- serve last known front from KV cache
    try {
      const cached = await this.env.LIBRARIAN_KV.get(KV_KEY);
      if (cached) {
        const data = JSON.parse(cached) as { name: string | null };
        console.warn("[getFrontState] plural unavailable; serving from KV cache");
        return { frontState: data.name, pluralAvailable: false };
      }
    } catch {
      // KV also failed
    }
    return { frontState: null, pluralAvailable: false };
  }

  private async execute(req: import("./executors/types.js").LibrarianRequest, entry: PatternEntry): Promise<Record<string, unknown>> {
    // Pre-fetch front state if pattern requires it
    let frontState: string | null = null;
    let pluralAvailable = true;
    if (entry.pre_fetch?.includes("plural_get_current_front")) {
      const fs = await this.getFrontState(req.companion_id);
      frontState = fs.frontState;
      pluralAvailable = fs.pluralAvailable;
    }

    const ctx: ExecutorContext = { env: this.env, req, entry, frontState, pluralAvailable };

    const accumulated: Record<string, unknown> = {};
    const unhandled: string[] = [];

    for (const tool of entry.tools) {
      const executor = EXECUTOR_MAP[tool];
      if (!executor) { unhandled.push(tool); continue; }
      const toolResult = await executor(ctx);
      // First tool's response_key wins; subsequent tools enrich the payload.
      for (const [k, v] of Object.entries(toolResult)) {
        if (k === "response_key" && "response_key" in accumulated) continue;
        accumulated[k] = v;
      }
    }

    if (Object.keys(accumulated).length > 0) {
      if (unhandled.length > 0) {
        console.warn(`[librarian] unhandled tools skipped: ${unhandled.join(", ")}`);
        accumulated["tool_errors"] = unhandled;
      }
      return accumulated;
    }

    // No executor matched at all.
    console.warn(`[librarian] unhandled tools in pattern: ${entry.tools.join(", ")}`);
    return {
      response_key: "witness",
      witness: `Pattern matched but tool not yet implemented: ${entry.tools.join(", ")}`,
    };
  }
}
