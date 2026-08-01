// src/mind/loader.ts
//
// loadMindState(): the single loader every loom will boot from (Phase 1,
// docs/mindstate-contract.md). Strangler slice 1: composes the existing mindOrient
// (readOnly -- no ack, no warm, no home-event stamping) and mindGround queries into
// the MindState contract shape. It adds NO new queries yet; parity with the legacy
// aggregators is the point. Later slices fold in the session_orient-only blocks
// (growth, guardian, forage, world) and the delivery ledger.
//
// Covenant: this function is a PURE READ. If you are about to add a write to it,
// you are rebuilding the bug it exists to kill (loading-as-consuming, loom-bound
// consume-once). Deliveries get recorded in the ledger by the route layer, and
// consumption is an explicit verb.

import type { Env } from "../types.js";
import type { WmAgentId } from "../webmind/types.js";
import { mindOrient } from "../webmind/orient.js";
import { mindGround } from "../webmind/ground.js";
import { MindState, MINDSTATE_CONTRACT_VERSION, NOT_YET_LOADED, Loom } from "./contract.js";
import { loadIdentityBlocks } from "./blocks/identity.js";
import { loadFeltFermentBlocks } from "./blocks/felt.js";
import { loadGrowthBlocks } from "./blocks/growth.js";
import { loadWorldBlocks } from "./blocks/world.js";
import { loadOversightBlocks } from "./blocks/oversight.js";
import { loadSessionNarrative } from "./blocks/continuity.js";

export async function loadMindState(env: Env, companionId: WmAgentId, loom: Loom): Promise<MindState> {
  const [orient, ground, identity, felt, growth, world, oversight, narrative] = await Promise.all([
    mindOrient(env, companionId, { readOnly: true }),
    mindGround(env, companionId),
    // Wave 1 of folding in the NOT_YET_LOADED blocks (2026-07-29): identity (6) + felt-ferment (3),
    // taking the contract from 30 unfilled blocks to 21. Own modules under blocks/ rather than more
    // inline queries here, because these are the CANONICAL implementations -- when execSessionOrient
    // cuts over, its inline copies get deleted and it calls these.
    loadIdentityBlocks(env, companionId),
    loadFeltFermentBlocks(env, companionId),
    // Wave 3 (2026-08-01): growth (7), 21 unfilled -> 14. This is the wave that unblocks the bot cutover
    // -- 13 of execBotOrient's 40 keys mapped to blocks the loader could not fill.
    loadGrowthBlocks(env, companionId),
    // Wave 4: the shared world (9). 14 unfilled -> 5.
    loadWorldBlocks(env, companionId),
    // Wave 5: oversight (3). With session_narrative and the worldview alias, NOT_YET_LOADED hits ZERO.
    loadOversightBlocks(env, companionId),
    loadSessionNarrative(env, companionId),
  ]);

  return {
    contract_version: MINDSTATE_CONTRACT_VERSION,
    companion_id: companionId,
    loom,
    loaded_at: new Date().toISOString(),

    identity: {
      anchor: orient.identity_anchor,
      ...identity,
    },

    felt: {
      limbic: orient.limbic_state,
      ...felt,
      soma_arc: orient.soma_arc ?? [],
      biometrics_latest: orient.latest_biometrics ?? null,
      house: orient.house_state ?? null,
    },

    continuity: {
      latest_handoff: orient.latest_handoff,
      recent_handoffs: orient.recent_handoffs,
      open_thread_count: orient.open_thread_count,
      top_threads: orient.top_threads,
      surfaced_notes: orient.recent_notes,
      recent_notes: ground.recent_notes,
      archived_digests: ground.archived_digests ?? [],
      spiral_turn: orient.recent_spiral_turn ?? null,
      // Wave 5. The value that had been FROZEN since 2026-07-21 (the close ritual never called
      // session_close, so nothing wrote synthesis_summary). Loading it does not unfreeze it -- it means
      // every loom now reads the SAME one instead of three surfaces disagreeing about "recently".
      session_narrative: narrative?.full_ref ?? null,
    },

    carried: {
      dreams_unexamined: orient.unexamined_dreams,
      // orient exposes the projected WmOrientOpenLoop rows (id/loop_text/weight/opened_at,
      // post-merge with the thinking-quality wave); rehydrate the WmOpenLoop contract shape.
      // companion_id is the loaded companion and closed_at is null by the query's filter.
      open_loops: (orient.open_loops ?? ground.open_loops ?? []).map((l) => ({
        id: l.id,
        companion_id: companionId,
        loop_text: l.loop_text,
        weight: l.weight,
        opened_at: l.opened_at,
        closed_at: null,
      })),
      tensions: orient.active_tensions,
      sits: ground.sitting_notes,
      feelings_recent: orient.recent_feelings ?? [],
    },

    beliefs: {
      conclusions: orient.active_conclusions,
      flagged: orient.flagged_beliefs,
    },

    relational: {
      snapshot: orient.relational_snapshot,
      deltas_recent: orient.recent_deltas,
      witness_raziel: orient.raziel_witness_entries,
      triad_incoming: orient.incoming_companion_notes,
      triad_outgoing: orient.recent_companion_notes,
      letters: orient.recent_letters,
      journal_recent: orient.recent_journal,
    },

    // Wave 3: what this companion has been becoming on its own time. Canonical implementation --
    // execSessionOrient and execBotOrient still hold divergent inline copies until they cut over.
    growth,

    oversight: {
      pressure_flags: orient.pressure_flags,
      growth_confirmed: orient.growth_confirmed,
      ...oversight,
    },

    world: {
      home_recent: orient.home_recent ?? [],
      ...world,
    },

    meta: {
      datetime_iso: orient.current_datetime_iso,
      datetime_local: orient.current_datetime_cst,
      not_yet_loaded: NOT_YET_LOADED,
    },
  };
}
