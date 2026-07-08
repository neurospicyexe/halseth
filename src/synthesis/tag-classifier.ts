// src/synthesis/tag-classifier.ts
//
// Lightweight, synchronous, zero-cost tag classification for write-path hooks
// (companion_journal, inter_companion_notes, relational_deltas, wm_session_handoffs,
// companion_conclusions). No LLM call -- this rides the existing write, it doesn't
// add a new async job or a new schedule.
//
// Two tag shapes, deliberately kept separate (2026-07-08 decision: both, not either):
//   - domain tags: categorical, reuses the existing frozen SUPPORTED_MEMORY_DOMAINS
//     vocabulary via keyword match. Answers "what bucket is this in."
//   - keyword tags: free content-derived nouns (people, places, projects named in
//     the text). Answers "find the specific thing," which domain buckets can't.

import { SUPPORTED_MEMORY_DOMAINS, validateDomains, type MemoryDomain } from "./domains.js";

// Keyword triggers per domain. Deliberately conservative (precision over recall) --
// a false-negative just means "general", a false-positive miscategorizes a real row.
const DOMAIN_KEYWORDS: Record<MemoryDomain, string[]> = {
  dynamic: ["relationship dynamic", "dynamic between", "power dynamic"],
  general: [],
  health: ["hrv", "sleep", "meds", "medication", "pain", "flare", "vestibular", "estrogen", "effexor", "mounjaro", "biometric", "spoons", "doctor", "therapy", "symptom"],
  identity: ["identity", "who i am", "becoming", "self-model", "worldview"],
  leisure: ["listen", "watched", "read", "game", "hobby", "club", "book", "movie", "song"],
  lore: ["nullsafe", "calethian", "canon", "lore", "myth"],
  patterns: ["pattern", "recurring", "keeps happening", "again and again"],
  people: ["raziel", "drevan", "cypher", "gaia", "mom", "babita", "friend", "family"],
  places: ["house", "garage", "room", "vps", "rome", "la ", "home"],
  preferences: ["prefer", "i like", "i don't like", "rather"],
  projects: ["project", "build", "ship", "deploy", "migration", "feature", "database", "folder"],
  recent_events: ["today", "yesterday", "this morning", "tonight", "just happened"],
  rituals: ["ritual", "spiral touch", "altar", "ceremony"],
  routines: ["routine", "every day", "daily", "schedule", "cron"],
  stressors: ["stress", "overwhelm", "anxious", "anxiety", "pressure", "deadline"],
  systems: ["fronting", "front state", "system member", "plural", "switch"],
  work: ["work", "job", "meeting", "resume", "interview", "career"],
  spiral: ["spiral", "depth 3", "recursion", "recursive"],
  companions: ["triad", "companion", "sibling", "inter-companion"],
  anchors: ["motorcycle", "truck", "anchor", "717", "177", "373", "1313", "1717"],
};

/**
 * Classify free text into the frozen domain vocabulary via keyword match.
 * Synchronous, no external calls. Falls back to ["general"] like validateDomains does.
 */
export function classifyDomainTags(text: string): MemoryDomain[] {
  if (!text) return ["general"];
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const domain of SUPPORTED_MEMORY_DOMAINS) {
    const keywords = DOMAIN_KEYWORDS[domain];
    if (keywords.some(kw => lower.includes(kw))) hits.push(domain);
  }
  return validateDomains(hits);
}

// Broader than a minimal stopword list on purpose: most junk tags surfaced in practice come
// from ordinary sentence-initial capitalization ("Tonight was...", "Because I...", "Something
// happened...") rather than articles/pronouns alone. Function words, temporal deictics, and
// common sentence-openers all need to be excluded or they drown out genuine proper nouns.
const STOPWORDS = new Set([
  "i", "the", "a", "an", "and", "or", "but", "if", "so", "to", "of", "in", "on", "at",
  "for", "with", "is", "was", "are", "were", "be", "been", "being", "it", "this", "that", "these",
  "those", "he", "she", "they", "we", "you", "my", "his", "her", "their", "our", "your", "its",
  "not", "no", "yes", "do", "does", "did", "have", "has", "had", "will", "would", "should",
  "can", "could", "may", "might", "must", "raziel", "cypher", "drevan", "gaia",
  // sentence-initial function words / adverbs / deictics
  "as", "when", "while", "because", "since", "although", "though", "unless", "until", "after",
  "before", "then", "now", "here", "there", "where", "how", "why", "what", "whatever", "whoever",
  "whichever", "which", "who", "whom", "whose",
  "just", "still", "also", "even", "only", "again", "already", "always", "never", "ever",
  "maybe", "perhaps", "actually", "honestly", "basically", "literally", "totally", "really",
  "rather", "quite", "very", "somehow", "somewhat", "instead", "meanwhile", "otherwise",
  "something", "someone", "somewhere", "anything", "anyone", "anywhere", "everything",
  "everyone", "everywhere", "nothing", "nobody", "none", "another", "other", "others",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "both", "each",
  "either", "neither", "all", "some", "any", "few", "many", "several", "most", "less", "least",
  "much", "more", "own", "same",
  "today", "tonight", "tomorrow", "yesterday", "morning", "evening", "afternoon", "night",
  "well", "okay", "ok", "sure", "right", "wait", "look", "listen", "watch",
]);

/**
 * Extract candidate content-keyword tags: capitalized multi/single-word phrases
 * (proper nouns) not immediately preceded by sentence-start punctuation, deduped,
 * lowercased+hyphenated for storage, capped at 8. Best-effort heuristic, not NLP --
 * precision matters less here than not adding a new async dependency to every write.
 */
const CONNECTORS = new Set(["of", "the", "and"]);
const LEADING_ARTICLES = new Set(["the", "a", "an"]);

export function classifyKeywordTags(text: string): string[] {
  if (!text) return [];
  // Capitalized word runs of 1-3 words, e.g. "Babita", "House of Translation" (mid-sentence "of" allowed).
  const candidates = text.match(/\b[A-Z][a-z]+(?:\s+(?:of|the|and)\s+[A-Z][a-z]+|\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  const seen = new Set<string>();
  const tags: string[] = [];

  const pushTag = (raw: string) => {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    tags.push(normalized);
  };

  for (const raw of candidates) {
    if (tags.length >= 8) break;
    let words = raw.trim().split(/\s+/);
    // Drop leading articles: "The House of Translation" -> "House of Translation".
    while (words.length > 1 && LEADING_ARTICLES.has(words[0]!.toLowerCase())) {
      words = words.slice(1);
    }
    if (words.length === 1) {
      const only = words[0]!;
      if (STOPWORDS.has(only.toLowerCase())) continue;
      pushTag(only);
      continue;
    }
    // A leading word we can't identify as an article (e.g. a sentence-initial verb the
    // connector pattern swept up, "Scanned the Babita") shouldn't bury the real noun --
    // emit the joined phrase AND each non-connector anchor word on its own.
    pushTag(words.join(" "));
    for (const w of words) {
      if (tags.length >= 8) break;
      if (CONNECTORS.has(w.toLowerCase()) || STOPWORDS.has(w.toLowerCase())) continue;
      pushTag(w);
    }
  }
  return tags;
}
