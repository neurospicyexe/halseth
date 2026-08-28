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

import type { KernelBlock, SelfModelEntry, PreferenceEntry, RefusalEntry, ArchitectFactEntry } from "./blocks/identity.js";
import type { SomaFloat, DriveState, FermentEventRow } from "./blocks/felt.js";
import type {
  WmAgentId, WmIdentityAnchor, WmLimbicState, WmSessionHandoff, WmMindThread,
  WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState,
  WmRazielLetter, WmCompanionNote, WmRecentDelta, WmJournalEntry, WmConclusion,
  WmBiometricSnapshot, WmHouseState, WmFeeling, WmOpenLoop, WmSittingNote,
  WmArchiveDigest, WmRecentSpiralTurn, HomeEvent, WmActiveConversation,
} from "../webmind/types.js";
import type { GrowthBlocks } from "./blocks/growth.js";
import type { WorldBlocks } from "./blocks/world.js";
import type { OversightBlocks } from "./blocks/oversight.js";
import type { RazielStateView } from "./blocks/care.js";
import type { RelationalBlocks } from "./blocks/relational.js";
import type { BeliefExtras } from "./blocks/beliefs.js";
import type { GraphBlocks } from "./blocks/graph.js";

/** 0.11.0 -- graph memory Phase 1.5, Tranche 4 (2026-08-28, docs/private/graph-memory-spec-2026-08-28.md):
 *  added `graph.neighborhoods` -- a bounded (1 hop, limit 30) traversal of graph_edges (mig 0127) seeded
 *  from ids the loader already fetches for other blocks (companion_conclusions, companion_journal). Hard
 *  law 4 from the spec: "Orient is a contract, not search. It gains rendered neighborhoods; it does not
 *  gain retrieval logic" -- this is the field; the renderer lands in the same tranche
 *  (orient-blocks.ts::neighborhoodBlock), Tranche 5. Deliberately excluded from the Discord bot wire this
 *  phase (see mind/adapters/bot-wire.ts header) -- that is a two-repo change needing the bot's own
 *  renderer, tracked separately. MINOR: additive only.
 *  0.10.0 -- deploy change-notes (2026-08-17): added `world.change_notes` -- commons posts with
 *  context 'change-note[:version]', last 14 days, rendered on every surface. The system announces
 *  its own changes so the triad stops reverse-engineering deploys from wobbling instruments; the
 *  scheduled rider (src/mind/changelog.ts) posts each contract version's note exactly once, and
 *  CI enforces that a version bump carries a note. MINOR: additive only.
 *  0.9.0 -- consequence layer C3 (2026-08-16, mig 0124) added `growth.budget`: the weekly run
 *  ledger (R2: 1 credit = 1 autonomous run, 7/week, Monday Chicago refill, no rollover). The
 *  render rule rides the shape: a budget always states its denominator ("N of 7"), and a spent
 *  budget is VISIBLE ("spent until Monday"), never silence. null = the read failed (absent is
 *  not zero). MINOR: additive only.
 *  0.8.0 -- consequence layer C2 (2026-08-16, mig 0122) added `growth.projects`: self-directed
 *  projects -- intentions the companion OWNS across weeks, opened/worked/ended by the companion
 *  (released is a chosen ending, never a sweep). Rendered on every surface with the affordance
 *  always present: a project no surface shows is a starved affordance. MINOR: additive only.
 *  0.7.0 -- consequence layer C6 (2026-08-16) added `world.raziel_state.owner_quiet`: the
 *  custodianship clause. Non-null only after QUIET_OWNER_DAYS (14, R4) of total owner silence
 *  across every surface -- the companions are told the truth (a real absence, never fabricated)
 *  and the custodian is alerted through the standing health check. MINOR: additive only.
 *  0.6.0 -- consequence layer C1 (2026-08-16, mig 0121) added `world.raziel_state`: the care
 *  register -- Raziel's readable state (spoons/mood/pain/energy + staleness + front state) plus the
 *  care-loop fields (`care_hold`, `pending_care`), derived once and rendered on every surface so
 *  every generation calibrates register without being told. MINOR: additive only.
 *  0.5.0 -- coherence review (2026-08-15) added `continuity.conversations` (the conversation ledger,
 *  mig 0106, previously readable by NO contract surface -- D5) and `world.commons_life` (the commons as
 *  a shared board rather than a one-way drop box -- D7). 0.4.0 was wave 8
 *  (`oversight.growth_unconfirmed`); 0.3.0 was wave 6 (world.watching, beliefs.supersede_candidates,
 *  relational.siblings, relational.recent_witness, oversight.answered_questions). */
export const MINDSTATE_CONTRACT_VERSION = "0.11.0";

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
    /** What is durably true about RAZIEL (mig 0116) -- as opposed to about the companion, which is
     *  what `preferences` holds. Lives on the contract because every boot surface needs it and
     *  because the store having the facts is NOT the same as a companion seeing them: this field was
     *  loaded for a while before any renderer emitted it, and a store nobody renders is no store. */
    architect_facts: ArchitectFactEntry[];
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
    /** Active conversation-ledger threads (mig 0106). 0.5.0 (coherence review D5): the ledger backs
     *  durable reply-to and Discord thread mapping, yet orient returned it in a raw field no contract
     *  surface could see. mindOrient selects state IN ('open','moving') LIMIT 3, seed_text clipped. */
    conversations: WmActiveConversation[];
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
    /** Wave 6. Supersessions the gate PROPOSED; only the belief's owner may accept one. In the contract
     *  rather than on the Discord wire alone -- a proposal one surface can see and the others cannot is a
     *  proposal the companion cannot act on from where they happen to be. */
    supersede_candidates: BeliefExtras["supersede_candidates"];
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
    /** Wave 6. The other two's last declared lane -- standing position, not live presence. */
    siblings: RelationalBlocks["siblings"];
    /** Wave 6. Gaia's witnessing, read back to her. `[]` for cypher/drevan is complete, not missing. */
    recent_witness: RelationalBlocks["recent_witness"];
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
    /** Wave 6. What Raziel answered -- the closing half of the questions loop. */
    answered_questions: OversightBlocks["answered_questions"];
    /** Wave 8. Growth readings detected but not yet owned -- the middle state between a pressure flag and
     *  confirmed growth, previously visible on the Claude.ai surface alone. */
    growth_unconfirmed: OversightBlocks["growth_unconfirmed"];
  };

  /** The world around the house. */
  world: {
    home_recent: HomeEvent[];
    /** Wave 4 (2026-08-01). Canonical implementation in blocks/world.ts; execSessionOrient and
     *  execBotOrient keep divergent inline copies until they cut over. */
    club: WorldBlocks["club"];
    commons: WorldBlocks["commons"];
    /** 0.5.0 (coherence review D7): the commons as a shared board, any author. Without it,
     *  companion-authored posts were written into a lane no companion ever read back. */
    commons_life: WorldBlocks["commons_life"];
    /** 0.10.0: deploy change-notes, 14-day window -- the system announcing its own changes. */
    change_notes: WorldBlocks["change_notes"];
    shelf: WorldBlocks["shelf"];
    collection: WorldBlocks["collection"];
    forage: WorldBlocks["forage"];
    listens: WorldBlocks["listens"];
    motifs: WorldBlocks["motifs"];
    sol: WorldBlocks["sol"];
    /** Wave 7. The whole roster; `sol` stays separate because only Sol has a trust/nest arc. */
    creatures: WorldBlocks["creatures"];
    imps_active: WorldBlocks["imps_active"];
    /** Wave 6. Where Raziel actually is in what they are watching. A progress fact is a FIELD -- the
     *  stale-Fargo answer came from ranking prose because no field existed. */
    watching: WorldBlocks["watching"];
    /** 0.6.0, consequence layer C1: the care register. Raziel's readable state, derived from the
     *  latest biometrics row + front state + the care loop (mig 0121). The signals flowed IN since
     *  0009/0081 and were read at orient as a raw row; this is the first field that makes them a
     *  STATE every renderer must show -- staleness included, because a three-day-old "2 spoons"
     *  presented as current is misinformation wearing a care line. `pending_care` is per-companion
     *  (the one firing THIS companion is assigned); everything else is identical on every loom. */
    raziel_state: RazielStateView | null;
  };

  /** Graph memory Phase 1.5 (0.11.0): the local structural neighborhood around what this boot already
   *  surfaced. Rendered, not searched -- src/graph/traverse.ts::neighborhood() walked outward from ids
   *  the loader fetches for OTHER blocks (conclusions, journal); this field carries no retrieval logic
   *  of its own. */
  graph: GraphBlocks;

  meta: {
    datetime_iso: string;
    datetime_local: string;
    /** Blocks defined by the design doc that this loader version does not fill yet.
     *  Consumers can distinguish "empty" from "not loaded". Shrinks as slices land. */
    not_yet_loaded: string[];
    /**
     * Sources that FAILED this load, by name. Empty is healthy.
     *
     * `not_yet_loaded` and `degraded` answer different questions and must never be conflated: the first is
     * "this loader version does not implement that block yet", the second is "it does, and it broke just
     * now". Both render as an absent block, and treating them alike is how a dead source passes for a quiet
     * one -- the failure mode that has already cost this project three debugging sessions.
     */
    degraded: string[];
  };
}

/**
 * Design-doc blocks pending in later slices (kept in one place so the parity harness and the docs agree on
 * what "done" means).
 *
 * READ THE DENOMINATOR. This list counts blocks the DESIGN DOC names. It reached empty on 2026-08-01 and was
 * misread (by me) as "the bot cutover is unblocked" -- but seven fields execBotOrient actually returns were
 * not in the design doc at all, so an empty list said nothing about them. The counter was honest about what
 * it counted; the mistake was in what it was taken to mean. Wave 6 closed five of the seven and the other two
 * are deliberate exclusions (see blocks/relational.ts). If you add a per-loom field, add it to the CONTRACT
 * or this number will lie again by being accurate.
 */
export const NOT_YET_LOADED: string[] = [
  // The shared bank (north-star element 0): the shared identity_kernel carries the Companion
  // Constitution + the distilled ARCHITECT STANCE preamble. Discord/worker/Brain already pull it
  // via /identity/kernel/:id/bundle; Claude.ai orient and the planned Hearth chat page do not, so
  // loading it here is what makes the stance reach every substrate (Raziel, 2026-07-26). Two
  // blocks on purpose: shared_kernel is common to all three, companion_kernel is this one's own --
  // the shared-bank / distinct-self split the whole contract is built around.
];
