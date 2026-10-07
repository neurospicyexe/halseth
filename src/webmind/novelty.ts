import { Env } from "../types.js";
import { embedText } from "../mcp/embed.js";

/** bge-base cosine thresholds. Tune from gate logs, not from vibes. */
export const NOVELTY_SKIP = 0.95;
export const NOVELTY_SUPERSEDE = 0.88;

/**
 * How long a gate-proposed supersession stays visible to the companion who owns the belief (mig 0112).
 *
 * TIME-BOXED, with no dismissal action and no queue. Raziel's decision is that a companion supersedes
 * their own thought, so the gate can only ever ask -- and a question that cannot expire becomes a nag
 * that trains you to scroll past it. That is the rails-need-decay lesson, which has already recurred
 * twice here. If the companion does not act within the window, the proposal fades and the older belief
 * simply stays live, which is the correct default: not-retired is the safe state.
 */
export const SUPERSEDE_CANDIDATE_WINDOW_DAYS = 14;
const NOVELTY_TOPK = 3;

export type NoveltyDecision =
  /** `nearest` (2026-10-07): the best LIVE candidate that did not clear a threshold, when there was
   *  one. Additive and optional -- callers that ignore it behave exactly as before. architect_facts
   *  uses it to hand the companion the id of the row its new fact most resembles, because a fact
   *  that updates an older one cannot retire it unless the writer can NAME it. */
  | { action: "insert"; embedding: number[] | null; nearest?: { matchRowId: string; score: number } }
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
  /**
   * Whose pile to dedupe against. Default "companion" preserves every existing caller exactly.
   *
   * "table" omits the companion filter, and exists because `architect_facts` are facts about
   * RAZIEL, not beliefs belonging to whoever happened to notice them. Measured 2026-09-24: of the
   * 9 duplicate clusters in the held pile, **5 spanned more than one companion** -- the largest
   * (six rows about Rosie and Trigger) was written by all three. A companion-scoped gate would
   * have missed every one of those, which is most of the problem it was added to solve.
   *
   * A conclusion is correctly companion-scoped and must stay that way: two companions reaching
   * the same belief independently is signal, not duplication.
   */
  scope: "companion" | "table" = "companion",
  /**
   * architect_facts only (2026-10-07). When set, a candidate whose row is `status='open'` and scores
   * at or above this threshold answers `skip` even below NOVELTY_SKIP. Pass it ONLY for an
   * `status='open'` write: an open fact is a QUESTION to ask Raziel, and a second phrasing of a
   * question already being held adds load, never information. Measured on prod: the two open
   * "Magpie's pronouns" rows (drain output 90 minutes apart, 466 vs 200 chars) scored 0.817 --
   * nowhere near 0.95 -- and they are the ONLY open/open pair at or above 0.80 among 111 indexed
   * live facts. Active facts keep the strict 0.95: a near-match there is usually a partial record
   * (the Rosie cluster), and skipping one would lose a fact.
   */
  opts: { openSkipThreshold?: number } = {},
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
      filter: scope === "table" ? { table } : { table, companion_id: companionId },
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
        `SELECT id FROM companion_conclusions WHERE id IN (${placeholders}) AND superseded_by IS NULL AND archived = 0`,
      ).bind(...rowIds).all<{ id: string }>();
      const activeIds = new Set((activeRows.results ?? []).map((r) => r.id));
      candidates = matches.filter((m) => activeIds.has(rowIdOf(m.id)));
    } catch {
      candidates = matches; // fail open: behave as before the defensive check existed
    }
  }

  // Same defence as the conclusions block above, for the same reason: a retired fact's vector can
  // outlive it (the supersede path only best-effort deletes), and matching a dead row would hand
  // the caller a `skip` pointing at a fact nothing renders -- which reads to a companion as "I
  // already know that" about something the system has actually forgotten.
  const factStatus = new Map<string, string>();
  if (table === "architect_facts") {
    try {
      const rowIds = candidates.map((m) => rowIdOf(m.id));
      const placeholders = rowIds.map(() => "?").join(", ");
      const live = await env.DB.prepare(
        `SELECT id, status FROM architect_facts WHERE id IN (${placeholders}) AND status != 'retired'`,
      ).bind(...rowIds).all<{ id: string; status?: string }>();
      for (const r of live.results ?? []) factStatus.set(r.id, r.status ?? "active");
      candidates = candidates.filter((m) => factStatus.has(rowIdOf(m.id)));
    } catch {
      candidates = candidates; // fail open
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
  if (opts.openSkipThreshold !== undefined && table === "architect_facts") {
    // Candidates are score-ordered, so the first open one above the bar is the closest held question.
    const sameQuestion = candidates.find(
      (m) => m.score >= opts.openSkipThreshold! && factStatus.get(rowIdOf(m.id)) === "open",
    );
    if (sameQuestion) {
      const id = rowIdOf(sameQuestion.id);
      console.log("[novelty-gate] skip-open", { table, companionId, matchRowId: id, score: sameQuestion.score });
      return { action: "skip", matchRowId: id, score: sameQuestion.score };
    }
  }
  return { action: "insert", embedding, nearest: { matchRowId, score: top.score } };
}
