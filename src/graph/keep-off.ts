// src/graph/keep-off.ts -- the names that never become a dot on the map (mig 0152).
//
// Raziel's list. graph/map.ts loadMapNodes drops any row whose words contain a listed term (a whole
// word, case-insensitive, any script), so the map, links and the [Linked] boot block all lose it at
// once: they share that one labeler. FAIL CLOSED: if the list cannot be read, the labeler returns no
// nodes at all (the map comes back empty and boots name nothing) rather than drawing rows the list was
// meant to hold back. An empty list costs one indexed SELECT and filters nothing.

import type { Env } from "../types.js";

export const TERM_MIN = 2;
export const TERM_MAX = 60;

export interface KeepOffRow { id: string; term: string; note: string | null; added_by: string; created_at: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One matcher for the live list, or null when the list is empty. Throws if the list cannot be read. */
export async function keepOffMatcher(env: Env): Promise<RegExp | null> {
  const rows = (await env.DB.prepare("SELECT term FROM map_keep_off WHERE archived = 0").all<{ term: string }>()).results ?? [];
  const terms = rows.map((r) => r.term.trim()).filter(Boolean);
  if (terms.length === 0) return null;
  // Whole word in any script: no letter or digit may touch either end ("Ava" never hides "Avalon").
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** True when any string field of a selected row names a listed term. */
export function rowNamesKeptOff(row: Record<string, unknown>, re: RegExp | null): boolean {
  if (!re) return false;
  for (const v of Object.values(row)) if (typeof v === "string" && re.test(v)) return true;
  return false;
}

export async function listKeepOff(env: Env): Promise<KeepOffRow[]> {
  return (await env.DB.prepare("SELECT id, term, note, added_by, created_at FROM map_keep_off WHERE archived = 0 ORDER BY term COLLATE NOCASE")
    .all<KeepOffRow>()).results ?? [];
}

export type AddOutcome = { ok: true; changed: boolean; row: KeepOffRow } | { ok: false; reason: string };

export async function addKeepOff(env: Env, args: { term: string; note?: string | null; by: string; now?: string }): Promise<AddOutcome> {
  const term = args.term.replace(/\s+/g, " ").trim();
  if (term.length < TERM_MIN || term.length > TERM_MAX) return { ok: false, reason: `a term is ${TERM_MIN}-${TERM_MAX} characters` };
  const existing = await env.DB.prepare("SELECT id, term, note, added_by, created_at FROM map_keep_off WHERE term = ? AND archived = 0")
    .bind(term).first<KeepOffRow>();
  if (existing) return { ok: true, changed: false, row: existing };
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = args.now ?? new Date().toISOString();
  await env.DB.prepare("INSERT INTO map_keep_off (id, term, note, added_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, term, args.note?.trim() || null, args.by, now).run();
  return { ok: true, changed: true, row: { id, term, note: args.note?.trim() || null, added_by: args.by, created_at: now } };
}

export async function archiveKeepOff(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE map_keep_off SET archived = 1 WHERE id = ? AND archived = 0").bind(id).run();
  return Number(r.meta?.changes ?? 0) > 0;
}
