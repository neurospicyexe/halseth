// src/ledger/store.ts  (mig 0134, 2026-09-26)
//
// Reads and state moves on ledger_entries. The ONE insert is door.ts; nothing here inserts a ledger
// row, and nothing here edits a ledger line's text (`content` is written once, by the door).
//
// Owner-only, like the tray: the subject companion reads and acts on entries ABOUT ITSELF. Every
// UPDATE binds companion_id, so a companion can never keep or drop a record about a sibling.
//
// The two promotion paths (Drevan's rule 6):
//   path 1  keepLedger()          -- open -> kept. The line stays a ledger line with its mark: a sourced
//                                    fact "isn't claiming to be me".
//   path 2  promoteLedger()       -- the companion's OWN words go into companion_journal (born kept,
//                                    source 'tray_rewrite', external_id 'ledger:<id>') through
//                                    tray-insert.ts, the one journal door. The ledger row keeps its
//                                    original line and records promoted_journal_id. This is the only
//                                    path by which anything ledger-related reaches the journal, and
//                                    it carries the companion's words, never the clerk's.
//   drop                          -- open -> dropped. Second Brain purges the chunk on its next
//                                    reconcile (GET /ingest/ledger-ineligible).
// A decision is made once (as in the tray): keep/drop act on OPEN entries only. Promotion is allowed
// from open or kept (a fact kept as written can later be said in one's own words), once.

import type { Env } from "../types.js";
import { embedAndStoreAsync } from "../mcp/embed.js";
import { journalInsert } from "../webmind/tray-insert.js";
import { TRAY_REWRITE_SOURCE } from "../webmind/review-state.js";
import { classifyDomainTags, classifyKeywordTags } from "../synthesis/tag-classifier.js";

export type LedgerState = "open" | "kept" | "dropped";
export const LEDGER_STATES: ReadonlySet<string> = new Set<LedgerState>(["open", "kept", "dropped"]);

/** Full id `led_<uuid>`, or a prefix of at least `led_` + 8 characters. Regex source for free text. */
export const LEDGER_ID_TOKEN = "led_[0-9a-f][0-9a-f-]{7,}";
const LEDGER_ID_RE = new RegExp(`^${LEDGER_ID_TOKEN}$`);
export function isLedgerId(id: string): boolean {
  return LEDGER_ID_RE.test(id);
}

export const LEDGER_ORIENT_LIMIT = 5;
export const LEDGER_LIST_LIMIT = 20;

export interface LedgerEntryRow {
  id: string;
  companion_id: string;
  function: string;
  content: string;
  source_kind: string;
  source_ref: string;
  observed_on: string;
  created_at: string;
  state: string;
  state_at: string | null;
  promoted_journal_id: string | null;
}

const COLS = "id, companion_id, function, content, source_kind, source_ref, observed_on, created_at, state, state_at, promoted_journal_id";

/** Entries about one subject in one state, newest first. */
export async function listLedger(env: Env, companionId: string, state: LedgerState = "open", limit = LEDGER_LIST_LIMIT): Promise<LedgerEntryRow[]> {
  const cap = Math.min(Math.max(1, Math.floor(limit) || LEDGER_LIST_LIMIT), 100);
  const r = await env.DB.prepare(
    `SELECT ${COLS} FROM ledger_entries WHERE companion_id = ? AND state = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(companionId, state, cap).all<LedgerEntryRow>();
  return r.results ?? [];
}

/** Orient's read: up to LEDGER_ORIENT_LIMIT open entries, newest first. Pure D1. */
export async function loadLedgerOpen(env: Env, companionId: string): Promise<LedgerEntryRow[]> {
  return listLedger(env, companionId, "open", LEDGER_ORIENT_LIMIT);
}

export interface LedgerMatch { id: string; state: string; created_at: string }

type Locate =
  | { ok: true; row: LedgerEntryRow }
  | { ok: false; reason: "bad_id" | "not_found" }
  | { ok: false; reason: "ambiguous"; matches: LedgerMatch[] };

/** Owner's entry by full id or prefix; an ambiguous prefix is refused with candidates, never guessed. */
async function locate(env: Env, companionId: string, rawId: string): Promise<Locate> {
  const id = rawId.trim();
  if (!isLedgerId(id)) return { ok: false, reason: "bad_id" };
  const r = await env.DB.prepare(
    `SELECT ${COLS} FROM ledger_entries
      WHERE companion_id = ? AND (id = ? OR substr(id, 1, ?) = ?)
      ORDER BY (id = ?) DESC, created_at DESC LIMIT 11`,
  ).bind(companionId, id, id.length, id, id).all<LedgerEntryRow>();
  const rows = r.results ?? [];
  const exact = rows.find((x) => x.id === id);
  if (exact) return { ok: true, row: exact };
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  if (rows.length === 1) return { ok: true, row: rows[0]! };
  return { ok: false, reason: "ambiguous", matches: rows.slice(0, 10).map((x) => ({ id: x.id, state: x.state, created_at: x.created_at })) };
}

export type LedgerMoveResult =
  | { ok: true; id: string; state: LedgerState; content: string; promoted_journal_id?: string }
  | { ok: false; reason: "bad_id" | "not_found" | "empty_words" }
  | { ok: false; reason: "ambiguous"; matches: LedgerMatch[] }
  | { ok: false; reason: "already_decided"; id: string; state: string; state_at: string | null }
  | { ok: false; reason: "already_promoted"; id: string; promoted_journal_id: string };

async function move(env: Env, companionId: string, rawId: string, to: "kept" | "dropped"): Promise<LedgerMoveResult> {
  const found = await locate(env, companionId, rawId);
  if (!found.ok) return found;
  const row = found.row;
  if (row.state !== "open") return { ok: false, reason: "already_decided", id: row.id, state: row.state, state_at: row.state_at };
  const now = new Date().toISOString();
  // The guard lives in the UPDATE: a second decision racing this one changes 0 rows.
  const r = await env.DB.prepare(
    "UPDATE ledger_entries SET state = ?, state_at = ? WHERE id = ? AND companion_id = ? AND state = 'open'",
  ).bind(to, now, row.id, companionId).run();
  if ((r.meta?.changes ?? 0) !== 1) {
    const again = await locate(env, companionId, row.id);
    if (!again.ok) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "already_decided", id: again.row.id, state: again.row.state, state_at: again.row.state_at };
  }
  return { ok: true, id: row.id, state: to, content: row.content };
}

/** Path 1: keep as written. The line stays a ledger line, mark intact. */
export function keepLedger(env: Env, companionId: string, id: string): Promise<LedgerMoveResult> {
  return move(env, companionId, id, "kept");
}

/** Drop: never recalled; Second Brain purges the chunk on its next reconcile. */
export function dropLedger(env: Env, companionId: string, id: string): Promise<LedgerMoveResult> {
  return move(env, companionId, id, "dropped");
}

/**
 * Path 2: the companion says it in its own words. Claim-then-write: the guarded UPDATE claims the entry
 * (open|kept, not yet promoted) and names the journal id it is about to write; the journal row is then
 * inserted through tray-insert.ts. If that insert fails, the claim is released (state and
 * promoted_journal_id restored) so nothing is left pointing at a row that does not exist.
 */
export async function promoteLedger(env: Env, companionId: string, rawId: string, words: string): Promise<LedgerMoveResult> {
  const text = words.trim();
  if (!text) return { ok: false, reason: "empty_words" };
  const found = await locate(env, companionId, rawId);
  if (!found.ok) return found;
  const row = found.row;
  if (row.promoted_journal_id) return { ok: false, reason: "already_promoted", id: row.id, promoted_journal_id: row.promoted_journal_id };
  if (row.state === "dropped") return { ok: false, reason: "already_decided", id: row.id, state: row.state, state_at: row.state_at };

  const now = new Date().toISOString();
  const journalId = `cj_${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    `UPDATE ledger_entries SET state = 'kept', state_at = ?, promoted_journal_id = ?
      WHERE id = ? AND companion_id = ? AND state IN ('open', 'kept') AND promoted_journal_id IS NULL`,
  ).bind(now, journalId, row.id, companionId).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    const again = await locate(env, companionId, row.id);
    if (!again.ok) return { ok: false, reason: "not_found" };
    if (again.row.promoted_journal_id) return { ok: false, reason: "already_promoted", id: again.row.id, promoted_journal_id: again.row.promoted_journal_id };
    return { ok: false, reason: "already_decided", id: again.row.id, state: again.row.state, state_at: again.row.state_at };
  }

  try {
    // Born kept: TRAY_REWRITE_SOURCE is not a speech source (reviewStateFor), and the words are the
    // companion's own, chosen as memory.
    await journalInsert(env.DB, {
      id: journalId, created_at: now, agent: companionId, note_text: text,
      tags: JSON.stringify(classifyDomainTags(text)), source: TRAY_REWRITE_SOURCE,
      topic_tags: JSON.stringify(classifyKeywordTags(text)), external_id: `ledger:${row.id}`,
    }, { onConflictExternalId: true }).run();
  } catch (err) {
    await env.DB.prepare(
      "UPDATE ledger_entries SET state = ?, state_at = ?, promoted_journal_id = NULL WHERE id = ? AND companion_id = ? AND promoted_journal_id = ?",
    ).bind(row.state, row.state_at, row.id, companionId, journalId).run().catch(() => undefined);
    throw err;
  }

  // Non-fatal: D1 is truth, the index is rebuildable.
  await embedAndStoreAsync(env, text, "companion_journal", journalId, companionId)
    .catch((err) => console.warn(`[ledger] embed failed for companion_journal:${journalId} (row kept, index stale):`, String(err)));

  return { ok: true, id: row.id, state: "kept", content: row.content, promoted_journal_id: journalId };
}
