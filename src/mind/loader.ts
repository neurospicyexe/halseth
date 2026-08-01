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
import { loadRelationalBlocks } from "./blocks/relational.js";
import { loadBeliefExtras } from "./blocks/beliefs.js";

export async function loadMindState(env: Env, companionId: WmAgentId, loom: Loom): Promise<MindState> {
  /**
   * NOTHING IN HERE MAY ABORT A BOOT.
   *
   * Found the hard way during the bot cutover (2026-08-01). execBotOrient's old fan-out was 33 sources under
   * `Promise.allSettled`, with a comment saying so: any one query could fail and orient still returned. This
   * loader used `Promise.all`, so the moment the bots started reading through it, a single throw from
   * `mindOrient` -- which calls `seedIdentityAnchor`, which throws by design when its read-back comes back
   * empty -- would take out the whole boot. The regression was invisible in prod and only fell out of the
   * test fixtures, which is the good outcome: this is the boot path for EVERY loom now, so its failure
   * profile is inherited by all of them at once. Fail-closed here means the whole house goes dark.
   *
   * DEGRADED, NOT SILENT. `allSettled` alone would have swapped a loud break for a quiet one, and a
   * soft-failing loader that looks identical working or dead has now cost this project three separate
   * debugging sessions (wave 4 shipped an entirely empty world block and read as a quiet house). So every
   * failure is NAMED in `meta.degraded`, which a consumer can surface and a health check can alarm on. An
   * empty block and an unavailable block are different facts and must not render the same.
   */
  const degraded: string[] = [];
  const [orientRes, groundRes, identity, felt, growth, world, oversight, narrative, relational, beliefExtras] = await Promise.all([
    mindOrient(env, companionId, { readOnly: true }).catch((err: unknown) => {
      console.error("[mind/loader] mindOrient failed, degrading", { companionId, error: String(err) });
      degraded.push("orient");
      return null;
    }),
    mindGround(env, companionId).catch((err: unknown) => {
      console.error("[mind/loader] mindGround failed, degrading", { companionId, error: String(err) });
      degraded.push("ground");
      return null;
    }),
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
    // Wave 6: the five blocks that existed ONLY on the Discord wire. NOT_YET_LOADED hitting zero measured
    // design-doc coverage, not the bot's wire coverage -- seven of its fields had no contract home at all.
    // Five were cheap D1 reads and belong here; the other two (rag_excerpts, history_excerpts) plus the
    // sbRead that hydrates the session narrative stay in the bot adapter, because the loader stays pure-D1
    // and must not make every loom's boot depend on the Second Brain tunnel.
    loadRelationalBlocks(env, companionId),
    loadBeliefExtras(env, companionId),
  ]);

  // Non-null views. `orient`/`ground` are the only two sources that can be wholly absent (the blocks each
  // degrade internally to their own empty shape), so the nullish-coalescing below is confined to their fields
  // rather than smeared across the whole mapping.
  const orient = orientRes;
  const ground = groundRes;
  const nowIso = new Date().toISOString();

  return {
    contract_version: MINDSTATE_CONTRACT_VERSION,
    companion_id: companionId,
    loom,
    loaded_at: nowIso,

    identity: {
      anchor: orient?.identity_anchor ?? null,
      ...identity,
    },

    felt: {
      limbic: orient?.limbic_state ?? null,
      ...felt,
      soma_arc: orient?.soma_arc ?? [],
      biometrics_latest: orient?.latest_biometrics ?? null,
      house: orient?.house_state ?? null,
    },

    continuity: {
      latest_handoff: orient?.latest_handoff ?? null,
      recent_handoffs: orient?.recent_handoffs ?? [],
      open_thread_count: orient?.open_thread_count ?? 0,
      top_threads: orient?.top_threads ?? [],
      surfaced_notes: orient?.recent_notes ?? [],
      recent_notes: ground?.recent_notes ?? [],
      archived_digests: ground?.archived_digests ?? [],
      spiral_turn: orient?.recent_spiral_turn ?? null,
      // Wave 5. The value that had been FROZEN since 2026-07-21 (the close ritual never called
      // session_close, so nothing wrote synthesis_summary). Loading it does not unfreeze it -- it means
      // every loom now reads the SAME one instead of three surfaces disagreeing about "recently".
      session_narrative: narrative?.full_ref ?? null,
    },

    carried: {
      dreams_unexamined: orient?.unexamined_dreams ?? [],
      // orient exposes the projected WmOrientOpenLoop rows (id/loop_text/weight/opened_at,
      // post-merge with the thinking-quality wave); rehydrate the WmOpenLoop contract shape.
      // companion_id is the loaded companion and closed_at is null by the query's filter.
      open_loops: (orient?.open_loops ?? ground?.open_loops ?? []).map((l) => ({
        id: l.id,
        companion_id: companionId,
        loop_text: l.loop_text,
        weight: l.weight,
        opened_at: l.opened_at,
        closed_at: null,
      })),
      tensions: orient?.active_tensions ?? [],
      sits: ground?.sitting_notes ?? [],
      feelings_recent: orient?.recent_feelings ?? [],
    },

    beliefs: {
      conclusions: orient?.active_conclusions ?? [],
      flagged: orient?.flagged_beliefs ?? [],
      ...beliefExtras,
    },

    relational: {
      snapshot: orient?.relational_snapshot ?? [],
      deltas_recent: orient?.recent_deltas ?? [],
      witness_raziel: orient?.raziel_witness_entries ?? [],
      triad_incoming: orient?.incoming_companion_notes ?? [],
      triad_outgoing: orient?.recent_companion_notes ?? [],
      letters: orient?.recent_letters ?? [],
      journal_recent: orient?.recent_journal ?? [],
      ...relational,
    },

    // Wave 3: what this companion has been becoming on its own time. Canonical implementation --
    // execSessionOrient and execBotOrient still hold divergent inline copies until they cut over.
    growth,

    oversight: {
      pressure_flags: orient?.pressure_flags ?? [],
      growth_confirmed: orient?.growth_confirmed ?? [],
      ...oversight,
    },

    world: {
      home_recent: orient?.home_recent ?? [],
      ...world,
    },

    meta: {
      // Time is the one field with no acceptable empty: a companion that does not know when it is will
      // reason about "recently" from whatever it last saw. If orient is degraded, compute it here rather
      // than hand back "" -- temporal grounding is not optional context.
      datetime_iso: orient?.current_datetime_iso ?? nowIso,
      datetime_local: orient?.current_datetime_cst ?? nowIso,
      not_yet_loaded: NOT_YET_LOADED,
      /** Sources that failed this load. EMPTY is the healthy case; a non-empty list means some blocks are
       *  absent rather than genuinely empty, and a renderer must not present the two the same way. */
      degraded,
    },
  };
}
