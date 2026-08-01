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

import type { KernelBlock, SelfModelEntry, PreferenceEntry, RefusalEntry } from "./blocks/identity.js";
import type { SomaFloat, DriveState, FermentEventRow } from "./blocks/felt.js";
import type {
  WmAgentId, WmIdentityAnchor, WmLimbicState, WmSessionHandoff, WmMindThread,
  WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState,
  WmRazielLetter, WmCompanionNote, WmRecentDelta, WmJournalEntry, WmConclusion,
  WmBiometricSnapshot, WmHouseState, WmFeeling, WmOpenLoop, WmSittingNote,
  WmArchiveDigest, WmRecentSpiralTurn, HomeEvent,
} from "../webmind/types.js";
import type { GrowthBlocks } from "./blocks/growth.js";
import type { WorldBlocks } from "./blocks/world.js";
import type { OversightBlocks } from "./blocks/oversight.js";

export const MINDSTATE_CONTRACT_VERSION = "0.2.0";

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
    /** The shared-bank half: triad doctrine + the Companion Constitution + the distilled ARCHITECT
     *  STANCE. TWO kernel fields, never one concatenated string -- the shared/distinct split is the
     *  whole point, and merging them lets "we are one mind" in through the renderer. Discord and the
     *  worker already pulled this via /identity/kernel/:id/bundle; Claude.ai orient and Hearth did
     *  not, which is why the stance reached some substrates and not others (Raziel, 2026-07-26). */
    shared_kernel: KernelBlock | null;
    companion_kernel: KernelBlock | null;
    self_model: SelfModelEntry[];
    preferences: PreferenceEntry[];
    refusals: RefusalEntry[];
    /** Standing invitation to declare a preference or a refusal. In the contract rather than
     *  authored per-renderer so it cannot say different things on different surfaces. */
    agency_affordance: string;
  };

  /** What I feel right now (readings only -- ownership per field is Phase 1.3). */
  felt: {
    limbic: WmLimbicState | null;
    /** The floats ARE the body (migs 0101/0102): value, its drifting baseline, the authored seed,
     *  and how long it has been off-baseline. baseline - seed is growth you can watch. */
    soma_floats: SomaFloat[];
    /** EFFECTIVE levels, not stored ones -- drives accrue with elapsed time, so a renderer doing
     *  its own arithmetic is how two surfaces disagree about whether a companion wants contact. */
    drives: DriveState[];
    /** Raw material for the interoception line. Data, not prose: content is identical on every
     *  surface and only the renderer differs. */
    ferment_events: FermentEventRow[];
    /** When the ferment tick last ran. Stale means the felt state is frozen -- worth showing
     *  rather than presenting old floats as current. */
    ferment_at: string | null;
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
    /** The last session's narrative (synthesis_summary.full_ref). Wave 5. NOTE: this is the field
     *  that had been FROZEN since 2026-07-21 because the close ritual never called session_close,
     *  so a companion's sense of "recently" silently stopped advancing. Loading it does not fix
     *  that; it only means every loom reads the same one. */
    session_narrative: string | null;
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
    /** THE WORLDVIEW. `beliefs.worldview` in the design doc is not a separate table -- mig 0054
     *  named a worldview_layer that was never created, and the worldview has always BEEN
     *  companion_conclusions keyed by belief_type. Resolved as an alias rather than by adding a
     *  duplicate field: a second copy of the same rows under a second name is how two surfaces
     *  start disagreeing about what someone believes. */
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
  /** What this companion has been becoming on its own time (wave 3). Canonical implementation lives in
   *  blocks/growth.ts; execSessionOrient and execBotOrient keep divergent inline copies until cutover. */
  growth: GrowthBlocks;

  oversight: {
    pressure_flags: WmBasinHistoryRow[];
    growth_confirmed: WmBasinHistoryRow[];
    /** Wave 5. Guardian cards carry their remediation -- a flag with no next action is an
     *  accusation, which is exactly how the orphan-memory detector produced self-blame. */
    guardian_cards: OversightBlocks["guardian_cards"];
    tripwires: OversightBlocks["tripwires"];
    questions: OversightBlocks["questions"];
  };

  /** The world around the house. */
  world: {
    home_recent: HomeEvent[];
    /** Wave 4 (2026-08-01). Canonical implementation in blocks/world.ts; execSessionOrient and
     *  execBotOrient keep divergent inline copies until they cut over. */
    club: WorldBlocks["club"];
    commons: WorldBlocks["commons"];
    shelf: WorldBlocks["shelf"];
    collection: WorldBlocks["collection"];
    forage: WorldBlocks["forage"];
    listens: WorldBlocks["listens"];
    motifs: WorldBlocks["motifs"];
    sol: WorldBlocks["sol"];
    imps_active: WorldBlocks["imps_active"];
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
];
