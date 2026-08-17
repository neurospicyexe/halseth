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
import { effectiveTrustSql, MOTIF_TUNING } from "../../webmind/motifs.js";
import { collectionForageSql, collectionMediaSql } from "../../webmind/collection.js";

export interface ClubRound {
  id: string; status: string;
  winner_title: string | null;
  candidate_count: number;
  /** Phase timestamps (wave 7). A round's PHASE is what a renderer needs to say anything useful about it;
   *  status alone cannot distinguish "opened an hour ago" from "has been discussing for a week". */
  opened_at: string | null;
  activated_at: string | null;
  discussing_at: string | null;
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
  /**
   * Raw reactions map (wave 7), carried so a renderer can extract THIS companion's own words.
   *
   * The contract carries the raw JSON and the renderer decides -- because the rule about it is a rule about
   * VOICE, not about data: a companion gets their OWN reaction back verbatim, and a sibling's is reported as
   * a bare fact ("drevan sat with this"), never as text. Handing one companion another's phrasing is how
   * attribution scrambled in June. Keeping the map whole here means one place decides that, per surface,
   * instead of the split being baked in by whichever query ran.
   */
  reactions_json: string | null;
}
/** The full `companion_motifs` row. Wide on purpose -- `selectResurrections` (webmind/motifs.ts) needs
 *  `last_surfaced_at` for its cooldown and `id` so the caller can stamp it after surfacing. */
export interface Motif {
  id: string;
  companion_id: string;
  label: string; display: string;
  recurrence_count: number;
  trust: number;
  first_seen: string;
  last_seen: string;
  last_surfaced_at: string | null;
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
/**
 * Wave 9. The brightest of what this companion gathered -- sparkle-weighted, so it is what actually GRIPPED
 * rather than what is merely recent.
 *
 * Distinct from `collection.forage` / `collection.media`, which are the raw pools. This is one ranked view
 * ACROSS both, `sparkle > 0` only, because an item that never earned shine has not joined the hoard. Passive
 * surfacing must not bump the weight -- an active "my collection" pull does. Reading it here is passive.
 */
export interface CollectionHighlight { title: string; kind: string; sparkle: number }
/** Every creature in the house, not just Sol (wave 7). `sol` stays as its own field because Sol has a
 *  trust/nest arc nothing else has; this is the roster, and a roster of one is a roster that breaks the day
 *  a second creature is seeded. */
export interface CreatureRow {
  name: string;
  species: string | null;
  kind: string;
  trust: number;
  mood: string | null;
  last_interaction_at: string | null;
  created_at: string | null;
}
/**
 * Wave 6. What Raziel is part-way through (mig 0111).
 *
 * THE FARGO BUG IS WHY THIS IS IN THE CONTRACT AND NOT ONLY ON THE DISCORD WIRE. Drevan was asked where they
 * were in the show and answered "last I tracked, S4 E2" -- stale, because there was no position field anywhere
 * in the schema, so the answer had to come from whichever prose fragment ranked highest, and a June note about
 * FINISHING the show won. A progress fact is a field, not a memory. Leaving it visible to one surface only
 * reproduces the same failure on every other surface.
 *
 * `position` is composed HERE rather than in each renderer so every surface says "S4E2" identically and no
 * consumer has to reassemble it from two integers.
 */
export interface WatchItem {
  title: string;
  kind: string;
  status: string;
  /** Pre-composed: "S4E2" | "S4" | "E2" | "". */
  position: string;
  position_note: string | null;
  with_companion: string | null;
}

/** A commons post with its author -- the read-back half of the shared board. */
export interface CommonsLifePost {
  id: string;
  author: string;
  context: string | null;
  body: string;
  reply_to: string | null;
  created_at: string;
}

/** A deploy change-note (2026-08-17): a commons post with context 'change-note[:version]'.
 *  Its own field rather than riding commons_life because a change-note must survive longer
 *  than an 8-post scroll window -- it renders for 14 days, then self-cleans. */
export interface ChangeNote {
  id: string;
  body: string;
  created_at: string;
}

export interface WorldBlocks {
  club: ClubRound | null;
  commons: CommonsPost[];
  /** The commons as a SHARED board (coherence review D7, 2026-08-15). `commons` above is
   *  Raziel's unanswered drops only; until this field, companion-authored posts (the worker's
   *  shelf reactions, replies) were written into a lane no companion ever read back, making the
   *  commons a one-way drop box. This is the last few posts by ANYONE, authors visible. */
  commons_life: CommonsLifePost[];
  /** Deploy change-notes from the last 14 days -- the system announcing its own changes so a
   *  vanished counter is a stated change, not a mystery ([[invisible-effect-reads-as-dead-control]]). */
  change_notes: ChangeNote[];
  shelf: ShelfItem[];
  collection: { forage: unknown[]; media: unknown[]; top: CollectionHighlight[] };
  forage: { pool: ForageFind[]; active: ForageFind[] };
  listens: Listen[];
  motifs: { active: Motif[]; resurrection_candidates: Motif[] };
  sol: SolState | null;
  creatures: CreatureRow[];
  imps_active: ImpActivity[];
  watching: WatchItem[];
}

const EMPTY: WorldBlocks = {
  club: null, commons: [], commons_life: [], change_notes: [], shelf: [], collection: { forage: [], media: [], top: [] },
  forage: { pool: [], active: [] }, listens: [],
  motifs: { active: [], resurrection_candidates: [] }, sol: null, creatures: [], imps_active: [],
  watching: [],
};

/** Never throws: the shared world is context, and missing context must never break a boot. */
export async function loadWorldBlocks(env: Env, companionId: WmAgentId): Promise<WorldBlocks> {
  try {
    const [club, commons, commonsLife, changeNotes, shelf, colForage, colMedia, pool, active, listens, motifsActive, motifsFaded, sol, imps, colTop, watching] =
      await Promise.all([
        env.DB.prepare(
          "SELECT r.id, r.status, r.opened_at, r.activated_at, r.discussing_at, (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS winner_title, (SELECT COUNT(*) FROM club_recommendations WHERE round_id = r.id) AS candidate_count FROM club_rounds r WHERE r.status != 'closed' ORDER BY r.opened_at DESC LIMIT 1"
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
        // The shared board itself, any author -- what makes the commons readable back, not write-only.
        env.DB.prepare(
          "SELECT id, author, context, body, reply_to, created_at FROM commons_posts ORDER BY created_at DESC LIMIT 8"
        ).all<CommonsLifePost>(),
        // Change-notes get their own 14-day window. RANGE predicate, not LIKE (reviewer,
        // 2026-08-17): LIKE's prefix optimization needs case_sensitive_like/NOCASE, so it was a
        // full scan of the highest-churn world table; the range pair uses idx_commons_context.
        // 'change-notf' is 'change-note' with the last byte +1 -- the exclusive upper bound.
        env.DB.prepare(
          "SELECT id, body, created_at FROM commons_posts WHERE context >= 'change-note' AND context < 'change-notf' AND created_at >= datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 3"
        ).all<ChangeNote>(),
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
        // ONE FRESH + ONE AGING, not LIFO. This block shipped as a plain `ORDER BY gathered_at DESC LIMIT 3`
        // -- which is exactly the shape execSessionOrient REPLACED on 2026-07-09, because pure LIFO against a
        // forager adding ~1 find/companion/day means the tail is never drained: `stale:forage` ("oldest
        // unconsumed past 7 days") was structurally unclearable and Gaia had 20 unconsumed finds with the
        // oldest sitting since 06-11. The loader was the DEGRADED copy again; taking the newest AND the
        // oldest drains the tail while keeping the pool current. UNION dedups when only one find exists, so
        // the 2-row shape holds. Adopted for every surface: the starvation applies to the bots too.
        env.DB.prepare(
          `SELECT id, title, domain, summary, at FROM (
             SELECT id, title, domain, summary, gathered_at AS at FROM forage_finds
              WHERE (companion_id = ?1 OR companion_id IS NULL) AND consumed_at IS NULL
              ORDER BY gathered_at DESC LIMIT 1)
           UNION
           SELECT id, title, domain, summary, at FROM (
             SELECT id, title, domain, summary, gathered_at AS at FROM forage_finds
              WHERE (companion_id = ?1 OR companion_id IS NULL) AND consumed_at IS NULL
              ORDER BY gathered_at ASC LIMIT 1)
           ORDER BY at DESC`
        ).bind(companionId).all<ForageFind>(),
        env.DB.prepare(
          "SELECT id, title, domain, summary, consumed_at AS at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 2"
        ).bind(companionId).all<ForageFind>(),
        // The UNION of both prior copies: the bot's provenance columns AND a useful depth.
        env.DB.prepare(
          "SELECT id, title, artist, shared_by, requested_companion, reactions_json, created_at FROM media_experiences ORDER BY created_at DESC LIMIT 3"
        ).all<Listen>(),
        // FULL ROW, not five columns (wave 9). `selectResurrections` gates on `last_surfaced_at` (cooldown)
        // and sorts on trust/recurrence, and it needs `id` so the caller can stamp the cooldown after
        // surfacing -- none of which the narrow projection carried, which is why execSessionOrient could not
        // read motifs from here. The faded query also gains the RESURRECT_TRUST_FLOOR filter it was missing:
        // resurrection is for motifs that were TRUSTED before they faded, not for everything that faded.
        env.DB.prepare(
          `SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status FROM companion_motifs WHERE companion_id = ? AND status = 'active' ORDER BY ${effectiveTrustSql()} DESC, recurrence_count DESC LIMIT 10`
        ).bind(companionId).all<Motif>(),
        env.DB.prepare(
          `SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status FROM companion_motifs WHERE companion_id = ? AND status = 'faded' AND trust >= ${MOTIF_TUNING.RESURRECT_TRUST_FLOOR} ORDER BY trust DESC, recurrence_count DESC LIMIT 10`
        ).bind(companionId).all<Motif>(),
        // The whole roster in ONE query, with Sol picked out of it below -- the bot path already did it this
        // way, and two queries against the same table on the same boot is a round trip bought for nothing.
        env.DB.prepare(
          "SELECT id, name, species, kind, state_json, trust, last_interaction_at, created_at FROM creatures ORDER BY kind ASC, name ASC LIMIT 8"
        ).all<{ id: string; name: string; species: string | null; kind: string; state_json: string | null; trust: number; last_interaction_at: string | null; created_at: string | null }>(),
        env.DB.prepare(
          "SELECT imp, COUNT(*) AS n, MAX(created_at) AS last_at FROM imp_activations WHERE companion_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY imp ORDER BY n DESC, last_at DESC LIMIT 3"
        ).bind(companionId).all<ImpActivity>(),
        // Wave 9. One ranked view across BOTH source tables; `sparkle > 0` is the condition that matters,
        // because the sidecar only holds things that earned shine.
        env.DB.prepare(
          `SELECT title, kind, sparkle FROM (
             SELECT f.title AS title, 'forage' AS kind, s.sparkle AS sparkle
             FROM collection_sparkle s JOIN forage_finds f ON f.id = s.source_id
             WHERE s.source_table = 'forage_finds' AND (f.companion_id = ?1 OR f.companion_id IS NULL)
             UNION ALL
             SELECT m.title || COALESCE(' -- ' || m.artist, ''), 'listen', s.sparkle
             FROM collection_sparkle s JOIN media_experiences m ON m.id = s.source_id
             WHERE s.source_table = 'media_experiences'
           ) WHERE sparkle > 0 ORDER BY sparkle DESC LIMIT 4`
        ).bind(companionId).all<CollectionHighlight>(),
        // Wave 6. Forward-only progress; `NULLS LAST` so a shelf row never watched does not outrank one
        // watched last night.
        env.DB.prepare(
          `SELECT title, kind, status, season, episode, position_note, with_companion
           FROM watch_shelf WHERE status IN ('watching','paused')
           ORDER BY (status = 'watching') DESC, last_watched_at DESC NULLS LAST LIMIT 4`
        ).all<{ title: string; kind: string; status: string; season: number | null; episode: number | null; position_note: string | null; with_companion: string | null }>(),
      ]);

    const creatureRows = sol.results ?? [];
    const creatures: CreatureRow[] = creatureRows.map(r => {
      let mood: string | null = null;
      try { mood = r.state_json ? (JSON.parse(r.state_json).mood ?? null) : null; } catch { /* malformed json -> no mood, never breaks a boot */ }
      return {
        name: r.name,
        species: r.species,
        kind: r.kind,
        trust: Number((r.trust ?? 0).toFixed(2)),
        mood,
        last_interaction_at: r.last_interaction_at ?? null,
        created_at: r.created_at ?? null,
      };
    });
    const solRow = creatureRows.find(r => r.name === "Sol" || r.kind === "companion_pet") ?? null;

    // Sol's hoard is a second read keyed on the creature id, so it can only run once Sol is known.
    let solState: SolState | null = null;
    if (solRow) {
      const sol = solRow;
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
      commons_life: commonsLife.results ?? [],
      change_notes: changeNotes.results ?? [],
      shelf: shelf.results ?? [],
      collection: { forage: colForage.results ?? [], media: colMedia.results ?? [], top: colTop.results ?? [] },
      forage: { pool: pool.results ?? [], active: active.results ?? [] },
      listens: listens.results ?? [],
      motifs: { active: motifsActive.results ?? [], resurrection_candidates: motifsFaded.results ?? [] },
      sol: solState,
      creatures,
      imps_active: imps.results ?? [],
      watching: (watching.results ?? []).map(r => ({
        title: (r.title ?? "").slice(0, 150),
        kind: r.kind,
        status: r.status,
        position: r.season && r.episode ? `S${r.season}E${r.episode}` : r.season ? `S${r.season}` : r.episode ? `E${r.episode}` : "",
        position_note: r.position_note ? r.position_note.slice(0, 160) : null,
        // Only report a co-watcher when it is someone else: telling Drevan he watches Fargo with Drevan
        // is noise.
        with_companion: r.with_companion && r.with_companion !== companionId ? r.with_companion : null,
      })),
    };
  } catch (err) {
    console.warn("[mind/world] load failed, degrading to empty", { companionId, error: String(err) });
    return EMPTY;
  }
}
