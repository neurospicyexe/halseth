// src/webmind/motifs.ts
//
// Motif memory + field-feedback "resurrection" (Noor_Core; inspo-takes-2026-06-13 take 16).
// Pure layer: deterministic extraction + trust scoring + resurrection selection.
// The handler (handlers/motifs.ts) owns the SQL (watermark scan + UPSERT + orient).
//
// A motif is a recurring symbolic thread across a companion's journals/sessions.
// Noor's insight: RECURRENCE is the primary signal -- a phrase that keeps coming
// back is a first-class memory atom. We measure recurrence as document frequency
// (the number of DISTINCT entries a term/bigram appears in), never raw frequency,
// so a word repeated inside one entry doesn't masquerade as a recurring theme.
//
// Trust grows (saturating) with recurrence. A motif unseen past the fade window
// FADES but does not die: a high-trust faded motif gets re-surfaced -- resurrection,
// not deletion (field_feedback). Cooldown stops a resurrected motif nagging.

export interface MotifCandidate {
  label: string;       // normalized key
  display: string;     // human-facing phrase (first-seen casing)
  recurrence: number;  // distinct-entry document frequency in the scanned corpus
}

export interface MotifRow {
  id: string;
  companion_id: string;
  label: string;
  display: string;
  recurrence_count: number;
  trust: number;
  first_seen: string;
  last_seen: string;
  last_surfaced_at: string | null;
  status: string;
}

export const MOTIF_TUNING = {
  MIN_RECURRENCE: 2,            // appear in >= this many distinct entries to count
  MIN_TOKEN_LEN: 4,            // ignore tokens shorter than this (the, and, of...)
  MAX_MOTIFS_PER_SCAN: 40,     // cap upserts per detection run (don't flood)
  FADE_DAYS: 30,               // unseen past this -> faded (resurrection-eligible)
  RESURRECT_TRUST_FLOOR: 0.6,  // only faded motifs this trusted resurface
  RESURRECT_COOLDOWN_DAYS: 14, // don't re-surface a motif within this window
} as const;

// Common English + companion-system filler that carries no motif signal.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "was", "were",
  "are", "is", "be", "been", "being", "it", "its", "as", "at", "by", "to", "of", "in", "on",
  "or", "an", "a", "but", "not", "no", "so", "if", "then", "than", "into", "out", "up", "down",
  "what", "when", "where", "which", "who", "how", "why", "all", "any", "some", "more", "most",
  "can", "will", "would", "could", "should", "may", "might", "must", "do", "does", "did", "done",
  "about", "again", "just", "like", "only", "over", "very", "too", "also", "still", "here", "there",
  "they", "them", "their", "we", "us", "our", "you", "your", "he", "she", "his", "her", "i", "me",
  "my", "mine", "yours", "theirs", "ours", "am", "get", "got", "really", "thing", "things",
]);

const PUNCT_EDGE = /^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu;

/** Lowercase, trim, collapse whitespace, strip edge punctuation (keep internal hyphens). */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(PUNCT_EDGE, "");
}

/** Split a raw text into normalized content tokens (stopword + length filtered). */
function tokenize(text: string): { norm: string; raw: string }[] {
  const out: { norm: string; raw: string }[] = [];
  for (const raw of text.split(/[\s]+/)) {
    const cleaned = raw.replace(PUNCT_EDGE, "");
    if (!cleaned) continue;
    const norm = cleaned.toLowerCase();
    if (norm.length < MOTIF_TUNING.MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(norm)) continue;
    if (!/[\p{L}]/u.test(norm)) continue; // need at least one letter (skip pure numbers)
    out.push({ norm, raw: cleaned });
  }
  return out;
}

/**
 * Extract recurring motifs (unigrams + bigrams) from a corpus of entry texts.
 * Recurrence = number of DISTINCT entries the term/bigram appears in (document
 * frequency), so within-entry repetition never inflates a theme. Display form is
 * the first-seen casing. Returned sorted by recurrence desc, capped.
 */
export function extractMotifs(
  texts: string[],
  opts?: { minRecurrence?: number },
): MotifCandidate[] {
  const minRecurrence = opts?.minRecurrence ?? MOTIF_TUNING.MIN_RECURRENCE;
  const df = new Map<string, number>();          // label -> distinct-entry count
  const display = new Map<string, string>();     // label -> first-seen display form

  for (const text of texts) {
    if (!text || !text.trim()) continue;
    const tokens = tokenize(text);
    const seenInEntry = new Set<string>();        // count each label once per entry

    const note = (label: string, disp: string) => {
      if (seenInEntry.has(label)) return;
      seenInEntry.add(label);
      df.set(label, (df.get(label) ?? 0) + 1);
      if (!display.has(label)) display.set(label, disp);
    };

    for (let i = 0; i < tokens.length; i++) {
      note(tokens[i]!.norm, tokens[i]!.raw);
      if (i + 1 < tokens.length) {
        const bigramLabel = `${tokens[i]!.norm} ${tokens[i + 1]!.norm}`;
        const bigramDisplay = `${tokens[i]!.raw} ${tokens[i + 1]!.raw}`;
        note(bigramLabel, bigramDisplay);
      }
    }
  }

  return [...df.entries()]
    .filter(([, n]) => n >= minRecurrence)
    .map(([label, recurrence]) => ({ label, display: display.get(label) ?? label, recurrence }))
    .sort((a, b) => b.recurrence - a.recurrence || a.label.localeCompare(b.label))
    .slice(0, MOTIF_TUNING.MAX_MOTIFS_PER_SCAN);
}

/** Saturating, monotonic trust in [~0.2, 0.95]. Recurrence is the only input. */
export function trustForRecurrence(recurrence: number): number {
  const r = Math.max(1, recurrence);
  const t = 0.2 + 0.18 * Math.log2(1 + r); // log2(2)=1 -> 0.38 at r=1
  return Math.min(0.95, Math.round(t * 1000) / 1000);
}

/** D1 datetime('now') strings are "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker). */
function parseDbUtc(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/** active if seen within the fade window, else faded. (retired is set manually.) */
export function classifyStatus(lastSeen: string, now: number = Date.now()): "active" | "faded" {
  const ageDays = (now - parseDbUtc(lastSeen)) / 86400_000;
  return ageDays <= MOTIF_TUNING.FADE_DAYS ? "active" : "faded";
}

/**
 * field_feedback "resurrection": pick faded motifs trusted enough to lift back into
 * view, that haven't been surfaced within the cooldown. Highest trust first, capped.
 */
export function selectResurrections(
  rows: MotifRow[],
  now: number = Date.now(),
  opts?: { limit?: number; trustFloor?: number; cooldownDays?: number },
): MotifRow[] {
  const limit = opts?.limit ?? 3;
  const trustFloor = opts?.trustFloor ?? MOTIF_TUNING.RESURRECT_TRUST_FLOOR;
  const cooldownMs = (opts?.cooldownDays ?? MOTIF_TUNING.RESURRECT_COOLDOWN_DAYS) * 86400_000;
  return rows
    .filter(r => r.status === "faded" && r.trust >= trustFloor)
    .filter(r => !r.last_surfaced_at || now - parseDbUtc(r.last_surfaced_at) >= cooldownMs)
    .sort((a, b) => b.trust - a.trust || b.recurrence_count - a.recurrence_count)
    .slice(0, limit);
}
