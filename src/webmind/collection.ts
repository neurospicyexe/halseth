// src/webmind/collection.ts
//
// Collection sparkle (migration 0079, inspo take 13). A thin weighting layer over the
// things companions gather (forage_finds + media_experiences). Sparkle accrues when an
// item is engaged -- a find consumed, a listen reacted to -- so the collection orders by
// what actually gripped, not just what was most recent. Monotonic up; never gates.

export type SparkleSource = "forage_finds" | "media_experiences";

export const VALID_SPARKLE_SOURCES: readonly SparkleSource[] = ["forage_finds", "media_experiences"];

export function isValidSparkleSource(s: string): s is SparkleSource {
  return (VALID_SPARKLE_SOURCES as readonly string[]).includes(s);
}

// How much shine each kind of engagement adds.
export type SparkleEvent = "consume" | "react" | "recall";
const SPARKLE_DELTA: Record<SparkleEvent, number> = {
  consume: 1.0, // a forage find explored as yourself
  react: 0.8,   // a listen that earned a reaction
  recall: 0.3,  // surfaced again later
};

export function sparkleDelta(event: SparkleEvent): number {
  return SPARKLE_DELTA[event] ?? 0;
}

/** Upsert that adds `delta` to an item's sparkle (creating the row at `delta` if absent). Bind: [source_table, source_id, delta]. */
export function bumpSparkleSql(): string {
  return `INSERT INTO collection_sparkle (source_table, source_id, sparkle, last_sparked_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(source_table, source_id) DO UPDATE SET
            sparkle = sparkle + excluded.sparkle,
            last_sparked_at = datetime('now')`;
}

/** Forage finds for a companion (own + shared pool) with their sparkle weight, unconsumed
 *  first (2026-07-21 starvation fix: sparkle-first pinned already-explored finds above fresh
 *  unconsumed ones -- the collection page read as frozen because a well-loved old find always
 *  outranked something new nobody had touched yet). Bind: [companion_id, limit]. */
export function collectionForageSql(): string {
  return `SELECT f.id, f.title, f.domain, f.summary, f.source_url, f.consumed_at, f.gathered_at,
                 COALESCE(s.sparkle, 0) AS sparkle
          FROM forage_finds f
          LEFT JOIN collection_sparkle s ON s.source_table = 'forage_finds' AND s.source_id = f.id
          WHERE f.companion_id = ? OR f.companion_id IS NULL
          ORDER BY (f.consumed_at IS NULL) DESC, sparkle DESC, f.gathered_at DESC LIMIT ?`;
}

/** Recent listens with their sparkle weight, brightest first (shared table -- no companion filter). Bind: [limit]. */
export function collectionMediaSql(): string {
  return `SELECT m.id, m.title, m.artist, m.media_type, m.created_at,
                 COALESCE(s.sparkle, 0) AS sparkle
          FROM media_experiences m
          LEFT JOIN collection_sparkle s ON s.source_table = 'media_experiences' AND s.source_id = m.id
          ORDER BY sparkle DESC, m.created_at DESC LIMIT ?`;
}
