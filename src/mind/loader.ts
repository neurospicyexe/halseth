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

export async function loadMindState(env: Env, companionId: WmAgentId, loom: Loom): Promise<MindState> {
  const [orient, ground] = await Promise.all([
    mindOrient(env, companionId, { readOnly: true }),
    mindGround(env, companionId),
  ]);

  return {
    contract_version: MINDSTATE_CONTRACT_VERSION,
    companion_id: companionId,
    loom,
    loaded_at: new Date().toISOString(),

    identity: {
      anchor: orient.identity_anchor,
    },

    felt: {
      limbic: orient.limbic_state,
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
    },

    carried: {
      dreams_unexamined: orient.unexamined_dreams,
      open_loops: orient.open_loops ?? ground.open_loops ?? [],
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

    oversight: {
      pressure_flags: orient.pressure_flags,
      growth_confirmed: orient.growth_confirmed,
    },

    world: {
      home_recent: orient.home_recent ?? [],
    },

    meta: {
      datetime_iso: orient.current_datetime_iso,
      datetime_local: orient.current_datetime_cst,
      not_yet_loaded: NOT_YET_LOADED,
    },
  };
}
