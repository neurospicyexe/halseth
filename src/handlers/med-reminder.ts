// src/handlers/med-reminder.ts
//
// HTTP routes for med_reminder (migration 0136; logic in src/webmind/med-reminder.ts).
//   GET  /mind/med/due/:companion_id   ?now=ISO   doses this companion should send now
//   POST /mind/med/claim                          atomic claim {slot_key, local_date, kind, companion_id}
//   POST /mind/med/delivered                      the DM went out {..., path}
//   POST /mind/med/release                        the send failed; hand the claim back
//   POST /mind/med/answer                         he said yes {companion_id, answered_at}
//   GET  /mind/med/today                ?now=ISO  today's state (and last night's before noon)
//
// Auth: authGuard, as every /mind/* route. A per-companion token may only act as itself.
//
// PRIVACY. `label` (the medication) appears in the due/today payloads because the bots must put it
// in the DM. It is never logged here: logs carry slot keys and outcomes only.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import {
  resolveDue, claimDose, markDelivered, releaseClaim, recordAnswer, medState, MED_COMPANIONS,
  type MedKind,
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
// Body: { companion_id, answered_at } -- no message content, ever (the table has no column for it).
export async function postMedAnswer(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { companion_id?: string; answered_at?: string };
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
  try {
    const recorded = await recordAnswer(env.DB, companion, answeredAt);
    console.log("[mind/med/answer]", { companion, recorded: recorded ? recorded.slot_key : null });
    return json({ recorded });
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
