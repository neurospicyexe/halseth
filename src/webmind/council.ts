// src/webmind/council.ts
//
// Council mode (migration 0080, inspo take 8 -- karpathy/llm-council). Raziel poses a
// hard question; each companion answers in-voice; a BLIND anonymized cross-rank runs
// (each companion ranks the OTHER answers without knowing whose is whose, so it can't
// play favorites); Gaia synthesizes as chairman (her seal-class lane fits the chair).
//
// The novel mechanic worth lifting is the anonymized rank: the worker shows a ranker
// labelled answers ("Answer A/B/...") and keeps the label->companion map server-side,
// then de-anonymizes the returned order before storing. This module holds the pure,
// testable pieces of that: blinding, label parsing, and the Borda tally.

export interface CouncilAnswer {
  companion_id: string;
  answer: string;
}

export interface BlindedAnswer {
  label: string;        // "Answer A", "Answer B", ...
  companion_id: string; // kept server-side -- never shown to the ranker
  answer: string;
}

const LABELS = "ABCDEFGH".split("");

/**
 * Blind the peer answers for one ranker: drop the ranker's own answer, then label the
 * rest A.. in an order rotated by `rotate` (so the label->author convention is not
 * stable across rankers and a model can't learn "A is always Cypher"). Deterministic
 * for a given rotate -- the worker passes the ranker's index so each sees a different
 * permutation; tests pass it explicitly.
 */
export function blindForRanker(answers: CouncilAnswer[], rankerId: string, rotate = 0): BlindedAnswer[] {
  const peers = answers.filter(a => a.companion_id !== rankerId);
  const n = peers.length;
  if (n === 0) return [];
  const rot = ((rotate % n) + n) % n;
  const rotated = [...peers.slice(rot), ...peers.slice(0, rot)];
  return rotated.map((a, i) => ({ label: `Answer ${LABELS[i] ?? String(i + 1)}`, companion_id: a.companion_id, answer: a.answer }));
}

/**
 * Parse an LLM ranking response back to an ordered list of companion_ids (best first).
 * Accepts "A > B", "A, B", '["A","B"]', "1. Answer A\n2. Answer B" -- anything where the
 * bare letters appear in preference order. Unknown/duplicate letters are dropped; any
 * blinded answer the model omitted is appended in its presented order so every peer is
 * still ranked (a missing mention is treated as least-preferred, stably).
 */
export function parseRanking(raw: string, blinded: BlindedAnswer[]): string[] {
  const labelToCompanion = new Map<string, string>();
  for (const b of blinded) {
    // The label letter is the trailing token ("Answer A" -> "A"); do NOT scan the whole
    // string ("Answer" itself contains A and E).
    const letter = b.label.trim().slice(-1).toUpperCase();
    if (/[A-H]/.test(letter)) labelToCompanion.set(letter, b.companion_id);
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Letters that are actually valid labels, in the order they appear in the text.
  const matches = raw.toUpperCase().match(/\b[A-H]\b/g) ?? [];
  for (const letter of matches) {
    const companion = labelToCompanion.get(letter);
    if (companion && !seen.has(companion)) {
      seen.add(companion);
      ordered.push(companion);
    }
  }
  // Append any peer the model never named, in presentation order (least-preferred, stable).
  for (const b of blinded) {
    if (!seen.has(b.companion_id)) {
      seen.add(b.companion_id);
      ordered.push(b.companion_id);
    }
  }
  return ordered;
}

/**
 * Borda tally over all rankers' de-anonymized orderings. With P peers ranked, the top
 * pick earns P points, next P-1, etc. Sum across rankers; highest total wins. Ties break
 * deterministically by companion_id (alphabetical) so a re-run is stable.
 */
export function tallyRankings(
  rankings: Array<{ ranking: string[] }>,
  candidates: string[],
): { winner: string | null; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  for (const c of candidates) scores[c] = 0;
  for (const r of rankings) {
    const len = r.ranking.length;
    r.ranking.forEach((companion, i) => {
      if (companion in scores) scores[companion] = (scores[companion] ?? 0) + (len - i);
    });
  }
  let winner: string | null = null;
  let best = -Infinity;
  for (const c of [...candidates].sort()) {
    if (scores[c]! > best) { best = scores[c]!; winner = c; }
  }
  return { winner, scores };
}

// ── SQL builders (asserted as strings in tests; D1 is the runtime) ──────────────

/** Insert a convened question. Bind: [id, question, asked_by]. */
export function insertQuestionSql(): string {
  return `INSERT INTO council_questions (id, question, asked_by) VALUES (?, ?, ?)`;
}

/** Oldest open question. No bind. */
export function nextOpenQuestionSql(): string {
  return `SELECT id, question, asked_by, status FROM council_questions WHERE status = 'open' ORDER BY created_at ASC LIMIT 1`;
}

/** Append an answer. Bind: [id, question_id, companion_id, answer]. */
export function insertAnswerSql(): string {
  return `INSERT INTO council_answers (id, question_id, companion_id, answer) VALUES (?, ?, ?, ?)`;
}

/** Append a (de-anonymized) ranking. Bind: [id, question_id, ranker_id, ranking_json]. */
export function insertRankingSql(): string {
  return `INSERT INTO council_rankings (id, question_id, ranker_id, ranking_json) VALUES (?, ?, ?, ?)`;
}

/** Close a question with the chairman synthesis + winner. Bind: [winner, synthesis, id]. */
export function closeQuestionSql(): string {
  return `UPDATE council_questions SET status = 'closed', winning_companion_id = ?, synthesis = ?, closed_at = datetime('now') WHERE id = ?`;
}
