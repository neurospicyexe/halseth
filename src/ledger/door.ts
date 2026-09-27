// src/ledger/door.ts  (mig 0134, 2026-09-26)
//
// THE ONLY INSERT INTO ledger_entries. src/__tests__/tray-sweep.test.ts fails if `INSERT INTO
// ledger_entries` appears in any other file under src/, so the grammar cannot be walked around: every
// clerk line is validated (grammar.ts), number-checked against its source row here, and stamped with
// the server's mark before it is stored. The statement below names the table LITERALLY on purpose --
// the sweep is blind to an interpolated table name (its stated blind spot).
//
// Health values (Drevan's Hex sibling: "glucose, doses, weights, labs only move with a source row
// attached, or they don't move"): when the grammar flags a number, the door loads the referenced row
// and requires every flagged number to appear in it. For a health value the row must be HUMAN-authored:
//   - wm_continuity_notes with source = 'conversation_capture' (what Raziel said, taken down in a human
//     session), live and kept -- a retracted capture validates nothing;
//   - biometric_snapshots (every column's value is the row's text).
// On 09-25 the 187 sat in Drevan's own Discord reply. "Counted: Drevan said 187. Source: message <id>"
// passes a format check and would launder the fabrication; it fails here, because a message is not a
// row and a companion utterance is never a source for a number.
//
// Never writes partially: validation and the row check run BEFORE the INSERT; the INSERT is one
// statement. Idempotent on dedup_key (ON CONFLICT DO NOTHING, then the existing id is returned).

import type { Env } from "../types.js";
import { validateLedger, rowNumbers, rowHasNumber, type LedgerInput, type LedgerRule, type NumberCheck } from "./grammar.js";

export type LedgerWriteResult =
  | { ok: true; duplicate: false; id: string; content: string }
  | { ok: true; duplicate: true; id: string }
  | { ok: false; rule: LedgerRule; error: string };

/** led_<uuid>. */
export function newLedgerId(): string {
  return `led_${crypto.randomUUID()}`;
}

/** The referenced row's text, or null when it does not exist / is not an acceptable source. */
async function loadSourceRowText(env: Env, check: NumberCheck): Promise<string | null> {
  if (check.table === "wm_continuity_notes") {
    // Gated (kept AND live): the tray sweep requires it, and a retracted capture must not validate.
    const r = await env.DB.prepare(
      `SELECT content FROM wm_continuity_notes
        WHERE note_id = ? AND source = 'conversation_capture' AND archived = 0 AND review_state = 'kept'`,
    ).bind(check.row_id).first<{ content: string }>();
    return r ? String(r.content ?? "") : null;
  }
  if (check.table === "biometric_snapshots") {
    const r = await env.DB.prepare("SELECT * FROM biometric_snapshots WHERE id = ?").bind(check.row_id).first<Record<string, unknown>>();
    return r ? Object.entries(r).filter(([k]) => k !== "id").map(([, v]) => (v === null || v === undefined ? "" : String(v))).join(" ") : null;
  }
  if (check.table === "companion_basin_history" && check.kind === "unlabeled") {
    const r = await env.DB.prepare("SELECT * FROM companion_basin_history WHERE id = ?").bind(check.row_id).first<Record<string, unknown>>();
    return r ? Object.entries(r).filter(([k]) => k !== "id").map(([, v]) => (v === null || v === undefined ? "" : String(v))).join(" ") : null;
  }
  return null;
}

/** Validate, check the source row, and INSERT one ledger line. Never throws on bad input. */
export async function writeLedger(env: Env, input: LedgerInput, now: Date = new Date()): Promise<LedgerWriteResult> {
  const v = validateLedger(input, now.toISOString().slice(0, 10));
  if (!v.ok) return v;
  const line = v.line;

  if (line.number_check) {
    const c = line.number_check;
    const text = await loadSourceRowText(env, c);
    if (text === null) {
      return {
        ok: false, rule: "health_row",
        error: c.table === "wm_continuity_notes"
          ? `source row wm_continuity_notes:${c.row_id} is not a live, kept conversation_capture -- only a human record can carry a health number`
          : `source row ${c.table}:${c.row_id} not found`,
      };
    }
    const present = rowNumbers(text);
    const missing = c.numbers.filter((n) => !rowHasNumber(n, present));
    if (missing.length > 0) {
      return {
        ok: false, rule: "health_numbers",
        error: `the source row does not contain ${missing.join(", ")} -- every number in the line must appear in the row it points at`,
      };
    }
  }

  if (line.dedup_key) {
    const existing = await env.DB.prepare("SELECT id FROM ledger_entries WHERE dedup_key = ?").bind(line.dedup_key).first<{ id: string }>();
    if (existing) return { ok: true, duplicate: true, id: existing.id };
  }

  const id = newLedgerId();
  const res = await env.DB.prepare(
    `INSERT INTO ledger_entries
       (id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, dedup_key, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
     ON CONFLICT(dedup_key) DO NOTHING`,
  ).bind(
    id, line.companion_id, line.function, line.body, line.content, line.source_kind, line.source_ref,
    line.observed_on, now.toISOString(), line.dedup_key,
  ).run();

  if ((res.meta?.changes ?? 0) === 0) {
    // Lost a race to the same dedup_key between the lookup and the INSERT.
    const existing = line.dedup_key
      ? await env.DB.prepare("SELECT id FROM ledger_entries WHERE dedup_key = ?").bind(line.dedup_key).first<{ id: string }>()
      : null;
    if (existing) return { ok: true, duplicate: true, id: existing.id };
    throw new Error("[ledger] INSERT changed no rows and no dedup_key row exists");
  }
  return { ok: true, duplicate: false, id, content: line.content };
}
