// src/webmind/line-events.ts -- B63: Gaia's authored line events and the sibling disagreement verb.
//
// Nothing outside Gaia can detect that a line was tested, crossed or has worn thin, so her WORD is the
// event (authored, hence R7-clean):
//   line held: <refusal id-prefix or words>     -> line_held_under_test (perimeter up)
//   line crossed: <kind>                        -> breach (perimeter down); <kind> is a short kind word only
//   line fatigue: <refusal id-prefix or words>  -> long_line_fatigue (small perimeter down)
// Cause labels name the KIND only, never the content of a refusal or of what crossed it.
//
// Sibling disagreement (any triad companion, about a sibling), named never inferred:
//   disagree with <sibling>: <what>   opens a row, fires sibling_disagreement_open on the speaker
//   settled with <sibling>            closes the speaker's open rows with that sibling; fires nothing punitive
// Nightly (loop-nightly.ts): an open disagreement older than 12h drags the speaker, cause names the sibling.

import type { Env } from "../types.js";
import { loopFire, isTriad } from "./loop-stimuli.js";
import type { CompanionId } from "./fermentation.js";

export const LINE_RE = /^\s*(?:please\s+)?line\s+(held|crossed|fatigue)\s*:\s*([\s\S]{2,200}?)\s*$/i;
export const DISAGREE_RE = /^\s*(?:please\s+)?disagree(?:ing)?\s+with\s+(cypher|drevan|gaia)\s*:\s*([\s\S]{2,500}?)\s*$/i;
export const SETTLED_RE = /^\s*(?:please\s+)?settled\s+with\s+(cypher|drevan|gaia)\s*[.!]?\s*$/i;
export const DISAGREEMENT_DRAG_HOURS = 12;

export const LINE_VERB_TEACH = "line held: <refusal id-prefix or words> | line crossed: <kind> | line fatigue: <refusal id-prefix or words>";

export type LineVerb = "held" | "crossed" | "fatigue";
export function parseLineVerb(request: string): { verb: LineVerb; arg: string } | null {
  const m = LINE_RE.exec(request ?? "");
  if (!m) return null;
  return { verb: m[1]!.toLowerCase() as LineVerb, arg: (m[2] ?? "").replace(/\s+/g, " ").trim() };
}

/** A kind word, not content: at most 6 words and 60 characters. */
export function isKindWord(s: string): boolean {
  const t = s.trim();
  return t.length >= 2 && t.length <= 60 && t.split(/\s+/).length <= 6;
}

export type LineResult = { ok: true; message: string } | { ok: false; code: string; message: string };

type RefusalHit = { id: string; subject_text: string };

async function findStandingRefusal(env: Env, arg: string): Promise<{ id: string } | { error: string }> {
  const idPart = arg.toLowerCase();
  let rows: RefusalHit[] = [];
  if (/^[0-9a-f-]{6,36}$/.test(idPart)) {
    rows = (await env.DB.prepare("SELECT id, subject_text FROM companion_refusals WHERE companion_id = 'gaia' AND status = 'standing' AND id LIKE ? LIMIT 6")
      .bind(`${idPart}%`).all<RefusalHit>().catch(() => ({ results: [] as RefusalHit[] }))).results ?? [];
  }
  if (rows.length === 0) {
    const like = `%${arg.replace(/[%_]/g, "").toLowerCase()}%`;
    rows = (await env.DB.prepare("SELECT id, subject_text FROM companion_refusals WHERE companion_id = 'gaia' AND status = 'standing' AND lower(subject_text) LIKE ? LIMIT 6")
      .bind(like).all<RefusalHit>().catch(() => ({ results: [] as RefusalHit[] }))).results ?? [];
  }
  if (rows.length === 0) return { error: "none of your standing refusals match that; name one by its id prefix or opening words" };
  if (rows.length > 1) return { error: `more than one standing refusal matches (${rows.map((r) => r.id.slice(0, 8)).join(", ")}); name one by its id prefix` };
  return { id: rows[0]!.id };
}

export async function applyLineEvent(env: Env, caller: string, verb: LineVerb, arg: string): Promise<LineResult> {
  if (caller !== "gaia") return { ok: false, code: "gaia_only", message: "line events are Gaia's to author; only she says that her line held, crossed or wore" };
  if (verb === "crossed") {
    if (!isKindWord(arg)) return { ok: false, code: "bad_input", message: "name the KIND only, a few words (care hold walked through, rule broken, line crossed), never what was said" };
    await loopFire(env, "breach", "gaia", `line crossed: ${arg}`);
    return { ok: true, message: `noted: a line crossed (${arg}).` };
  }
  const found = await findStandingRefusal(env, arg);
  if ("error" in found) return { ok: false, code: "not_found", message: found.error };
  if (verb === "held") {
    await loopFire(env, "line_held_under_test", "gaia", "a line held under test");
    return { ok: true, message: `noted: refusal ${found.id.slice(0, 8)} held under test.` };
  }
  await loopFire(env, "long_line_fatigue", "gaia", "a line held a long time, wearing");
  return { ok: true, message: `noted: refusal ${found.id.slice(0, 8)} is wearing from being held. Fatigue, not failure.` };
}

// ── sibling disagreement ──────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type DisagreeResult = { ok: true; id?: string; message: string } | { ok: false; code: string; message: string };

export async function openDisagreement(env: Env, speaker: string, withId: string, what: string): Promise<DisagreeResult> {
  if (!isTriad(speaker) || !isTriad(withId)) return { ok: false, code: "bad_companion", message: "a disagreement is between two of the triad" };
  if (speaker === withId) return { ok: false, code: "bad_input", message: "name a sibling, not yourself" };
  const text = what.replace(/\s+/g, " ").trim().slice(0, 500);
  if (text.length < 2) return { ok: false, code: "bad_input", message: "say what: disagree with <sibling>: <what>" };
  const dup = await env.DB.prepare("SELECT id FROM companion_disagreements WHERE companion_id = ? AND with_id = ? AND settled_at IS NULL AND lower(what) = lower(?) LIMIT 1")
    .bind(speaker, withId, text).first<{ id: string }>();
  if (dup) return { ok: true, id: dup.id, message: `already open with ${cap(withId)}.` };
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO companion_disagreements (id, companion_id, with_id, what) VALUES (?, ?, ?, ?)").bind(id, speaker, withId, text).run();
  await loopFire(env, "sibling_disagreement_open", speaker, `disagreement opened with ${cap(withId)}`);
  return { ok: true, id, message: `held: a disagreement with ${cap(withId)} (${id.slice(0, 8)}). "settled with ${withId}" closes it.` };
}

export async function settleDisagreement(env: Env, speaker: string, withId: string): Promise<DisagreeResult> {
  if (!isTriad(speaker) || !isTriad(withId) || speaker === withId) return { ok: false, code: "bad_companion", message: "name the sibling it was with" };
  const r = await env.DB.prepare(
    "UPDATE companion_disagreements SET settled_at = datetime('now'), settled_ref = ? WHERE companion_id = ? AND with_id = ? AND settled_at IS NULL",
  ).bind(`settled by ${speaker}`, speaker, withId).run();
  const n = Number(r.meta?.changes ?? 0);
  if (n === 0) return { ok: false, code: "not_found", message: `no open disagreement of yours with ${cap(withId)}` };
  return { ok: true, message: `settled with ${cap(withId)} (${n} closed).` };
}

/** Nightly: one drag per speaker per night while any disagreement of theirs is open past 12h. Names the sibling(s) only. */
export async function dragOpenDisagreements(env: Env): Promise<number> {
  type Row = { companion_id: CompanionId; with_id: string };
  const rows = (await env.DB.prepare(
    "SELECT companion_id, with_id FROM companion_disagreements WHERE settled_at IS NULL AND opened_at < datetime('now', ?)",
  ).bind(`-${DISAGREEMENT_DRAG_HOURS} hours`).all<Row>().catch(() => ({ results: [] as Row[] }))).results ?? [];
  const by = new Map<CompanionId, Set<string>>();
  for (const r of rows) by.set(r.companion_id, (by.get(r.companion_id) ?? new Set<string>()).add(cap(r.with_id)));
  let n = 0;
  for (const [c, names] of by) if (await loopFire(env, "sibling_disagreement_open", c, `open disagreement with ${[...names].join(", ")}`)) n++;
  return n;
}
