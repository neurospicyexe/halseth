// src/mind/blocks/world.ts
//
// The `world` MindState block: the shared life outside this companion's own head -- what the house is
// doing, what has been brought in from outside, what recurs. Fills 9 of the 14 remaining NOT_YET_LOADED
// entries (world.club, commons, shelf, collection, forage, listens, motifs, sol, imps_active), taking the
// contract from 14 unfilled to 5. Wave 4.
//
// This is the biggest single wave and the last large one blocking the bot cutover. Of execBotOrient's 40
// keys, these nine back ten of them: club_round, commons/recent_witness, shelf, collection, forage_finds,
// consumed_forage_finds, recent_listens, motifs, creatures + sol_block, imp_activity.
//
// SUPERSET IS PER-FIELD, NOT PER-FILE. Unifying the divergent copies here, the richer side is not always
// the same one:
//   * `motifs`  -- execSessionOrient reads the full row (LIMIT 10, plus faded resurrection candidates);
//                  execBotOrient reads four columns (LIMIT 3). Session is richer.
//   * `listens` -- execBotOrient reads `shared_by, requested_companion` and session does NOT. Those two
//                  columns were added 2026-07-27 after Drevan told the commons that GAIA handed him a
//                  track Raziel gave him, 18 days earlier: the row held the giver and the date the whole
//                  time and the query dropped them, so the model invented both. The bot query is the one
//                  that learned. Session is the degraded copy here.
// So the canonical version takes the union field-by-field. A per-file "this one wins" rule would have
// re-broken listens provenance on the way to fixing motifs.
//
// PURE READ. No warming, no consuming, no surfaced_at stamps -- the loader is a window, not a hand. That
// matters most for `collection`, whose sparkle weight is bumped BY reading elsewhere; doing that here would
// be a ranking signal written by the act of loading.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { effectiveTrustSql } from "../../webmind/motifs.js";
import { collectionForageSql, collectionMediaSql } from "../../webmind/collection.js";

export interface ClubRound {
  id: string; status: string;
  winner_title: string | null;
  candidate_count: number;
}
export interface ForageFind {
  id: string; title: string; domain: string;
  summary: string | null;
  at: string | null;
}
export interface Listen {
  id: string; title: string;
  artist: string | null;
  /** Who gave it and who it was for. Dropped by one query for months; the model invented both. */
  shared_by: string | null;
  requested_companion: string | null;
  created_at: string;
}
export interface Motif {
  label: string; display: string;
  recurrence_count: number;
  trust: number;
  status: string;
}
export interface ShelfItem { title: string; kind: string; note: string | null }
export interface CommonsPost { id: string; context: string | null; body: string; created_at: string }
export interface SolState {
  name: string; species: string | null; trust: number;
  last_interaction_at: string | null;
  nest_items: number;
  nest_treasured: number;
}
export interface ImpActivity { imp: string; n: number; last_at: string }

export interface WorldBlocks {
  club: ClubRound | null;
  commons: CommonsPost[];
  shelf: ShelfItem[];
  collection: { forage: unknown[]; media: unknown[] };
  forage: { pool: ForageFind[]; active: ForageFind[] };
  listens: Listen[];
  motifs: { active: Motif[]; resurrection_candidates: Motif[] };
  sol: SolState | null;
  imps_active: ImpActivity[];
}

const EMPTY: WorldBlocks = {
  club: null, commons: [], shelf: [], collection: { forage: [], media: [] },
  forage: { pool: [], active: [] }, listens: [],
  motifs: { active: [], resurrection_candidates: [] }, sol: null, imps_active: [],
};

/** Never throws: the shared world is context, and missing context must never break a boot. */
export async function loadWorldBlocks(env: Env, companionId: WmAgentId): Promise<WorldBlocks> {
  try {
    const [club, commons, shelf, colForage, colMedia, pool, active, listens, motifsActive, motifsFaded, sol, imps] =
      await Promise.all([
        env.DB.prepare(
          "SELECT r.id, r.status, (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS winner_title, (SELECT COUNT(*) FROM club_recommendations WHERE round_id = r.id) AS candidate_count FROM club_rounds r WHERE r.status != 'closed' ORDER BY r.opened_at DESC LIMIT 1"
        ).first<ClubRound>(),
        // RAZIEL's wall posts that THIS companion has not answered yet. Both halves matter: `author =
        // 'raziel'` because the block is his drops rather than a general feed, and the NOT IN because a
        // post already answered is not still an invitation. Surfaced as drops, not pings.
        env.DB.prepare(
          `SELECT id, context, body, created_at FROM commons_posts
           WHERE author = 'raziel'
             AND id NOT IN (SELECT reply_to FROM commons_posts WHERE author = ?1 AND reply_to IS NOT NULL)
           ORDER BY created_at DESC LIMIT 5`
        ).bind(companionId).all<CommonsPost>(),
        env.DB.prepare(
          "SELECT title, kind, note FROM obsession_shelf WHERE status = 'active' ORDER BY updated_at DESC LIMIT 6"
        ).all<ShelfItem>(),
        // BIND ARITY IS DOCUMENTED ON THESE HELPERS AND I GOT IT WRONG FIRST TIME (2026-08-01):
        // collectionForageSql is [companion_id, limit]; collectionMediaSql is [limit] ONLY -- it reads a
        // shared table with no companion filter. Passing companionId as the limit made the statement
        // throw, the whole block hit its catch, and every world value came back empty/null while looking
        // like "there is nothing here". A soft-failing loader must be verified against real data, never
        // just for absence of errors.
        env.DB.prepare(collectionForageSql()).bind(companionId, 5).all(),
        env.DB.prepare(collectionMediaSql()).bind(5).all(),
        env.DB.prepare(
          "SELECT id, title, domain, summary, gathered_at AS at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NULL ORDER BY gathered_at DESC LIMIT 3"
        ).bind(companionId).all<ForageFind>(),
        env.DB.prepare(
          "SELECT id, title, domain, summary, consumed_at AS at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 2"
        ).bind(companionId).all<ForageFind>(),
        // The UNION of both prior copies: the bot's provenance columns AND a useful depth.
        env.DB.prepare(
          "SELECT id, title, artist, shared_by, requested_companion, created_at FROM media_experiences ORDER BY created_at DESC LIMIT 3"
        ).all<Listen>(),
        env.DB.prepare(
          `SELECT label, display, recurrence_count, trust, status FROM companion_motifs WHERE companion_id = ? AND status = 'active' ORDER BY ${effectiveTrustSql()} DESC, recurrence_count DESC LIMIT 10`
        ).bind(companionId).all<Motif>(),
        env.DB.prepare(
          `SELECT label, display, recurrence_count, trust, status FROM companion_motifs WHERE companion_id = ? AND status = 'faded' ORDER BY trust DESC, recurrence_count DESC LIMIT 10`
        ).bind(companionId).all<Motif>(),
        env.DB.prepare(
          "SELECT id, name, species, trust, last_interaction_at FROM creatures WHERE name = 'Sol' OR kind = 'companion_pet' LIMIT 1"
        ).first<{ id: string; name: string; species: string | null; trust: number; last_interaction_at: string | null }>(),
        env.DB.prepare(
          "SELECT imp, COUNT(*) AS n, MAX(created_at) AS last_at FROM imp_activations WHERE companion_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY imp ORDER BY n DESC, last_at DESC LIMIT 3"
        ).bind(companionId).all<ImpActivity>(),
      ]);

    // Sol's hoard is a second read keyed on the creature id, so it can only run once Sol is known.
    let solState: SolState | null = null;
    if (sol) {
      const nest = await env.DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(treasured), 0) AS t FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL"
      ).bind(sol.id).first<{ n: number; t: number }>().catch(() => null);
      solState = {
        name: sol.name,
        species: sol.species ?? null,
        trust: Number(sol.trust ?? 0),
        last_interaction_at: sol.last_interaction_at ?? null,
        nest_items: Number(nest?.n ?? 0),
        nest_treasured: Number(nest?.t ?? 0),
      };
    }

    return {
      club: club ?? null,
      commons: commons.results ?? [],
      shelf: shelf.results ?? [],
      collection: { forage: colForage.results ?? [], media: colMedia.results ?? [] },
      forage: { pool: pool.results ?? [], active: active.results ?? [] },
      listens: listens.results ?? [],
      motifs: { active: motifsActive.results ?? [], resurrection_candidates: motifsFaded.results ?? [] },
      sol: solState,
      imps_active: imps.results ?? [],
    };
  } catch (err) {
    console.warn("[mind/world] load failed, degrading to empty", { companionId, error: String(err) });
    return EMPTY;
  }
}
