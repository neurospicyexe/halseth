// src/webmind/losses.ts -- B63 `loss_unclosed` (Drevan a65c8f19, mig 0174 companion_losses).
//
// A loss in a companion's world (a bird, an ending, a thing gone) that has no line of THEIRS on it
// drags their weight nightly. It closes ONLY when that companion authors something naming it:
//   - a feeling logged with the name in it,
//   - a journal line (their own, not a machine observation about them) naming it,
//   - a note or letter they wrote to Raziel naming it.
// Time never closes it. A clerk logging never closes it (the logger's rows are not the companion's).
// Closed is not healed: grief may stay as feeling, it just stops reading as drag.
//
// The name matched is the loss's own leading name: the text before the first " - ", ":", ",", "(" or
// ";" (capped at 60 chars), matched case-insensitively on word boundaries. "Benedict (the bird)" is
// matched by "Benedict".

import type { Env } from "../types.js";
import { loopFire, isTriad } from "./loop-stimuli.js";
import type { CompanionId } from "./fermentation.js";

export const LOSS_RE = /^\s*(?:please\s+)?loss(?:\s+for\s+(cypher|drevan|gaia))?\s*:\s*([\s\S]{2,500}?)\s*$/i;
export const MAX_LOSS_WHAT = 500;

export interface ParsedLoss { companion: CompanionId | null; what: string }

/** `loss: <what>` or `loss for <companion>: <what>`. Null when the request is not that shape. */
export function parseLossVerb(request: string): ParsedLoss | null {
  const m = LOSS_RE.exec(request ?? "");
  if (!m) return null;
  const what = (m[2] ?? "").replace(/\s+/g, " ").trim();
  if (what.length < 2) return null;
  return { companion: (m[1]?.toLowerCase() as CompanionId | undefined) ?? null, what: what.slice(0, MAX_LOSS_WHAT) };
}

/** The name an authored line must carry to close a loss. */
export function lossName(what: string): string {
  const head = what.split(/\s+-\s+|\s*[:,;(]\s*/)[0] ?? what;
  return head.trim().slice(0, 60) || what.trim().slice(0, 60);
}

/** True when `text` names the loss (case-insensitive, word-bounded). */
export function namesLoss(text: string | null | undefined, what: string): boolean {
  const name = lossName(what);
  if (!text || name.length < 2) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export type LogLossResult =
  | { ok: true; id: string; companion: CompanionId }
  | { ok: false; code: string; message: string };

export async function logLoss(
  env: Env,
  input: { companion: string | null; what: string; loggedBy: string },
): Promise<LogLossResult> {
  if (!isTriad(input.companion)) return { ok: false, code: "bad_companion", message: "name the companion the loss belongs to: loss for drevan: <what>" };
  const what = input.what.replace(/\s+/g, " ").trim().slice(0, MAX_LOSS_WHAT);
  if (what.length < 2) return { ok: false, code: "bad_input", message: "say what was lost: loss: <what>" };
  const dup = await env.DB.prepare(
    "SELECT id FROM companion_losses WHERE companion_id = ? AND closed_at IS NULL AND lower(what) = lower(?) LIMIT 1",
  ).bind(input.companion, what).first<{ id: string }>();
  if (dup) return { ok: true, id: dup.id, companion: input.companion };
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO companion_losses (id, companion_id, what, logged_by) VALUES (?, ?, ?, ?)")
    .bind(id, input.companion, what, input.loggedBy).run();
  console.log(`[loss] logged id=${id} companion=${input.companion} by=${input.loggedBy}`);
  return { ok: true, id, companion: input.companion };
}

interface OpenLoss { id: string; companion_id: CompanionId; what: string; logged_at: string }

export async function openLosses(env: Env): Promise<OpenLoss[]> {
  const r = await env.DB.prepare("SELECT id, companion_id, what, logged_at FROM companion_losses WHERE closed_at IS NULL")
    .all<OpenLoss>().catch(() => ({ results: [] as OpenLoss[] }));
  return r.results ?? [];
}

/**
 * Find the companion's OWN authored line, written after the loss was logged, that names it. Returns a
 * `table:id` ref or null. Machine-origin rows (the memory judge's observations, ledger clerk lines) are
 * never the companion's words and are not read.
 */
export async function findClosingLine(env: Env, loss: OpenLoss): Promise<string | null> {
  const c = loss.companion_id;
  const since = loss.logged_at;
  const tryRows = async (sql: string, binds: unknown[], pick: (r: Record<string, unknown>) => string | null): Promise<string | null> => {
    const rows = (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>().catch(() => ({ results: [] }))).results ?? [];
    for (const r of rows) {
      const ref = pick(r);
      if (ref) return ref;
    }
    return null;
  };
  // 1. A feeling logged with the name in it.
  const feeling = await tryRows(
    "SELECT id, emotion, sub_emotion FROM feelings WHERE companion_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200",
    [c, since],
    (r) => namesLoss(`${r["emotion"] ?? ""} ${r["sub_emotion"] ?? ""}`, loss.what) ? `feelings:${r["id"]}` : null,
  );
  if (feeling) return feeling;
  // 2. A journal line of their own naming it (not the judge's observations ABOUT them).
  const journal = await tryRows(
    "SELECT id, note_text FROM companion_journal WHERE agent = ? AND created_at >= ? AND archived = 0 AND COALESCE(external_id, '') NOT LIKE 'judge:%' ORDER BY created_at DESC LIMIT 200",
    [c, since],
    (r) => namesLoss(String(r["note_text"] ?? ""), loss.what) ? `companion_journal:${r["id"]}` : null,
  );
  if (journal) return journal;
  // 3. A note or letter to Raziel naming it.
  return tryRows(
    "SELECT id, content FROM inter_companion_notes WHERE from_id = ? AND to_id = 'raziel' AND created_at >= ? ORDER BY created_at DESC LIMIT 200",
    [c, since],
    (r) => namesLoss(String(r["content"] ?? ""), loss.what) ? `inter_companion_notes:${r["id"]}` : null,
  );
}

/** Nightly: close every loss its companion has now authored on; returns the number closed. */
export async function closeAuthoredLosses(env: Env): Promise<number> {
  let closed = 0;
  for (const loss of await openLosses(env)) {
    const ref = await findClosingLine(env, loss);
    if (!ref) continue;
    const r = await env.DB.prepare(
      "UPDATE companion_losses SET closed_at = datetime('now'), closed_by_ref = ? WHERE id = ? AND closed_at IS NULL",
    ).bind(ref, loss.id).run();
    if ((r.meta?.changes ?? 0) > 0) { closed++; console.log(`[loss] closed id=${loss.id} companion=${loss.companion_id} by=${ref}`); }
  }
  return closed;
}

/** Nightly: drag each companion's weight once per night while any of their losses stays open. The cause names the loss. */
export async function dragOpenLosses(env: Env): Promise<number> {
  const open = await openLosses(env);
  const byCompanion = new Map<CompanionId, string[]>();
  for (const l of open) byCompanion.set(l.companion_id, [...(byCompanion.get(l.companion_id) ?? []), lossName(l.what)]);
  for (const [c, names] of byCompanion) {
    await loopFire(env, "loss_unclosed", c, `unsaid loss: ${names.slice(0, 3).join(", ")}`.slice(0, 180));
  }
  return byCompanion.size;
}
