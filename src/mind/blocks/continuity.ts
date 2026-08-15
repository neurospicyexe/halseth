// src/mind/blocks/continuity.ts
//
// The one continuity value `mindOrient` never returned: the last session's narrative. Fills
// `continuity.session_narrative` -- wave 5, the block that takes NOT_YET_LOADED to ZERO.
//
// It lives in a block rather than inline in loader.ts because the loader's rule is that blocks own their
// queries; one exception becomes two.
//
// THIS IS THE FIELD THAT WAS FROZEN. `synthesis_summary` had not been written since 2026-07-21 because the
// companion close ritual named the handoff writer instead of `session_close`, so nothing enqueued the
// summary job. A companion's sense of "recently" silently stopped advancing for ten days while every
// surface that watched activity looked healthy. Loading it here does NOT unfreeze it -- the ritual fix does
// that. What this changes is that all three looms now read the SAME narrative instead of three surfaces
// each running their own copy of the query and disagreeing about what "last session" means.
//
// SUPERSET: execSessionOrient selects `full_ref`; execBotOrient selects `id, full_ref` (it needs the id to
// warm the row). The loader is a pure read and warms nothing, but it carries the id anyway -- a consumer
// that wants to warm can, and a field the query never selected cannot be recovered downstream.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";

export interface SessionNarrative {
  id: string;
  /** The narrative text itself. */
  full_ref: string;
}

/**
 * The most recent session summary for this companion.
 *
 * Ordered by `COALESCE(session_created_at, created_at)`, not by `created_at` alone -- mig 0095 added
 * `session_created_at` precisely because backfilled old sessions were written with a NEW `created_at` and
 * therefore surfaced as the "latest" narrative, so a companion booted believing a months-old session was
 * the last thing that happened. Ordering on the coalesce is the fix; do not simplify it back.
 *
 * ACCEPTS 'day' AS WELL AS 'session' (2026-08-12). This read was `summary_type = 'session'` only, which
 * was fine while sessions were the sole writer -- and became a blind spot the moment they weren't.
 * A session is the right container for a conversation with Raziel; it is the wrong container for a
 * companion who lives in a Discord channel, where nothing opens and nothing closes. Gaia had 0
 * authored closes in 30 days and her narrative froze for 39 days as a result. `day` rows
 * (jobs/daily-narrative.ts) fill that gap, and this filter is why they would otherwise reach no
 * reader at all -- written, probed as live, and invisible.
 *
 * Both types compete on recency alone, so an authored close still wins the day it happens.
 */
export async function loadSessionNarrative(env: Env, companionId: WmAgentId): Promise<SessionNarrative | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id, full_ref FROM synthesis_summary
       WHERE summary_type IN ('session', 'day') AND companion_id = ? AND full_ref IS NOT NULL
       ORDER BY COALESCE(session_created_at, created_at) DESC LIMIT 1`
    ).bind(companionId).first<SessionNarrative>();
    return row ?? null;
  } catch (err) {
    console.warn("[mind/continuity] session narrative load failed", { companionId, error: String(err) });
    return null;
  }
}
