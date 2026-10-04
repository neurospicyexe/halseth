// src/handlers/reach-cap.ts
//
// HTTP routes for the shared triad reach cap (migration 0137; logic in src/webmind/reach-cap.ts).
//   POST /mind/reach/reserve     {companion_id, action_type, care_hold}  -> {reserved, id} | {reserved:false, reason}
//                                (care_hold is ALSO derived server-side since B32; see postReachReserve)
//   POST /mind/reach/delivered   {companion_id, id, path}
//   POST /mind/reach/release     {companion_id, id}
//   GET  /mind/reach/today       ?now=ISO&companion_id=  the lane verdict (ops inspection; never read into a companion's context)
//
// Auth: authGuard, as every /mind/* route. A per-companion token may only act as itself.
// The server computes the time, the local day and the quiet window itself; the client sends none of them.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { reserveReach, markReachDelivered, releaseReach, reachLaneVerdict, reachConfigFrom } from "../webmind/reach-cap.js";
import { readCareHold } from "../care/hold.js";

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function impersonation(request: Request, env: Env, companion: string): Response | null {
  const caller = identifyCallerCompanion(request, env);
  return caller && caller !== companion ? json({ error: "forbidden: token does not match companion_id" }, 403) : null;
}

interface Body { companion_id?: string; action_type?: string; care_hold?: boolean; id?: number; path?: string }

async function readBody(request: Request, env: Env): Promise<{ ok: true; body: Body; companion: string } | { ok: false; res: Response }> {
  let body: Body;
  try { body = await request.json() as Body; } catch { return { ok: false, res: json({ error: "invalid JSON body" }, 400) }; }
  const companion = (body.companion_id ?? "").trim();
  if (!COMPANIONS.has(companion)) return { ok: false, res: json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400) };
  const imp = impersonation(request, env, companion);
  if (imp) return { ok: false, res: imp };
  return { ok: true, body, companion };
}

// POST /mind/reach/reserve
export async function postReachReserve(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await readBody(request, env);
  if (!p.ok) return p.res;
  const actionType = (p.body.action_type ?? "").trim();
  if (!actionType || actionType.length > 40) return json({ error: "action_type is required" }, 400);
  try {
    const nowMs = Date.now();
    // B32: the hold is derived HERE, server-side (care/hold.ts), because under hold offer_presence
    // takes a LOOSER path and the bot's word alone must never loosen the cap. The bot's flag still
    // counts toward the stricter daily total (it may lag the owner phrase by one 5-min refresh, but
    // only in the strict direction). An unreadable hold is no hold: the 0137 rules apply.
    const hold = await readCareHold(env.DB, nowMs).catch(() => null);
    const careHold = (hold?.care_hold ?? false) || p.body.care_hold === true;
    const result = await reserveReach(env.DB, {
      companion: p.companion, actionType, careHold,
      careHoldSince: hold?.care_hold ? hold.care_hold_since : null,
      nowIso: new Date(nowMs).toISOString(),
    }, reachConfigFrom(env));
    console.log("[mind/reach/reserve]", { companion: p.companion, action: actionType, care_hold: careHold, hold_reason: hold?.care_hold_reason ?? null, ...result });
    return json(result);
  } catch (err) {
    console.error("[mind/reach/reserve] error", { companion: p.companion, action: actionType, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/reach/delivered
export async function postReachDelivered(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await readBody(request, env);
  if (!p.ok) return p.res;
  const id = Number(p.body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "id must be a positive integer" }, 400);
  const path = (p.body.path ?? "").trim();
  if (!/^(generated|regenerated(:[a-z_]{1,40})?)$/.test(path)) return json({ error: "path must be 'generated' or 'regenerated:<why>'" }, 400);
  try {
    const updated = await markReachDelivered(env.DB, id, p.companion, new Date().toISOString(), path);
    return json({ updated });
  } catch (err) {
    console.error("[mind/reach/delivered] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/reach/release
export async function postReachRelease(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const p = await readBody(request, env);
  if (!p.ok) return p.res;
  const id = Number(p.body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "id must be a positive integer" }, 400);
  try {
    const released = await releaseReach(env.DB, id, p.companion);
    console.log("[mind/reach/release]", { companion: p.companion, id, released });
    return json({ released });
  } catch (err) {
    console.error("[mind/reach/release] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/reach/today
export async function getReachToday(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const raw = new URL(request.url).searchParams.get("now");
  const t = raw ? Date.parse(raw) : Date.now();
  if (!Number.isFinite(t)) return json({ error: "now must be an ISO timestamp" }, 400);
  try {
    const companion = new URL(request.url).searchParams.get("companion_id") ?? undefined;
    const hold = companion && COMPANIONS.has(companion) ? await readCareHold(env.DB, t).catch(() => null) : null;
    return json(await reachLaneVerdict(env.DB, new Date(t).toISOString(), reachConfigFrom(env), { companion, hold }));
  } catch (err) {
    console.error("[mind/reach/today] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
