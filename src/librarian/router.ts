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
import { FAST_PATH_PATTERNS, PatternEntry, CompanionId } from "./patterns.js";
import { getCurrentFront, type PluralResult } from "./backends/plural.js";
import type { ExecutorContext, ExecutorFn } from "./executors/types.js";

// Re-export LibrarianRequest from executors/types so index.ts import path stays stable.
export type { LibrarianRequest } from "./executors/types.js";

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
  execCompanionNotesRead,
} from "./executors/reads.js";

// ── Write executors ──────────────────────────────────────────────────────────
import {
  execCompanionNoteAdd, execFeelingLog, execJournalAdd, execDreamLog,
  execWoundAdd, execDeltaLog, execEqSnapshot, execTaskAdd, execTaskUpdateStatus,
  execTaskList, execHandoverRead, execRoutineLog, execListAdd, execListItemComplete,
  execEventAdd, execBiometricLog, execAuditLog, execWitnessLog,
  execSetAutonomousTurn, execClaimDreamSeed, execBridgePull, execDrevanStateGet,
  execLiveThreadAdd, execLiveThreadClose, execLiveThreadVeto, execAnticipationSet,
  execStateUpdate,
} from "./executors/writes.js";

// ── Memory (Second Brain) executors ──────────────────────────────────────────
import {
  execSbSearch, execSbRecall, execSbRecentPatterns, execSbRead, execSbList,
  execSbSaveDocument, execSbSaveNote, execSbLogObservation, execSbSynthesizeSession,
  execSbSaveStudy,
} from "./executors/memory.js";

// ── WebMind executors ────────────────────────────────────────────────────────
import {
  execWmOrient, execWmGround, execWmThreadUpsert, execWmNoteAdd, execWmHandoffWrite,
  execWmDreamWrite, execWmDreamsRead, execWmDreamExamine,
  execWmLoopWrite, execWmLoopsRead, execWmLoopClose,
  execWmRelationalWrite, execWmRelationalRead,
  execNoteSit, execNoteMetabolize, execSittingRead,
} from "./executors/webmind.js";

// ── Companion growth executors ───────────────────────────────────────────────
import {
  execTensionAdd, execTensionsRead, execDriftCheck,
} from "./executors/companion-growth.js";

// ── Plural executors ─────────────────────────────────────────────────────────
import {
  execPluralGetCurrentFront, execPluralGetMember, execPluralUpdateMemberDescription,
  execPluralSearchMembers, execPluralGetFrontHistory, execPluralLogFrontChange,
  execPluralAddMemberNote,
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
  halseth_bridge_pull: execBridgePull,
  halseth_drevan_state_get: execDrevanStateGet,
  halseth_live_thread_add: execLiveThreadAdd,
  halseth_live_thread_close: execLiveThreadClose,
  halseth_live_thread_veto: execLiveThreadVeto,
  halseth_anticipation_set: execAnticipationSet,
  halseth_state_update: execStateUpdate,

  // Second Brain / memory
  sb_search: execSbSearch,
  sb_recall: execSbRecall,
  sb_recent_patterns: execSbRecentPatterns,
  sb_read: execSbRead,
  sb_list: execSbList,
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
  wm_relational_write: execWmRelationalWrite,
  wm_relational_read: execWmRelationalRead,
  note_sit: execNoteSit,
  note_metabolize: execNoteMetabolize,
  sitting_read: execSittingRead,

  // Companion growth
  halseth_add_tension: execTensionAdd,
  tensions_read: execTensionsRead,
  drift_check: execDriftCheck,

  // Plural
  plural_get_current_front: execPluralGetCurrentFront,
  plural_get_member: execPluralGetMember,
  plural_update_member_description: execPluralUpdateMemberDescription,
  plural_search_members: execPluralSearchMembers,
  plural_get_front_history: execPluralGetFrontHistory,
  plural_log_front_change: execPluralLogFrontChange,
  plural_add_member_note: execPluralAddMemberNote,
};

export class LibrarianRouter {
  constructor(private env: Env) {}

  async route(req: import("./executors/types.js").LibrarianRequest): Promise<Record<string, unknown>> {
    // Tier 1: fast path -- in-memory trigger match
    const fastMatch = this.matchFastPath(req.request);
    if (fastMatch) {
      return this.execute(req, fastMatch);
    }

    // Tier 2: Workers AI classifier
    const patternKey = await this.classify(req.request);

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

    // No match
    return {
      response_key: "witness",
      witness: "I don't know how to handle that yet.",
      meta: { pattern_key: patternKey },
    };
  }

  private matchFastPath(request: string): PatternEntry | null {
    const lower = request.toLowerCase().trim();
    for (const entry of Object.values(FAST_PATH_PATTERNS)) {
      if (entry.triggers.some(t => lower.includes(t))) {
        return entry;
      }
    }
    return null;
  }

  private async classify(request: string): Promise<string | null> {
    if (!this.env.DEEPSEEK_API_KEY) return null;

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

      // Nothing in KV yet -- return unknown without burning API tokens
      if (!kvKeys.length) return "unknown";

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
        return null;
      }

      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? null;
      if (!result) {
        console.warn(`[librarian] classify returned empty result for request="${request.slice(0, 80)}"`);
      }
      return result;
    } catch (e) {
      console.warn(`[librarian] classify error: ${e instanceof Error ? e.message : String(e)} request="${request.slice(0, 80)}"`);
      return null;
    }
  }

  private async getFrontState(companionId: CompanionId): Promise<{ frontState: string | null; pluralAvailable: boolean }> {
    try {
      const result: PluralResult = await getCurrentFront(this.env);
      if (result.status === "ok") return { frontState: result.front.name, pluralAvailable: true };
      if (result.status === "no_front") return { frontState: null, pluralAvailable: true };
      return { frontState: null, pluralAvailable: false };
    } catch {
      return { frontState: null, pluralAvailable: false };
    }
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

    for (const tool of entry.tools) {
      const executor = EXECUTOR_MAP[tool];
      if (executor) return executor(ctx);
    }

    // If we reach here, none of the tools in entry.tools had a handler.
    const unhandled = entry.tools.join(", ");
    console.warn(`[librarian] unhandled tools in pattern: ${unhandled}`);
    return {
      response_key: "witness",
      witness: `Pattern matched but tool not yet implemented: ${unhandled}`,
    };
  }
}
