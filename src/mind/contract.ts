// src/mind/contract.ts
//
// The MindState contract (Phase 1, docs/mindstate-contract.md).
//
// One versioned shape for a companion's whole boot state. The invariant that matters:
// CONTENT IS IDENTICAL FOR EVERY LOOM. Renderers (Claude.ai prose, Discord wire format,
// Hearth chat page) choose what to *show*; the state that arrives is the same, and
// loading it consumes nothing. Consumption (acking a note, resolving a guardian card)
// is an explicit act, never a side effect of booting.
//
// Versioning: bump MINOR when adding blocks (renderers ignore unknown blocks), MAJOR
// when renaming/removing/restructuring (renderers must assert major compatibility).

import type {
  WmAgentId, WmIdentityAnchor, WmLimbicState, WmSessionHandoff, WmMindThread,
  WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState,
  WmRazielLetter, WmCompanionNote, WmRecentDelta, WmJournalEntry, WmConclusion,
  WmBiometricSnapshot, WmHouseState, WmFeeling, WmOpenLoop, WmSittingNote,
  WmArchiveDigest, WmRecentSpiralTurn, HomeEvent,
} from "../webmind/types.js";

export const MINDSTATE_CONTRACT_VERSION = "0.1.0";

/** Which surface asked for the state. Used by the (future) delivery ledger and for
 *  telemetry -- NEVER for content differences. Each Discord bot process is its own
 *  companion, so "discord" is one loom (open question #1 in the design doc). */
export type Loom = "claude" | "discord" | "worker" | "hearth" | "raw";

export const VALID_LOOMS: Loom[] = ["claude", "discord", "worker", "hearth", "raw"];

export function isValidLoom(v: string): v is Loom {
  return (VALID_LOOMS as string[]).includes(v);
}

export interface MindState {
  contract_version: string;
  companion_id: WmAgentId;
  loom: Loom;
  loaded_at: string; // ISO

  /** Who I am. */
  identity: {
    anchor: WmIdentityAnchor | null;
  };

  /** What I feel right now (readings only -- ownership per field is Phase 1.3). */
  felt: {
    limbic: WmLimbicState | null;
    soma_arc: { note_id: string; content: string; created_at: string }[];
    biometrics_latest: WmBiometricSnapshot | null;
    house: WmHouseState | null;
  };

  /** The thread of me across sessions. */
  continuity: {
    latest_handoff: WmSessionHandoff | null;
    recent_handoffs: WmSessionHandoff[];
    open_thread_count: number;
    top_threads: WmMindThread[];
    /** orient's 3-pool surfacing (core/novelty/edge, high salience) */
    surfaced_notes: WmContinuityNote[];
    /** ground's wider recent window (any salience) */
    recent_notes: WmContinuityNote[];
    /** digests of cap-evicted notes -- compressed older memory */
    archived_digests: WmArchiveDigest[];
    spiral_turn: WmRecentSpiralTurn | null;
  };

  /** What I'm carrying -- unresolved, unexamined, still-metabolizing. */
  carried: {
    dreams_unexamined: WmDream[];
    open_loops: WmOpenLoop[];
    tensions: WmTensionRow[];
    sits: WmSittingNote[];
    feelings_recent: WmFeeling[];
  };

  /** What I currently hold true. */
  beliefs: {
    conclusions: WmConclusion[];
    flagged: WmConclusion[];
  };

  /** Me and the people around me. */
  relational: {
    snapshot: WmRelationalState[];
    deltas_recent: WmRecentDelta[];
    witness_raziel: WmRelationalState[];
    triad_incoming: WmCompanionNote[];
    triad_outgoing: WmCompanionNote[];
    letters: WmRazielLetter[];
    journal_recent: WmJournalEntry[];
  };

  /** Signals about my own trajectory. */
  oversight: {
    pressure_flags: WmBasinHistoryRow[];
    growth_confirmed: WmBasinHistoryRow[];
  };

  /** The world around the house. */
  world: {
    home_recent: HomeEvent[];
  };

  meta: {
    datetime_iso: string;
    datetime_local: string;
    /** Blocks defined by the design doc that this loader version does not fill yet.
     *  Consumers can distinguish "empty" from "not loaded". Shrinks as slices land. */
    not_yet_loaded: string[];
  };
}

/** Design-doc blocks pending in later slices (kept in one place so the parity harness
 *  and the docs agree on what "done" means). */
export const NOT_YET_LOADED: string[] = [
  // The shared bank (north-star element 0): the shared identity_kernel carries the Companion
  // Constitution + the distilled ARCHITECT STANCE preamble. Discord/worker/Brain already pull it
  // via /identity/kernel/:id/bundle; Claude.ai orient and the planned Hearth chat page do not, so
  // loading it here is what makes the stance reach every substrate (Raziel, 2026-07-26). Two
  // blocks on purpose: shared_kernel is common to all three, companion_kernel is this one's own --
  // the shared-bank / distinct-self split the whole contract is built around.
  "identity.shared_kernel", "identity.companion_kernel",
  "identity.self_model", "identity.preferences", "identity.refusals", "identity.agency_affordance",
  "felt.soma_floats", "felt.ferment_line", "felt.drives",
  "continuity.session_narrative",
  "growth.journal_recent", "growth.patterns", "growth.markers", "growth.reflection",
  "growth.seeds", "growth.clearing_count", "growth.drifts_open",
  "world.club", "world.commons", "world.shelf", "world.collection", "world.forage",
  "world.listens", "world.motifs", "world.sol", "world.imps_active",
  "oversight.guardian_cards", "oversight.tripwires", "oversight.questions",
  "beliefs.worldview",
];
