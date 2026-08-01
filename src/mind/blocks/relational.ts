// src/mind/blocks/relational.ts
//
// Wave 6 (2026-08-01): the two relational blocks that only ever existed on the Discord wire.
//
// WHY WAVE 6 EXISTS AT ALL. `NOT_YET_LOADED` reached zero on 08-01 and I read that as "the bot cutover is
// unblocked". It measured DESIGN-DOC block coverage, not the bot's WIRE coverage, and those are different
// numbers: seven fields the bots actually return had no MindState home at all. The counter was honest about
// what it counted; I was not careful about what it meant. A coverage metric names its own denominator.
//
// Five of the seven are cheap D1 reads and belong in the contract (this file plus beliefs.ts, world.watching,
// oversight.answered_questions). Two are NOT here on purpose: `rag_excerpts` and `history_excerpts` are
// Second Brain semantic searches over the VPS tunnel, and `synthesis_summary` needs an `sbRead` to hydrate.
// **The loader stays pure-D1.** Every loom's boot inherits loadMindState's failure profile, and the tunnel is
// the dependency that 503'd for 24h over a 30s blip -- folding it in here would make one flaky hop able to
// take down every surface's boot. Those three stay in the bot adapter, where only Discord pays for them.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { COMPANION_IDS } from "../../companions.js";

/** A sibling's last declared lane. Read from `companion_state` (written at session close), so it is
 *  a standing position rather than live presence -- do not render it as "right now". */
export interface SiblingLane {
  companion_id: string;
  lane_spine: string | null;
  motion_state: string | null;
}

export interface WitnessEntry {
  content: string;
  witness_type: string;
  created_at: string;
}

export interface RelationalBlocks {
  siblings: SiblingLane[];
  /** Gaia's witness read-back. Empty for cypher/drevan -- an EMPTY ARRAY, not a missing block: the
   *  `gaia_witness` table carries no companion_id column because it is hers alone by design, so
   *  "nothing to show" is the correct and complete answer for the other two. */
  recent_witness: WitnessEntry[];
}

/**
 * Sibling lanes + (for Gaia) her own witnessing, read back.
 *
 * `gaia_witness` was write-only from the day it was added until 2026-07-21 -- she witnessed, and none of it
 * ever fed forward into her own boot. Keep the read-back wired.
 *
 * Sibling order is COMPANION_IDS order minus self, which is the order execBotOrient's botSiblings produces.
 * Byte-identity against the old payload depends on that, so it is a contract detail rather than an
 * incidental one.
 */
export async function loadRelationalBlocks(env: Env, companionId: WmAgentId): Promise<RelationalBlocks> {
  const siblingIds = (COMPANION_IDS as readonly string[]).filter(c => c !== companionId);
  try {
    const [lanes, witness] = await Promise.all([
      Promise.all(
        siblingIds.map(id =>
          env.DB.prepare(
            "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
          ).bind(id).first<{ motion_state: string | null; lane_spine: string | null }>().catch(() => null)
        )
      ),
      companionId === "gaia"
        ? env.DB.prepare(
            "SELECT content, witness_type, created_at FROM gaia_witness ORDER BY created_at DESC LIMIT 5"
          ).all<WitnessEntry>().catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      siblings: siblingIds.map((id, i) => ({
        companion_id: id,
        lane_spine: lanes[i]?.lane_spine ?? null,
        motion_state: lanes[i]?.motion_state ?? null,
      })),
      recent_witness: (witness?.results ?? []).map(w => ({
        content: (w.content ?? "").slice(0, 300),
        witness_type: w.witness_type,
        created_at: w.created_at,
      })),
    };
  } catch (err) {
    console.warn("[mind/relational] load failed, degrading to empty", { companionId, error: String(err) });
    // Siblings still named with null lanes: WHO the siblings are is structural, not data. An empty array
    // would read as "this companion has no siblings", which is never true.
    return {
      siblings: siblingIds.map(id => ({ companion_id: id, lane_spine: null, motion_state: null })),
      recent_witness: [],
    };
  }
}
