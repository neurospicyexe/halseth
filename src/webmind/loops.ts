// src/webmind/loops.ts
//
// companion_open_loops: unresolved things with weight.
// Distinct from wm_mind_threads (intentions) -- a loop is unresolved, not a goal.
// Surfaced in ground sorted by weight; closed when resolved.
//
// Migration 0118 (Cypher's own request, raised in autonomous time 2026-08-13): a loop
// observation no longer piles up a new row every time the same stuck thing is noticed, and
// weight no longer ratchets one-way. See the migration header for the full reasoning; the
// two-line version is that recording stasis is fine, but restating it must not buy it a
// fresh claim on the present.

import { Env } from "../types.js";
import { WmAgentId, WmOpenLoop, WmLoopInput, WmLoopWriteResult } from "./types.js";

/**
 * Dedup key for a loop. Lowercase, strip the punctuation people vary between restatements,
 * collapse whitespace. Same shape as pk_roster.name_norm (0117).
 *
 * Deliberately conservative: it catches "the same sentence typed again" and light rewording
 * around punctuation, NOT semantic paraphrase. Open loops are not embedded in Vectorize, so
 * noveltyCheck (which companion_journal and companion_conclusions use) is unavailable here
 * without also adding an embedding write path. A missed merge costs one extra row and is
 * visible in restated_count; a WRONG merge silently destroys a distinct loop. Err toward
 * the extra row.
 */
export function normLoop(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?"'()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Weight half-life, in days. Same lazy-decay-at-READ shape as motifs.ts and heat.ts: no
 * writer, no cron, nothing to schedule or restart.
 *
 * WHY THE ANCHOR IS `acted_at ?? opened_at` AND NOT `last_restated_at` -- this is the one
 * genuinely non-obvious line in the file. motifs.ts decays from `last_seen`, refreshed on
 * every recurrence, because for a motif recurrence IS being lived. For an un-acted loop the
 * inverse holds: restatement is evidence of STASIS. Anchoring on last_restated_at would mean
 * noticing you are stuck for the ninth time RESTORES the loop's top slot -- which is exactly
 * the induction Cypher named, mechanized. Acting on a loop refreshes it; merely saying it
 * again does not.
 *
 * 14 days, which DIVERGES from motifs' TRUST_HALF_LIFE_DAYS of 21 deliberately. The binding
 * constraint here is not symmetry with motifs, it is guardian: GUARDIAN_THRESHOLDS
 * .LOOP_STUCK_DAYS is 21, and a half-life equal to that window means a loop still holds half
 * its weight at the exact moment it gets flagged as stuck -- so the flag arrives about
 * something still sitting near the top of the ranking, which reads as a fresh alarm. At 14 the
 * loop is already carrying ~0.4x by day 21, so the flag reads as "this has been quietly
 * sinking for a while", which is what it is.
 *
 * Nothing is deleted and restated_count is never reduced: the record that this mattered nine
 * times stays true. What decays is its claim on the present.
 */
export const LOOP_WEIGHT_HALF_LIFE_DAYS = 14;

/** SQL expression for present-tense weight. Bare column stays the authored value. */
export function effectiveWeightSql(): string {
  return `(weight / (1.0 + (julianday('now') - julianday(COALESCE(acted_at, opened_at))) / ${LOOP_WEIGHT_HALF_LIFE_DAYS}.0))`;
}

/**
 * Open a loop, or record that an existing open one was restated.
 *
 * The single guarded write path for companion_open_loops -- webmind, spiral residue, session
 * close and the handler all route here. Before 0118 there were four bare INSERTs with no dedup
 * of any kind, which is how the same stuck observation accumulated a row per sighting.
 *
 * A restatement bumps restated_count and last_restated_at, and raises the AUTHORED weight
 * slightly (capped) because a thing said repeatedly does carry real weight. It deliberately
 * does not touch `opened_at` -- guardian's detectStuckLoops triggers on that column, and a
 * write that moves its own trigger's timestamp means the detector can never fire
 * (`tick-restamped-own-trigger`). Nor does it touch `reviewed_at`: a deliberate hold is the
 * companion's statement, not something a restatement gets to renew on its behalf.
 *
 * Closed loops are NOT resurrected -- dedup matches only `closed_at IS NULL`. Re-raising a
 * resolved loop is a genuinely new loop and deserves its own row and its own opened_at.
 */
export async function writeLoop(env: Env, input: WmLoopInput): Promise<WmLoopWriteResult> {
  const now = new Date().toISOString();
  const norm = normLoop(input.loop_text);

  // Empty normalization (loop_text was punctuation/whitespace only) can never dedup safely --
  // every such row would collapse onto one. Insert it and let it stand alone.
  if (norm) {
    const existing = await env.DB.prepare(
      `SELECT id, restated_count, opened_at FROM companion_open_loops
        WHERE companion_id = ? AND loop_norm = ? AND closed_at IS NULL
        ORDER BY opened_at ASC LIMIT 1`
    ).bind(input.companion_id, norm).first<{ id: string; restated_count: number | null; opened_at: string }>();

    if (existing) {
      // MIN(1.0, ...) keeps the authored weight bounded; the decay above is what actually
      // governs ranking, so this is a nudge, not a ratchet.
      await env.DB.prepare(
        `UPDATE companion_open_loops
            SET restated_count = restated_count + 1,
                last_restated_at = ?,
                weight = MIN(1.0, weight + 0.05)
          WHERE id = ?`
      ).bind(now, existing.id).run();
      return {
        // The EXISTING row's opened_at, not `now`. A restatement did not open anything, and a
        // caller that persists this value (spiral stores residue_loop_id; session close logs
        // the write) would otherwise record a false origin time for a loop that has been
        // carried for weeks -- which is precisely the history 0118 exists to keep visible.
        id: existing.id,
        opened_at: existing.opened_at,
        restated: true,
        restated_count: (existing.restated_count ?? 1) + 1,
      };
    }
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at, loop_norm)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, input.companion_id, input.loop_text, input.weight ?? 0.5, now, norm || null).run();
  return { id, opened_at: now, restated: false, restated_count: 1 };
}

export async function readLoops(
  env: Env,
  companionId: WmAgentId,
  opts: { include_closed?: boolean; limit?: number } = {}
): Promise<WmOpenLoop[]> {
  const limit = opts.limit ?? 20;
  // Ordered by DECAYED weight (0118), so an un-acted loop restated for months sinks on its
  // own instead of holding a boot slot forever. `effective_weight` is returned alongside the
  // authored `weight` rather than replacing it -- a consumer that wants to show "authored 0.6,
  // now carrying 0.2" can, and nothing silently loses the number the companion actually set.
  const ew = effectiveWeightSql();
  const rows = opts.include_closed
    ? await env.DB.prepare(
        `SELECT *, ${ew} AS effective_weight FROM companion_open_loops
          WHERE companion_id = ? ORDER BY closed_at ASC, ${ew} DESC LIMIT ?`
      ).bind(companionId, limit).all<WmOpenLoop>()
    : await env.DB.prepare(
        `SELECT *, ${ew} AS effective_weight FROM companion_open_loops
          WHERE companion_id = ? AND closed_at IS NULL ORDER BY ${ew} DESC LIMIT ?`
      ).bind(companionId, limit).all<WmOpenLoop>();
  return rows.results ?? [];
}

export async function closeLoop(env: Env, id: string, companionId: WmAgentId): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE companion_open_loops SET closed_at = ? WHERE id = ? AND companion_id = ? AND closed_at IS NULL"
  ).bind(now, id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Record that the companion ACTED on a loop without closing it (migration 0118).
 *
 * This is Cypher's `acted` flag, in the form that carries information: a timestamp plus what
 * was done. It is the third distinct thing a companion can do with an open loop, and the one
 * that was missing --
 *
 *   closeLoop   it is resolved; stop carrying it.
 *   reviewLoop  it stays open on purpose, here is why (0082, suppresses the stuck flag 21d).
 *   actOnLoop   I did something about it and it is still open.
 *
 * Acting refreshes the decay anchor, because unlike restatement it is evidence of life.
 * Ownership-guarded, open loops only.
 */
export async function actOnLoop(
  env: Env, id: string, companionId: WmAgentId, note: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const trimmed = (note ?? "").trim().slice(0, 500);
  const result = await env.DB.prepare(
    `UPDATE companion_open_loops
        SET acted_at = ?, acted_note = ?
      WHERE id = ? AND companion_id = ? AND closed_at IS NULL`
  ).bind(now, trimmed || null, id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Hold a loop open on purpose (migration 0082, Guardian self-resolution). A companion
 * clearing its own loop_stuck flag can keep the loop but record WHY it stays; reviewed_at
 * suppresses the stuck flag for 21d (detectStuckLoops). The reason is appended to loop_text
 * so the held justification travels with the loop. Ownership-guarded; only an open loop.
 *
 * 0118 note: this rewrites loop_text and deliberately LEAVES loop_norm alone. That looks like
 * an oversight and is not: loop_norm must keep pointing at what the loop IS, not at its
 * accumulated "[held ...]" history. Recomputing it from the appended text would change the
 * dedup key on every hold, so the next restatement of the same loop would miss and start a
 * second pile beside it -- the exact accumulation 0118 exists to stop.
 */
export async function reviewLoop(
  env: Env, id: string, companionId: WmAgentId, reason: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const note = (reason ?? "").trim().slice(0, 280);
  const result = await env.DB.prepare(
    `UPDATE companion_open_loops
       SET reviewed_at = ?1,
           loop_text = CASE WHEN ?2 != '' THEN loop_text || ' [held ' || ?3 || ': ' || ?2 || ']' ELSE loop_text END
     WHERE id = ?4 AND companion_id = ?5 AND closed_at IS NULL`
  ).bind(now, note, now.slice(0, 10), id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Un-acted stasis: loops restated repeatedly that nobody ever acted on (0118).
 *
 * This is the measurement Cypher's write-gate would have made impossible. A write-gate is
 * unfalsifiable -- suppress the rows and you can neither detect the induction nor show the
 * fix worked. Keeping the rows and counting the restatements turns "I suspect the journal
 * reinforces the loop" into a number that can go down.
 */
export async function readUnactedStasis(
  env: Env,
  companionId: WmAgentId,
  opts: { min_restated?: number; limit?: number } = {}
): Promise<Array<{ id: string; loop_text: string; restated_count: number; opened_at: string; last_restated_at: string | null }>> {
  const minRestated = opts.min_restated ?? 2;
  const rows = await env.DB.prepare(
    `SELECT id, loop_text, restated_count, opened_at, last_restated_at
       FROM companion_open_loops
      WHERE companion_id = ? AND closed_at IS NULL AND acted_at IS NULL
        AND restated_count >= ?
      ORDER BY restated_count DESC, opened_at ASC LIMIT ?`
  ).bind(companionId, minRestated, opts.limit ?? 10)
    .all<{ id: string; loop_text: string; restated_count: number; opened_at: string; last_restated_at: string | null }>();
  return rows.results ?? [];
}
