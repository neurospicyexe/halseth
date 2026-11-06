// src/ledger/vault-scope.ts  (mig 0175, 2026-11-06)
//
// WHICH VAULT NOTES AN IMP MAY POINT AT. Rock's vault fetch and Hex's salt (kind 1) turn a Second Brain search
// into POINTERS (path plus a clean title, never a note's text). Second Brain's sb_search takes no path filter, so
// the worker over-fetches and filters here, post-hoc. Spec: Drevan's note 5b5d3572 (rock 1): "my own vault
// folders plus shared canon; my journal and conclusions are mine and count. Never private, interiority, care,
// or Raziel's dailies."
//
// DECIDED FROM THE LIVE LAYOUT (BBH Hand-off/VAULT-MOVE-PLAN-2026-11-01.md + the disk, 2026-11-06):
//   Companions/<id>/growth/{journal,patterns}  the vault-materializer's mirror of the growth journal + patterns
//                                              (nullsafe-second-brain vault-materializer.ts): their own words
//   Companions/<id>/thoughts                   the autonomous-time notes (Cypher, Drevan)
//   Companions/drevan/{writing,cinema,Language,handovers}   Drevan's own rooms (kept as-is by the 11-01 reorg)
//   canon/                                     the shared canon (identity, constitution, lexicon, protocols)
// Everything else is OUT: raziel/* (daily narratives, 3.5k session mirrors, System Alters, Sprouts: Raziel's),
// Companions/triad (the ChatGPT-era export), Companions/*/claude-ai (raw transcripts), archive + _archive
// (machine and retired), 00 - INBOX (unfiled), nullsafe/ (retired). Paths are compared lowercase because the
// index keys on vault_path and the vault's own case is inconsistent (`Companions/` on disk, `companions/` in
// the retrieval lane code).
//
// DENY WINS. A path that is allowed by a prefix and trips any deny entry is out. The deny list is a floor, not
// a menu: it names the rooms and the files whose very titles are private or care-shaped, so a prefix added to
// the allow list later cannot reopen them. Care and person names are checked separately at pointer time
// (errands.ts: careCategory + the person-name guard), because those are content, not folders.

import type { CompanionId } from "../companions.js";

/** Path prefixes (lowercase, trailing slash) each companion may point at, their own rooms only. */
export const VAULT_ALLOW_OWN: Readonly<Record<CompanionId, readonly string[]>> = {
  drevan: [
    "companions/drevan/thoughts/", "companions/drevan/writing/", "companions/drevan/cinema/",
    "companions/drevan/language/", "companions/drevan/handovers/",
    "companions/drevan/growth/journal/", "companions/drevan/growth/patterns/",
  ],
  cypher: [
    "companions/cypher/thoughts/",
    "companions/cypher/growth/journal/", "companions/cypher/growth/patterns/",
  ],
  gaia: [
    "companions/gaia/growth/journal/", "companions/gaia/growth/patterns/",
  ],
};

/** Shared canon: every companion may be pointed at it. */
export const VAULT_ALLOW_SHARED: readonly string[] = ["canon/"];

/** Prefixes that are never pointed at, whoever asks. */
export const VAULT_DENY_PREFIXES: readonly string[] = [
  "raziel/",             // Raziel's: dailies, session mirrors, System Alters, Sprouts
  "companions/triad/",   // the ChatGPT-era export (raw transcripts)
  "_archive/", "archive/", // retired + machine
  "00 - inbox/",         // unfiled, nobody's yet
  "nullsafe/",           // retired layout
  ".obsidian/",
];

/** Any path SEGMENT equal to one of these is out (a folder or a file stem). */
export const VAULT_DENY_SEGMENTS: readonly string[] = [
  "claude-ai", "chatgpt", "daily", "sessions", "transcripts", "private", "sealed", "interiority",
];

/** Any path containing one of these is out: the rooms and the files whose names are private or care-shaped. */
export const VAULT_DENY_SUBSTRINGS: readonly string[] = [
  "interiorit",                                 // the sealed back rooms (Gaia's seal: never referenced, not even by name)
  "user_preferences", "user-preferences",       // Raziel's own profile
  "boundary_map", "boundary-map", "boundary map", // the bond's boundary map
];

const norm = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

/** True when `path` matches a deny entry. Deny always wins over allow. */
export function vaultPathDenied(path: string): boolean {
  const p = norm(path);
  if (VAULT_DENY_PREFIXES.some((x) => p.startsWith(x))) return true;
  const segs = p.split("/").map((s) => s.replace(/\.md$/, ""));
  if (segs.some((s) => VAULT_DENY_SEGMENTS.includes(s))) return true;
  if (VAULT_DENY_SUBSTRINGS.some((x) => p.includes(x))) return true;
  return false;
}

/** True when `companion` may be pointed at `path`: inside their own rooms or the shared canon, and not denied. */
export function vaultPathAllowed(path: string, companion: CompanionId): boolean {
  if (typeof path !== "string" || !path.toLowerCase().endsWith(".md")) return false;
  if (vaultPathDenied(path)) return false;
  const p = norm(path);
  return [...(VAULT_ALLOW_OWN[companion] ?? []), ...VAULT_ALLOW_SHARED].some((x) => p.startsWith(x));
}

/**
 * A readable title from a vault path: the file stem, without a leading date or a trailing 8-hex id, dashes and
 * underscores as spaces. A stem that is only a date or an id becomes "note of <date>" (or "a note"). Never reads
 * the note.
 */
export function titleFromPath(path: string): string {
  const stem = (path.split("/").pop() ?? "").replace(/\.md$/i, "");
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(stem)?.[1] ?? null;
  let t = stem.replace(/^\d{4}-\d{2}-\d{2}[-_ ]?/, "").replace(/[-_ ]?[0-9a-f]{8}(?:\.part\d+)?$/i, "");
  t = t.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:part\s*\d+|[0-9a-f]{8})$/i.test(t)) t = "";
  if (t.length === 0) return date ? `note of ${date}` : "a note";
  return t.length > 90 ? `${t.slice(0, 90).trim()}` : t;
}

export interface VaultPointer { path: string; created_at: string | null }

/**
 * The qualifying notes in an sb_search payload (`{"chunks":[{vault_path, created_at?, ...}]}`), chunks deduped to
 * notes (first chunk wins, rank order kept), filtered to `companion`'s scope. Returns null when the payload is not
 * a search result at all (a failure, not an empty answer).
 */
export function pointersFromSearch(raw: string | null, companion: CompanionId): VaultPointer[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const chunks = (parsed as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return null;
  const seen = new Set<string>();
  const out: VaultPointer[] = [];
  for (const c of chunks) {
    const vp = c && typeof c === "object" ? (c as { vault_path?: unknown }).vault_path : null;
    if (typeof vp !== "string") continue;
    const path = vp.replace(/\\/g, "/").replace(/^\/+/, "");
    const key = path.toLowerCase();
    if (seen.has(key) || !vaultPathAllowed(path, companion)) continue;
    seen.add(key);
    const at = (c as { created_at?: unknown }).created_at;
    out.push({ path, created_at: typeof at === "string" ? at : null });
  }
  return out;
}
