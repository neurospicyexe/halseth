// src/librarian/lib/companion.ts
//
// Extracts a companion name from a natural language request string.
// Falls back to the provided default when no name is found.

export type CompanionName = "drevan" | "cypher" | "gaia";

export function extractCompanionFromRequest(request: string): CompanionName | null;
export function extractCompanionFromRequest(request: string, fallback: string): string;
export function extractCompanionFromRequest(request: string, fallback: string | null = null): string | null {
  if (/\bdrevan\b/i.test(request)) return "drevan";
  if (/\bcypher\b/i.test(request)) return "cypher";
  if (/\bgaia\b/i.test(request)) return "gaia";
  return fallback;
}
