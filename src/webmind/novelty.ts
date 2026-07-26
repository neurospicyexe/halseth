import { Env } from "../types.js";
import { embedText } from "../mcp/embed.js";

/** bge-base cosine thresholds. Tune from gate logs, not from vibes. */
export const NOVELTY_SKIP = 0.95;
export const NOVELTY_SUPERSEDE = 0.88;
const NOVELTY_TOPK = 3;

export type NoveltyDecision =
  | { action: "insert"; embedding: number[] | null }
  | { action: "skip"; matchRowId: string; score: number }
  | { action: "supersede"; matchRowId: string; score: number; embedding: number[] };

/**
 * Gate a candidate write against recent same-type vectors. Fails OPEN (insert)
 * on any embedding/Vectorize trouble -- the gate must never eat a memory.
 * Returns the embedding so the caller stores it without a second AI.run.
 */
export async function noveltyCheck(
  env: Env,
  text: string,
  table: string,
  companionId: string,
): Promise<NoveltyDecision> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(env, text);
  } catch { /* fail open */ }
  if (!embedding) return { action: "insert", embedding: null };

  let matches: Array<{ id: string; score: number }> = [];
  try {
    // Filter shape MUST match recallNotesByMeaning (src/webmind/notes.ts:368-381).
    // returnValues: true is NOT optional here -- proven live 2026-07-20: default
    // VECTORIZE.query scoring is approximate/quantized, so a vector queried against
    // its own byte-identical stored copy scored ~0.888 instead of 1.0. That silently
    // defeats NOVELTY_SKIP (0.95) -- identical text would fall into the supersede band
    // (or, for journal, into a dead skip-only gate) instead of being recognized as a
    // duplicate. returnValues: true forces full-precision scoring so the 0.95/0.88
    // thresholds mean what they say. (recallNotesByMeaning intentionally keeps the
    // cheaper approximate mode -- its 0.35 floor + soft re-rank tolerate the drift;
    // do not "fix" that one to match this.)
    const res = await env.VECTORIZE.query(embedding, {
      topK: NOVELTY_TOPK,
      filter: { table, companion_id: companionId },
      returnValues: true,
    });
    matches = (res.matches ?? []).map((m) => ({ id: String(m.id), score: m.score ?? 0 }));
  } catch {
    return { action: "insert", embedding };
  }
  if (matches.length === 0) return { action: "insert", embedding };

  const rowIdOf = (vecId: string) => (vecId.startsWith(`${table}:`) ? vecId.slice(table.length + 1) : vecId);

  // Defensive (proven live 2026-07-20 review): superseding a conclusion sets
  // superseded_by in D1, but the write paths only best-effort delete the OLD row's
  // vector (see the deleteByIds calls in handlers/conclusions.ts, librarian/executors/
  // writes.ts + session.ts) -- a dead row's vector can still surface here, either from
  // before that source-side cleanup existed or because a delete attempt failed. Matching a dead
  // row is a silent
  // no-op for supersede (the UPDATE's `superseded_by IS NULL` guard blocks it) while
  // the response still claims "superseded", and for skip it hands the caller a dead
  // row id. Post-filter against D1 and keep the highest-scoring row that is still
  // active; if none qualify, this is genuinely novel -- insert. Fails open: a D1
  // error here falls back to the pre-fix behavior (unfiltered top match) rather than
  // ever throwing the write away. Journal has no supersede lifecycle -- unchanged.
  let candidates = matches;
  if (table === "companion_conclusions") {
    try {
      const rowIds = matches.map((m) => rowIdOf(m.id));
      const placeholders = rowIds.map(() => "?").join(", ");
      const activeRows = await env.DB.prepare(
        `SELECT id FROM companion_conclusions WHERE id IN (${placeholders}) AND superseded_by IS NULL`,
      ).bind(...rowIds).all<{ id: string }>();
      const activeIds = new Set((activeRows.results ?? []).map((r) => r.id));
      candidates = matches.filter((m) => activeIds.has(rowIdOf(m.id)));
    } catch {
      candidates = matches; // fail open: behave as before the defensive check existed
    }
  }

  const top = candidates[0];
  if (!top) return { action: "insert", embedding };
  const matchRowId = rowIdOf(top.id);

  if (top.score >= NOVELTY_SKIP) {
    console.log("[novelty-gate] skip", { table, companionId, matchRowId, score: top.score });
    return { action: "skip", matchRowId, score: top.score };
  }
  if (top.score >= NOVELTY_SUPERSEDE && table === "companion_conclusions") {
    console.log("[novelty-gate] supersede", { table, companionId, matchRowId, score: top.score });
    return { action: "supersede", matchRowId, score: top.score, embedding };
  }
  return { action: "insert", embedding };
}
