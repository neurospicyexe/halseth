// src/webmind/pins.ts  (mig 0148, Memory Kit gap 4, 2026-10-28)
//
// A pin is a companion's (or Raziel's) "keep this in front of me." Two effects, nothing else:
//   1. ORIENT SLOT. Pinned conclusions fill the active-conclusion list first, then the heat-ranked
//      fill takes what is left of CONCLUSION_CAP (6). Pinned notes lead the core pool, then heat
//      fills the rest of its 3. Pins count AGAINST the existing slots on purpose: the prompt stays
//      the same size and the bots (which render 5 conclusions / 3 notes) need no change. The caps
//      below leave at least one fresh slot in each, so a pin can never freeze the orient.
//   2. EXEMPTION. A pinned note is never cap-evicted, compressed or demoted (webmind/notes.ts).
//
// What a pin does NOT do:
//   - write heat (hard law: surfacing never feeds the ranking that decides surfacing);
//   - beat a release (archived = 1 hides it like any row; undo restores it still pinned);
//   - lift a draft: only a kept row can be pinned (the tray decides first);
//   - bypass a relevance floor in recall (an irrelevant pinned note still is not injected).
//
// Supersede carries the pin to the successor (carryPinStatement), or the monthly rewrite pass,
// which supersedes, would silently unpin everything it touched.

import type { Env } from "../types.js";
import { KEPT_SQL } from "./review-state.js";

export type PinKind = "conclusion" | "note";

/** Per companion, per kind. Conclusions: 5 of the orient's 6. Notes: 2 of core's 3. */
export const PIN_CAP: Record<PinKind, number> = { conclusion: 5, note: 2 };

const KIND: Record<PinKind, { table: string; idCol: string; ownerCol: string; live: string; text: string }> = {
  conclusion: { table: "companion_conclusions", idCol: "id", ownerCol: "companion_id", live: "superseded_by IS NULL AND archived = 0", text: "conclusion_text" },
  note: { table: "wm_continuity_notes", idCol: "note_id", ownerCol: "agent_id", live: `archived = 0 AND ${KEPT_SQL}`, text: "content" },
};

export function parsePinKind(raw: unknown): PinKind | null {
  return raw === "conclusion" || raw === "note" ? raw : null;
}

export interface PinnedRow { id: string; text: string; pinned_at: string; pinned_by: string | null }

/** The companion's live pins of one kind, oldest pin first (the order orient uses). */
export async function listPins(env: Env, kind: PinKind, owner: string): Promise<PinnedRow[]> {
  const k = KIND[kind];
  const r = await env.DB.prepare(
    `SELECT ${k.idCol} AS id, ${k.text} AS text, pinned_at, pinned_by FROM ${k.table}
      WHERE ${k.ownerCol} = ? AND pinned_at IS NOT NULL AND ${k.live}
      ORDER BY pinned_at ASC LIMIT ?`,
  ).bind(owner, PIN_CAP[kind]).all<PinnedRow>();
  return r.results ?? [];
}

export type PinOutcome =
  | { ok: true; changed: boolean; pins: PinnedRow[] }
  | { ok: false; reason: "not_found" | "cap_reached"; pins: PinnedRow[] };

/** Pin one live row the owner holds. Idempotent; refuses (no auto-eviction) at the cap. */
export async function pinRow(env: Env, args: { kind: PinKind; id: string; owner: string; by: string; now?: string }): Promise<PinOutcome> {
  const k = KIND[args.kind];
  const row = await env.DB.prepare(
    `SELECT ${k.idCol} AS id, pinned_at FROM ${k.table} WHERE ${k.idCol} = ? AND ${k.ownerCol} = ? AND ${k.live}`,
  ).bind(args.id, args.owner).first<{ id: string; pinned_at: string | null }>();
  const pins = await listPins(env, args.kind, args.owner);
  if (!row) return { ok: false, reason: "not_found", pins };
  if (row.pinned_at) return { ok: true, changed: false, pins };
  if (pins.length >= PIN_CAP[args.kind]) return { ok: false, reason: "cap_reached", pins };
  // 2026-10-29 (L-3): the count above is only a fast path; two racing pins both read cap-1 and both
  // wrote. The UPDATE itself carries the cap (live pinned count < cap, in the WHERE), so D1's
  // single-writer serialisation decides who gets the last slot.
  const res = await env.DB.prepare(
    `UPDATE ${k.table} SET pinned_at = ?, pinned_by = ?
      WHERE ${k.idCol} = ? AND ${k.ownerCol} = ? AND pinned_at IS NULL
        AND (SELECT COUNT(*) FROM ${k.table} WHERE ${k.ownerCol} = ? AND pinned_at IS NOT NULL AND ${k.live}) < ?`,
  ).bind(args.now ?? new Date().toISOString(), args.by, args.id, args.owner, args.owner, PIN_CAP[args.kind]).run();
  if ((res.meta?.changes ?? 0) === 0) {
    // Row exists and was unpinned a moment ago: either the cap filled, or a twin call pinned this
    // very row first (idempotent success, not a refusal).
    const now = await env.DB.prepare(
      `SELECT pinned_at FROM ${k.table} WHERE ${k.idCol} = ? AND ${k.ownerCol} = ?`,
    ).bind(args.id, args.owner).first<{ pinned_at: string | null }>();
    const after = await listPins(env, args.kind, args.owner);
    if (now?.pinned_at) return { ok: true, changed: false, pins: after };
    return { ok: false, reason: "cap_reached", pins: after };
  }
  return { ok: true, changed: true, pins: await listPins(env, args.kind, args.owner) };
}

/** Unpin. Works on any row the owner holds (a released or superseded row can still be unpinned). */
export async function unpinRow(env: Env, args: { kind: PinKind; id: string; owner: string }): Promise<{ changed: boolean; pins: PinnedRow[] }> {
  const k = KIND[args.kind];
  const r = await env.DB.prepare(
    `UPDATE ${k.table} SET pinned_at = NULL, pinned_by = NULL WHERE ${k.idCol} = ? AND ${k.ownerCol} = ? AND pinned_at IS NOT NULL`,
  ).bind(args.id, args.owner).run();
  return { changed: (r.meta?.changes ?? 0) > 0, pins: await listPins(env, args.kind, args.owner) };
}

/**
 * Supersede carries the pin. Batch this BEFORE the `SET superseded_by` UPDATE (it reads the old row
 * while it is still live). The successor keeps the original pinned_at, so its place in pin order
 * and the cap count are unchanged; the old row's pin stays on it as history (it is out of view).
 */
export function carryPinStatement(db: D1Database, args: { oldId: string; newId: string; owner: string }): D1PreparedStatement {
  return db.prepare(
    `UPDATE companion_conclusions
        SET pinned_at = (SELECT o.pinned_at FROM companion_conclusions o WHERE o.id = ? AND o.companion_id = ?),
            pinned_by = (SELECT o.pinned_by FROM companion_conclusions o WHERE o.id = ? AND o.companion_id = ?)
      WHERE id = ? AND companion_id = ? AND pinned_at IS NULL
        AND EXISTS (SELECT 1 FROM companion_conclusions o
                     WHERE o.id = ? AND o.companion_id = ? AND o.pinned_at IS NOT NULL
                       AND o.superseded_by IS NULL AND o.archived = 0)`,
  ).bind(args.oldId, args.owner, args.oldId, args.owner, args.newId, args.owner, args.oldId, args.owner);
}

/** Live rows of the owner's whose text contains `quote` (case-insensitive, literal), newest first, at
 *  most 6. `pinnedOnly` narrows to current pins (for unpin). Lets a companion pin by quoting a few
 *  words: the bot wire never carries conclusion ids, so "pin conclusion: <words>" is the only form a
 *  Discord turn can actually use. */
export async function findByQuote(env: Env, args: { kind: PinKind; owner: string; quote: string; pinnedOnly?: boolean }): Promise<Array<{ id: string; text: string }>> {
  const k = KIND[args.kind];
  // `!` is the LIKE escape: a quoted % or _ matches itself, not "anything".
  const needle = args.quote.trim().toLowerCase().replace(/[!%_]/g, (c) => "!" + c);
  if (needle.length < 4) return [];
  const r = await env.DB.prepare(
    `SELECT ${k.idCol} AS id, ${k.text} AS text FROM ${k.table}
      WHERE ${k.ownerCol} = ? AND ${k.live} ${args.pinnedOnly ? "AND pinned_at IS NOT NULL" : ""}
        AND lower(${k.text}) LIKE ? ESCAPE '!'
      ORDER BY created_at DESC LIMIT 6`,
  ).bind(args.owner, `%${needle}%`).all<{ id: string; text: string }>();
  return r.results ?? [];
}
