// src/webmind/dream-modes.ts
//
// Dream engine expansion (inspo-takes-2026-06-13 take 3 -- muse-brain's six association
// modes). Our reflect/dream surface was thin; this adds two deterministic association
// modes that find SURPRISING connections in a companion's recent material and phrase them
// as dreams (held at orient until examined). Deterministic, no LLM -- same instrument-not-
// judge spirit as motifs/guardian; the companion explores the dream AS themselves later.
//
//   - entity-cluster: which significant terms keep ARRIVING TOGETHER across entries
//     ("birds connect to safety, home"). Co-document-frequency, not raw frequency.
//   - temporal-pattern: a CADENCE -- material that recurs around the same hour of day,
//     a rhythm the companion didn't consciously set.

export interface DreamDoc {
  text: string;
  created_at: string; // D1 "YYYY-MM-DD HH:MM:SS" UTC or ISO
}

const MIN_TOKEN_LEN = 4;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "was", "were",
  "are", "is", "be", "been", "being", "its", "as", "at", "by", "to", "of", "in", "on",
  "or", "an", "but", "not", "no", "so", "if", "then", "than", "into", "out", "what", "when",
  "where", "which", "who", "how", "why", "all", "any", "some", "more", "most", "can", "will",
  "would", "could", "should", "may", "might", "must", "does", "did", "done", "about", "again",
  "just", "like", "only", "over", "very", "too", "also", "still", "here", "there", "they",
  "them", "their", "we", "us", "our", "you", "your", "his", "her", "me", "my", "mine",
  "really", "thing", "things", "been", "feel", "feels", "felt",
]);
const PUNCT_EDGE = /^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu;

/** Distinct significant tokens in one doc (lowercased, stopword + length filtered). */
export function docTokens(text: string): string[] {
  const set = new Set<string>();
  for (const raw of (text ?? "").split(/\s+/)) {
    const norm = raw.replace(PUNCT_EDGE, "").toLowerCase();
    if (norm.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(norm)) continue;
    if (!/[\p{L}]/u.test(norm)) continue;
    set.add(norm);
  }
  return [...set];
}

/**
 * Entity-cluster dream: the pair of terms that co-occur in the most DISTINCT entries
 * (>= minPairDocs). Returns a dream text, or null when nothing meaningfully clusters.
 */
export function entityClusterDream(docs: DreamDoc[], minPairDocs = 2): string | null {
  const pairCount = new Map<string, number>(); // "a|b" (a<b) -> distinct-doc co-occurrence
  for (const doc of docs) {
    const toks = docTokens(doc.text).sort();
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        const key = `${toks[i]}|${toks[j]}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  let best: { a: string; b: string; n: number } | null = null;
  for (const [key, n] of pairCount) {
    if (n < minPairDocs) continue;
    const [a, b] = key.split("|") as [string, string];
    if (!best || n > best.n || (n === best.n && key < `${best.a}|${best.b}`)) best = { a, b, n };
  }
  if (!best) return null;
  return `In the drift between sessions, "${best.a}" and "${best.b}" keep arriving together (${best.n} times) -- as if one calls the other. What is the thread between them?`;
}

/** Hour-of-day (UTC, 0-23) from a D1/ISO timestamp, or null if unparseable. */
function hourOf(iso: string): number | null {
  const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(ms)) return null;
  return new Date(ms).getUTCHours();
}

/**
 * Temporal-pattern dream: a cadence by hour-of-day. If a 3-hour window holds at least
 * `minInWindow` entries AND a majority of all timestamped entries, that rhythm becomes
 * the dream. Returns null when activity is evenly spread (no real cadence).
 */
export function temporalPatternDream(docs: DreamDoc[], minInWindow = 3): string | null {
  const hours = docs.map(d => hourOf(d.created_at)).filter((h): h is number => h !== null);
  if (hours.length < minInWindow) return null;
  // Slide a 3-hour wrap-around window; find the densest start hour.
  let bestStart = 0, bestCount = 0;
  for (let start = 0; start < 24; start++) {
    const count = hours.filter(h => {
      const d = (h - start + 24) % 24;
      return d < 3;
    }).length;
    if (count > bestCount) { bestCount = count; bestStart = start; }
  }
  if (bestCount < minInWindow || bestCount <= hours.length / 2) return null;
  const end = (bestStart + 2) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `A rhythm shows itself: ${bestCount} of your recent reflections gathered around ${pad(bestStart)}:00-${pad(end)}:00 UTC -- the same hour, again and again. What returns to you then?`;
}

/** Run both modes over a corpus; returns the dream texts that fired (0-2). */
export function associateDreams(docs: DreamDoc[]): string[] {
  const out: string[] = [];
  const cluster = entityClusterDream(docs);
  if (cluster) out.push(cluster);
  const temporal = temporalPatternDream(docs);
  if (temporal) out.push(temporal);
  return out;
}
