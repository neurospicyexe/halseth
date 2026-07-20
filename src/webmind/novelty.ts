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
    const res = await env.VECTORIZE.query(embedding, {
      topK: NOVELTY_TOPK,
      filter: { table, companion_id: companionId },
    });
    matches = (res.matches ?? []).map((m) => ({ id: String(m.id), score: m.score ?? 0 }));
  } catch {
    return { action: "insert", embedding };
  }

  const top = matches[0];
  if (!top) return { action: "insert", embedding };
  const matchRowId = top.id.startsWith(`${table}:`) ? top.id.slice(table.length + 1) : top.id;

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
