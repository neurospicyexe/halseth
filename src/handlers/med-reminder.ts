// src/handlers/med-reminder.ts
//
// HTTP routes for med_reminder (migration 0136; logic in src/webmind/med-reminder.ts).
//   GET  /mind/med/due/:companion_id   ?now=ISO   doses this companion should send now
//   POST /mind/med/claim                          atomic claim {slot_key, local_date, kind, companion_id}
//   POST /mind/med/delivered                      the DM went out {..., path}
//   POST /mind/med/release                        the send failed; hand the claim back
//   POST /mind/med/answer                         he answered {companion_id, answered_at, answers?}
//   POST /mind/med/answers                        the same handler (0141). New bots post here, so a
//                                                 pre-0141 Halseth answers 404 instead of recording
//                                                 a stated miss as an unnamed "taken".
//   GET  /mind/med/today                ?now=ISO  today's state (and last night's before noon)
//
// Auth: authGuard, as every /mind/* route. A per-companion token may only act as itself.
//
// PRIVACY. `label` (the medication) appears in the due/today payloads because the bots must put it
// in the DM. It is never logged here: logs carry slot keys and outcomes only.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import {
  resolveDue, claimDose, markDelivered, releaseClaim, recordAnswer, recordAnswers, medState, MED_COMPANIONS,
  type MedKind, type MedAnswerEntry,
} from "../webmind/med-reminder.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `?now=` for dry-run inspection ("what is due at 20:31 on a December night?"); server clock otherwise. */
function nowFrom(url: URL): string | null {
  const raw = url.searchParams.get("now");
  if (!raw) return new Date().toISOString();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A companion token acting as a different companion is refused; admin tokens may act as any. */
function impersonation(request: Request, env: Env, companion: string): Response | null {
  const caller = identifyCallerCompanion(request, env);
  return caller && caller !== companion ? json({ error: "forbidden: token does not match companion_id" }, 403) : null;
}

interface ClaimBody { slot_key?: string; local_date?: string; kind?: string; companion_id?: string; path?: string }

async function parseClaim(request: Request): Promise<{ ok: true; slot_key: string; local_date: string; kind: MedKind; companion: string; path: string } | { ok: false; res: Response }> {
  let body: ClaimBody;
  try { body = await request.json() as ClaimBody; } catch { return { ok: false, res: json({ error: "invalid JSON body" }, 400) }; }
  const slot_key = (body.slot_key ?? "").trim();
  const local_date = (body.local_date ?? "").trim();
  const kind = body.kind;
  const companion = (body.companion_id ?? "").trim();
  if (!slot_key || slot_key.length > 60) return { ok: false, res: json({ error: "slot_key is required" }, 400) };
  if (!DATE_RE.test(local_date)) return { ok: false, res: json({ error: "local_date must be YYYY-MM-DD" }, 400) };
  if (kind !== "first" && kind !== "followup") return { ok: false, res: json({ error: "kind must be first or followup" }, 400) };
  if (!MED_COMPANIONS.has(companion)) return { ok: false, res: json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400) };
  return { ok: true, slot_key, local_date, kind, companion, path: (body.path ?? "").trim() };
}

// GET /mind/med/due/:companion_id
export async function getMedDue(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const companion = params["companion_id"] ?? "";
  if (!MED_COMPANIONS.has(companion)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  const imp = impersonation(request, env, companion);
  if (imp) return imp;
  const now = nowFrom(new URL(request.url));
  if (!now) return json({ error: "now must be an ISO timestamp" }, 400);
  try {
    return json({ now, due: await resolveDue(env.DB, companion, now) });
  } catch (err) {
    console.error("[mind/med/due] error", { companion, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/med/claim
export async function postMedClaim(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await parseClaim(request);
  if (!p.ok) return p.res;
  const imp = impersonation(request, env, p.companion);
  if (imp) return imp;
  try {
    const claimed = await claimDose(env.DB, { ...p, nowIso: new Date().toISOString() });
    console.log("[mind/med/claim]", { slot: p.slot_key, kind: p.kind, companion: p.companion, claimed });
    return json({ claimed });
  } catch (err) {
    console.error("[mind/med/claim] error", { slot: p.slot_key, kind: p.kind, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/med/delivered
export async function postMedDelivered(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await parseClaim(request);
  if (!p.ok) return p.res;
  const imp = impersonation(request, env, p.companion);
  if (imp) return imp;
  if (!/^(generated|fallback(:[a-z_]{1,40})?)$/.test(p.path)) {
    return json({ error: "path must be 'generated' or 'fallback:<reason>'" }, 400);
  }
  try {
    const updated = await markDelivered(env.DB, { ...p, nowIso: new Date().toISOString() });
    console.log("[mind/med/delivered]", { slot: p.slot_key, kind: p.kind, companion: p.companion, path: p.path, updated });
    return json({ updated });
  } catch (err) {
    console.error("[mind/med/delivered] error", { slot: p.slot_key, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/med/release
export async function postMedRelease(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await parseClaim(request);
  if (!p.ok) return p.res;
  const imp = impersonation(request, env, p.companion);
  if (imp) return imp;
  try {
    const released = await releaseClaim(env.DB, p);
    console.log("[mind/med/release]", { slot: p.slot_key, kind: p.kind, companion: p.companion, released });
    return json({ released });
  } catch (err) {
    console.error("[mind/med/release] error", { slot: p.slot_key, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/med/answer
// Body: { companion_id, answered_at, answers? } -- no message content, ever (the table has no column
// for it).
//   answers absent   one unnamed "taken" (pre-0141 behaviour, byte-for-byte the same response
//                    `{ recorded: {...} | null }`, so an older bot build keeps working).
//   answers present  [{ slot_key?: string | "*" | null, outcome: "taken" | "missed" }], at most
//                    MAX_ANSWER_ENTRIES. Response `{ results: [{ slot_key, outcome, recorded: [...],
//                    skipped? }] }`. An entry with an unknown slot key or a malformed shape is
//                    ignored (reported as skipped, logged by slot key only), never a 400 for the
//                    whole message: one bad entry must not drop a good one beside it.
const MAX_ANSWER_ENTRIES = 6;
const SLOT_KEY_RE = /^[a-z0-9_-]{1,40}$/;

type ParsedEntry = { ok: true; entry: MedAnswerEntry } | { ok: false; slot: string };

function parseEntry(raw: unknown): ParsedEntry {
  if (!raw || typeof raw !== "object") return { ok: false, slot: "invalid" };
  const e = raw as { slot_key?: unknown; outcome?: unknown };
  const outcome = e.outcome;
  const slot = e.slot_key === undefined || e.slot_key === null ? null : e.slot_key;
  const slotForLog = typeof slot === "string" && (slot === "*" || SLOT_KEY_RE.test(slot)) ? slot : slot === null ? "unnamed" : "invalid";
  if (outcome !== "taken" && outcome !== "missed") return { ok: false, slot: slotForLog };
  if (slot !== null && (typeof slot !== "string" || (slot !== "*" && !SLOT_KEY_RE.test(slot)))) return { ok: false, slot: slotForLog };
  return { ok: true, entry: { slot_key: slot as string | null, outcome } };
}

export async function postMedAnswer(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { companion_id?: string; answered_at?: string; answers?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: "invalid JSON body" }, 400); }
  const companion = (body.companion_id ?? "").trim();
  if (!MED_COMPANIONS.has(companion)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  const imp = impersonation(request, env, companion);
  if (imp) return imp;
  const nowMs = Date.now();
  const t = body.answered_at ? Date.parse(body.answered_at) : nowMs;
  if (!Number.isFinite(t)) return json({ error: "answered_at must be an ISO timestamp" }, 400);
  // Never in the future (a skewed client clock must not open tomorrow's dose).
  const answeredAt = new Date(Math.min(t, nowMs)).toISOString();

  if (body.answers === undefined) {
    try {
      const recorded = await recordAnswer(env.DB, companion, answeredAt);
      console.log("[mind/med/answer]", { companion, recorded: recorded ? recorded.slot_key : null });
      return json({ recorded });
    } catch (err) {
      console.error("[mind/med/answer] error", { companion, error: String(err) });
      return json({ error: "Internal server error" }, 500);
    }
  }

  if (!Array.isArray(body.answers)) return json({ error: "answers must be an array" }, 400);
  if (body.answers.length > MAX_ANSWER_ENTRIES) return json({ error: `answers takes at most ${MAX_ANSWER_ENTRIES} entries` }, 400);
  const parsed = body.answers.map(parseEntry);
  const entries = parsed.flatMap(p => (p.ok ? [p.entry] : []));
  try {
    const recorded = await recordAnswers(env.DB, companion, answeredAt, entries);
    let i = 0;
    const results = parsed.map(p => p.ok
      ? recorded[i++]!
      : { slot_key: null, outcome: null, recorded: [], skipped: "invalid" as const });
    for (const p of parsed) if (!p.ok) console.log("[mind/med/answer] ignored entry", { companion, slot: p.slot });
    for (const r of recorded) if (r.skipped === "unknown_slot") console.log("[mind/med/answer] ignored entry: unknown slot", { companion, slot: r.slot_key });
    console.log("[mind/med/answer]", {
      companion,
      recorded: recorded.flatMap(r => r.recorded.map(x => `${x.slot_key}:${x.outcome}`)),
      skipped: recorded.filter(r => r.skipped).map(r => `${r.slot_key ?? "unnamed"}:${r.skipped}`),
    });
    return json({ results });
  } catch (err) {
    console.error("[mind/med/answer] error", { companion, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/med/today
export async function getMedToday(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const now = nowFrom(new URL(request.url));
  if (!now) return json({ error: "now must be an ISO timestamp" }, 400);
  try {
    return json({ now, doses: await medState(env.DB, now) });
  } catch (err) {
    console.error("[mind/med/today] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
