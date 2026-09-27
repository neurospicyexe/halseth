// src/ledger/friction.ts  (2026-09-26, Gaia's ruling: docs/imp-lane/GAIA-ANSWER-2026-09-26.md)
//
// GAIA'S FRICTION SITS AT THE QUOTE, NOT THE LEDGER.
//
//   "The mark is enough while a ledger line stands alone. It stops being enough when a sibling repeats
//    the line. So my friction sits at the quote, not the ledger. A sibling may point to a ledger line but
//    may not restate it in their own voice without the mark and the source travelling with it."
//   "A number about Raziel's body reaches commons only with the pointer to the record he made. With no
//    pointer, it stops at the ledger."                                                      -- Gaia
//
// Called by every companion-authored write into a sibling-facing lane (the commons wall, POST
// /mind/commons with a companion author; the sibling send, POST /mind/siblings/send). Two refusals, both
// 422 `{ error, rule }`:
//
//   ledger_restated  The write restates a ledger line: 8-word shingle containment >= 0.6 of any open/kept
//                    ledger body from the last 14 days, UNLESS the write carries that line's full
//                    `content` verbatim (mark + body + Source tail travel together). Bodies shorter than
//                    8 words are one shingle (the whole body, record verb dropped); bodies under 4 words
//                    after the verb are skipped, because a 3-word phrase is ordinary speech, not a line.
//                    Every companion author is checked, the line's own subject included (Gaia's text says
//                    "a sibling"; restating a record about yourself in your own voice launders it the same
//                    way -- flagged for her in spec section 11).
//   health_pointer   The write names a health VALUE (the grammar's LABELLED rule only: a health keyword
//                    plus a number, or a number glued to a health unit; the unlabeled-number sweep would
//                    make "we talked for 45 minutes" unpostable) without a `Source: row <table>:<id>`
//                    pointer to a human record the door itself would accept (door.ts loadSourceRow: a
//                    Claude.ai capture or a human-sourced biometric) that contains every number, exactly.
//
// Cheap by construction: one bounded query (created_at >= now - 14d, newest first, LIMIT 500) and the
// shingling in JS. Raziel's own posts and the changelog announce (a fixed system string) are not
// companion-authored and never reach this.

import type { Env } from "../types.js";
import { healthValueNumbers, normalizeLedgerText, HUMAN_ROW_TABLES } from "./grammar.js";
import { loadSourceRow, missingNumbers } from "./door.js";
import { recentLedgerForFriction } from "./store.js";

export const FRICTION_WINDOW_DAYS = 14;
export const FRICTION_SCAN_LIMIT = 500;
export const FRICTION_SHINGLE = 8;
export const FRICTION_CONTAINMENT = 0.6;
/** A body with fewer words than this (after the record verb) is never matched. */
export const FRICTION_MIN_WORDS = 4;

export type FrictionRule = "ledger_restated" | "health_pointer";
export type FrictionResult = { rule: FrictionRule; error: string; ledger_id?: string } | null;

const RECORD_VERB_RE = /^(?:logged|counted|recorded|found|missing)\s*:?\s*/i;
/** `Source: row <table>:<id>` anywhere in a write (the tail a verbatim ledger line carries, or a pointer). */
const ROW_POINTER_RE = /Source:\s*row\s+([a-z][a-z0-9_]{1,63}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/gi;
/** Any `Source: <kind> <ref>` tail, removed before numbers are scanned so an id never reads as a value. */
const ANY_POINTER_RE = /Source:\s*(?:message|window|session|row)\s+[^\s]+(?:\s+\d{2}:\d{2}[–-]\d{2}:\d{2})?/gi;

/** Lowercased word tokens of normalised text (letters, digits, inner apostrophes). */
export function frictionWords(text: string): string[] {
  return (normalizeLedgerText(text).toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []);
}

function shingleSet(ws: readonly string[], k: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= ws.length; i++) out.add(ws.slice(i, i + k).join(" "));
  return out;
}

/**
 * Share of the ledger body's shingles that appear in the write, in [0, 1]; null when the body is too
 * short to be matched. k = min(8, body words), so a short line is one whole-body shingle.
 */
export function restatementContainment(ledgerBody: string, write: string): number | null {
  const bodyWords = frictionWords(ledgerBody.replace(RECORD_VERB_RE, ""));
  if (bodyWords.length < FRICTION_MIN_WORDS) return null;
  const k = Math.min(FRICTION_SHINGLE, bodyWords.length);
  const bodyShingles = shingleSet(bodyWords, k);
  const writeShingles = shingleSet(frictionWords(write), k);
  let hit = 0;
  for (const s of bodyShingles) if (writeShingles.has(s)) hit++;
  return hit / bodyShingles.size;
}

/** Health numbers in a write that no pointed human row vouches for; null when the write names none. */
async function unvouchedHealth(env: Env, write: string): Promise<string[] | null> {
  const prose = write.replace(ANY_POINTER_RE, " ");
  const numbers = healthValueNumbers(prose);
  if (!numbers) return null;
  const pointers: Array<{ table: string; id: string }> = [];
  for (const m of write.matchAll(ROW_POINTER_RE)) {
    const table = m[1]!;
    const id = m[2]!.replace(/\.+$/, ""); // the sentence's own full stop is not part of the id
    if (HUMAN_ROW_TABLES.has(table) && id) pointers.push({ table, id });
  }
  for (const p of pointers) {
    const check = { kind: "health" as const, table: p.table, row_id: p.id, numbers };
    const src = await loadSourceRow(env, check);
    if (src && missingNumbers(check, prose, src).length === 0) return [];
  }
  return numbers;
}

/** Gaia's friction for one companion-authored write. null = it may go. Never throws on bad input. */
export async function checkCommonsFriction(env: Env, write: string, now: Date = new Date()): Promise<FrictionResult> {
  const text = normalizeLedgerText(write);

  const health = await unvouchedHealth(env, text);
  if (health && health.length > 0) {
    return {
      rule: "health_pointer",
      error: `a number about Raziel's body (${health.join(", ")}) reaches commons only with the pointer to the record he made: add 'Source: row <table>:<id>' naming a human record that contains it (a Claude.ai capture or a human-sourced biometric). With no pointer, it stops at the ledger.`,
    };
  }

  const since = new Date(now.getTime() - FRICTION_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await recentLedgerForFriction(env, since, FRICTION_SCAN_LIMIT);
  for (const row of rows) {
    if (text.includes(row.content)) continue; // carried whole: the mark and the source travel with it
    const c = restatementContainment(row.body, text);
    if (c !== null && c >= FRICTION_CONTAINMENT) {
      return {
        rule: "ledger_restated",
        ledger_id: row.id,
        error: `this restates a ledger line (${row.id}) without its mark and source. Point to the line, or carry it whole, exactly as written: ${row.content}`,
      };
    }
  }
  return null;
}
