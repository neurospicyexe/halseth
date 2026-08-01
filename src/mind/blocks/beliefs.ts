// src/mind/blocks/beliefs.ts
//
// Wave 6: `beliefs.supersede_candidates` -- supersessions the novelty gate has PROPOSED and that only the
// companion who owns the belief can accept.
//
// This is the block where "which loom can see it" is a correctness question rather than a completeness one.
// Mig 0112 changed the gate from auto-retiring a belief at cosine >= 0.88 to merely asking, because Raziel's
// call is that a companion supersedes their own thought (the gate had retired real beliefs on the strength of
// similarity alone, and an autonomous writer had already recorded a positive experience of Drevan's as a
// negative one). A proposal only the Discord surface can see is a proposal the companion cannot act on from
// anywhere else -- so it has to live in the contract, not on one wire.
//
// TIME-BOXED, and the box is the design. There is no dismiss verb and no queue to drain: if they do not act,
// the candidate ages out and the older belief STAYS LIVE. Not-retired is the safe default, and a question
// that cannot expire becomes a nag (rails-need-decay, which has now recurred twice in this system).

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { SUPERSEDE_CANDIDATE_WINDOW_DAYS } from "../../webmind/novelty.js";

export interface SupersedeCandidate {
  /** The newer belief that prompted the proposal. */
  new_id: string;
  /** The older belief it might replace. Still live -- nothing has been retired. */
  older_id: string;
  /** Cosine similarity that triggered the proposal. Evidence, never a verdict. */
  score: number;
  newer: string;
  older: string;
}

export interface BeliefExtras {
  supersede_candidates: SupersedeCandidate[];
}

/**
 * `o.superseded_by IS NULL` matters: once the older belief HAS been retired, the proposal is spent and
 * showing it again would invite retiring something twice.
 */
export async function loadBeliefExtras(env: Env, companionId: WmAgentId): Promise<BeliefExtras> {
  try {
    const rows = await env.DB.prepare(
      `SELECT n.id AS new_id, n.supersede_candidate_id, n.supersede_candidate_score,
              substr(n.conclusion_text, 1, 200) AS new_text,
              substr(o.conclusion_text, 1, 200) AS old_text
       FROM companion_conclusions n
       JOIN companion_conclusions o ON o.id = n.supersede_candidate_id
       WHERE n.companion_id = ?1 AND n.supersede_candidate_id IS NOT NULL
         AND o.superseded_by IS NULL
         AND datetime(n.created_at) > datetime('now', '-' || ?2 || ' days')
       ORDER BY n.created_at DESC LIMIT 2`
    ).bind(companionId, SUPERSEDE_CANDIDATE_WINDOW_DAYS)
      .all<{ new_id: string; supersede_candidate_id: string; supersede_candidate_score: number; new_text: string; old_text: string }>();

    return {
      supersede_candidates: (rows.results ?? []).map(r => ({
        new_id: r.new_id,
        older_id: r.supersede_candidate_id,
        score: r.supersede_candidate_score,
        newer: r.new_text,
        older: r.old_text,
      })),
    };
  } catch (err) {
    console.warn("[mind/beliefs] supersede candidates load failed", { companionId, error: String(err) });
    return { supersede_candidates: [] };
  }
}
