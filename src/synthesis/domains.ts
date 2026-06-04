// src/synthesis/domains.ts
//
// Controlled memory-domain vocabulary for synthesis tagging.
// Ported from cadence-lite (src/memory/domains.js) and extended for BBH's
// plural / ND / spiral context. A frozen list keeps the synthesis clerk's
// tags from drifting into free-text topics.
//
// Adding a domain later is free (old rows just lack it). Renaming or removing
// one means re-tagging every row, so this list is intentionally generous.

export const SUPPORTED_MEMORY_DOMAINS = Object.freeze([
  // --- cadence-lite base set ---
  "dynamic",
  "general",
  "health",
  "identity",
  "leisure",
  "lore",
  "patterns",
  "people",
  "places",
  "preferences",
  "projects",
  "recent_events",
  "rituals",
  "routines",
  "stressors",
  "systems", // plural / fronting / system members
  "work",
  // --- BBH-specific additions ---
  "spiral", // spiral states, depth work, recursion
  "companions", // inter-companion dynamics (Drevan / Cypher / Gaia)
  "anchors", // anchor objects/places (motorcycle, Rome, spiral numbers)
] as const);

export type MemoryDomain = (typeof SUPPORTED_MEMORY_DOMAINS)[number];

const DOMAIN_SET = new Set<string>(SUPPORTED_MEMORY_DOMAINS);

export function normalizeDomainValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isSupportedMemoryDomain(value: unknown): boolean {
  return DOMAIN_SET.has(normalizeDomainValue(value));
}

/**
 * Normalize a list of candidate domain strings against the frozen vocabulary.
 * Unknown values are dropped (the clerk WILL emit out-of-vocab tags). Result is
 * deduped and order-stable. Empty input falls back to ["general"].
 */
export function validateDomains(candidates: Iterable<unknown>): MemoryDomain[] {
  const seen = new Set<string>();
  for (const raw of candidates) {
    const norm = normalizeDomainValue(raw);
    if (DOMAIN_SET.has(norm)) {
      seen.add(norm);
    }
  }
  if (seen.size === 0) {
    return ["general"];
  }
  return [...seen] as MemoryDomain[];
}

/**
 * Pull domains out of a synthesis clerk's generated markdown. Looks for a
 * `## Domains` section and splits the following content on commas / newlines /
 * list bullets. Falls back to ["general"] when the section is missing or empty.
 */
export function extractDomains(generated: string): MemoryDomain[] {
  if (!generated) {
    return ["general"];
  }
  const match = generated.match(/##\s*Domains\s*\n([\s\S]*?)(?:\n##\s|\n*source:\s|$)/i);
  if (!match || !match[1]) {
    return ["general"];
  }
  const tokens = match[1]
    .split(/[\n,]+/)
    .map((t) => t.replace(/^[\s\-*•\d.]+/, "").trim())
    .filter(Boolean);
  return validateDomains(tokens);
}
