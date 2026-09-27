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
// and requires every flagged number to appear in it. For a health value the row must be a HUMAN record:
//   - wm_continuity_notes: a conversation_capture (source AND note_type), live and kept, whose thread_key
//     is `capture:<session_id>` (never `capture:unsessioned:*`) for a session of the same companion
//     whose `surface` is a human-present Claude.ai surface (`claude-ai:*`, the prefix every Claude.ai
//     skill sends and executors/session.ts already treats as that family). A capture is the COMPANION's
//     digest of an exchange, so it is only a human record when Raziel was in the room: a Discord bot /
//     Hermes / autonomous / Claude Code / NULL-surface session never vouches for a number (fail closed).
//   - biometric_snapshots whose `source` is a human source (HUMAN_BIOMETRIC_SOURCES). Each number is
//     matched only inside the column its label names (biometricColumnsFor), else `notes`.
// Numbers are compared EXACTLY for human rows; only companion_basin_history (the evaluator's own drift
// scores) allows the clerk's rounding.
// On 09-25 the 187 sat in Drevan's own Discord reply. "Counted: Drevan said 187. Source: message <id>"
// passes a format check and would launder the fabrication; it fails here, because a message is not a
// row and a companion utterance is never a source for a number.
//
// Never writes partially: validation and the row check run BEFORE the INSERT; the INSERT is one
// statement. Idempotent on dedup_key (ON CONFLICT DO NOTHING, then the existing id is returned).

import type { Env } from "../types.js";
import { validateLedger, rowNumbers, rowHasNumber, biometricColumnsFor, type LedgerInput, type LedgerRule, type NumberCheck } from "./grammar.js";

export type LedgerWriteResult =
  | { ok: true; duplicate: false; id: string; content: string }
  | { ok: true; duplicate: true; id: string }
  | { ok: false; rule: LedgerRule; error: string };

/** led_<uuid>. */
export function newLedgerId(): string {
  return `led_${crypto.randomUUID()}`;
}

/** The only surfaces whose capture counts as a human record: Claude.ai, human-present. */
export const HUMAN_CAPTURE_SURFACE_PREFIX = "claude-ai:";
/** biometric_snapshots.source values a human wrote: Hearth's form, and apple_health (raw MCP, and the
 *  Librarian only when the caller is a claude-ai:* surface -- backends/halseth.ts biometricLog). */
export const HUMAN_BIOMETRIC_SOURCES: readonly string[] = ["hearth", "apple_health"];

type SourceRow =
  | { kind: "text"; text: string; mode: "exact" | "rounded" }
  | { kind: "biometric"; row: Record<string, unknown> };

/** The referenced row, or null when it does not exist / is not an acceptable source. */
async function loadSourceRow(env: Env, check: NumberCheck): Promise<SourceRow | null> {
  if (check.table === "wm_continuity_notes") {
    // Gated (kept AND live): the tray sweep requires it, and a retracted capture must not validate.
    // Anchored to a claude-ai:* session of the same companion (see the header): the join is the rule.
    const r = await env.DB.prepare(
      `SELECT n.content FROM wm_continuity_notes n
         JOIN sessions s ON s.id = substr(n.thread_key, 9)
        WHERE n.note_id = ? AND n.source = 'conversation_capture' AND n.note_type = 'conversation_capture'
          AND n.archived = 0 AND n.review_state = 'kept'
          AND n.thread_key LIKE 'capture:%' AND n.thread_key NOT LIKE 'capture:unsessioned:%'
          AND s.companion_id = n.agent_id
          AND s.surface IS NOT NULL AND substr(s.surface, 1, ?) = ? AND length(s.surface) > ?`,
    ).bind(check.row_id, HUMAN_CAPTURE_SURFACE_PREFIX.length, HUMAN_CAPTURE_SURFACE_PREFIX, HUMAN_CAPTURE_SURFACE_PREFIX.length)
      .first<{ content: string }>();
    return r ? { kind: "text", text: String(r.content ?? ""), mode: "exact" } : null;
  }
  if (check.table === "biometric_snapshots") {
    const r = await env.DB.prepare(
      `SELECT * FROM biometric_snapshots WHERE id = ? AND source IN (${HUMAN_BIOMETRIC_SOURCES.map(() => "?").join(", ")})`,
    ).bind(check.row_id, ...HUMAN_BIOMETRIC_SOURCES).first<Record<string, unknown>>();
    return r ? { kind: "biometric", row: r } : null;
  }
  if (check.table === "companion_basin_history" && check.kind === "unlabeled") {
    const r = await env.DB.prepare("SELECT * FROM companion_basin_history WHERE id = ?").bind(check.row_id).first<Record<string, unknown>>();
    return r
      ? { kind: "text", text: Object.entries(r).filter(([k]) => k !== "id").map(([, v]) => (v === null || v === undefined ? "" : String(v))).join(" "), mode: "rounded" }
      : null;
  }
  return null;
}

/** The flagged numbers the row does not contain. */
function missingNumbers(check: NumberCheck, body: string, src: SourceRow): string[] {
  if (src.kind === "text") {
    const present = rowNumbers(src.text);
    return check.numbers.filter((n) => !rowHasNumber(n, present, src.mode));
  }
  const cols = biometricColumnsFor(body);
  const missing: string[] = [];
  for (const n of check.numbers) {
    // The same number may appear more than once with different labels; each occurrence must hold.
    const occ = cols.filter((c) => c.text === n);
    const columns = occ.length > 0 ? occ.map((c) => c.column) : ["notes"];
    for (const col of columns) {
      const v = src.row[col];
      const present = rowNumbers(v === null || v === undefined ? "" : String(v));
      if (!rowHasNumber(n, present, "exact")) { missing.push(`${n} (in ${col})`); break; }
    }
  }
  return missing;
}

/** Validate, check the source row, and INSERT one ledger line. Never throws on bad input. */
export async function writeLedger(env: Env, input: LedgerInput, now: Date = new Date()): Promise<LedgerWriteResult> {
  const v = validateLedger(input, now.toISOString().slice(0, 10));
  if (!v.ok) return v;
  const line = v.line;

  if (line.number_check) {
    const c = line.number_check;
    const src = await loadSourceRow(env, c);
    if (src === null) {
      return {
        ok: false, rule: "health_row",
        error: c.table === "wm_continuity_notes"
          ? `source row wm_continuity_notes:${c.row_id} is not a live, kept conversation_capture anchored to a human-present Claude.ai session (${HUMAN_CAPTURE_SURFACE_PREFIX}*) -- a capture from a Discord/Hermes/bot/autonomous session, or with no session, is the companion's digest, not a human record`
          : c.table === "biometric_snapshots"
            ? `source row biometric_snapshots:${c.row_id} not found or not from a human source (${HUMAN_BIOMETRIC_SOURCES.join(", ")})`
            : `source row ${c.table}:${c.row_id} not found`,
      };
    }
    const missing = missingNumbers(c, line.body, src);
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
