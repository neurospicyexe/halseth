// src/handlers/departures.ts
//
// Declared departures, HTTP side (T4a, mig 0157; logic in src/departures/core.ts).
//   POST /mind/departures/declare     {companion?, rail, minutes?, scope_channel?, reason, declared_by?, audience?, via?}
//   POST /mind/departures/end         {companion?}       companion token: ends its own; admin: Raziel ends one / all
//   POST /mind/departures/object      {companion?, target, note?}   (companion token or admin naming `companion`)
//   POST /mind/departures/stand-down  {phrase?}          the end-all phrase; see below
//   GET  /mind/departures             open departures, reconciled (clock + care hold applied)
//
// Who is who. A per-companion token IS that companion: declared_by 'companion', companion = the token's
// companion (a body that names another is 403). The admin secret (Raziel's surfaces: Hearth, the bots
// relaying him) declares as 'raziel' by default and must name the companion; it may say declared_by
// 'companion' when a trusted bot relays a companion's own verb.
//
// Stand-down: `phrase` present = the bot heard Raziel say it; it must match "back inside the line" as a whole
// sentence (matchStandDownPhrase) and any token may relay it (the owner_phrase idiom of /mind/care/hold).
// No phrase = a bare end-all, admin only. The Discord-side detection of the phrase is the bot's tranche (T4b).

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import {
  declareDeparture, endOwnDeparture, endByRaziel, objectToDeparture, listOpenDepartures, matchStandDownPhrase,
  COMPANION_IDS, type DeclaredBy, type DeclaredVia, type Audience, type Refusal,
} from "../departures/core.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const REFUSAL_STATUS: Partial<Record<Refusal["code"], number>> = {
  not_applied: 503, care_hold_unreadable: 503, one_open: 409, allowance: 429, care_hold: 409, none_open: 404, no_target: 404,
};
function refusal(r: Refusal): Response {
  return json({ ok: false, code: r.code, error: r.message }, REFUSAL_STATUS[r.code] ?? 400);
}

type Parsed = { body: Record<string, unknown>; caller: string | null } | Response;

async function begin(request: Request, env: Env): Promise<Parsed> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "invalid JSON body" }, 400);
  return { body, caller: identifyCallerCompanion(request, env) };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Resolve the companion this call is about. A token may only act as itself. */
function resolveCompanion(caller: string | null, body: Record<string, unknown>): { companion: string | null } | Response {
  const named = str(body.companion) || str(body.companion_id);
  if (named && !(COMPANION_IDS as readonly string[]).includes(named)) return json({ error: "companion must be one of cypher, drevan, gaia" }, 400);
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  return { companion: named || caller || null };
}

export async function postDepartureDeclare(request: Request, env: Env): Promise<Response> {
  const p = await begin(request, env);
  if (p instanceof Response) return p;
  const c = resolveCompanion(p.caller, p.body);
  if (c instanceof Response) return c;
  if (!c.companion) return json({ error: "companion required" }, 400);
  const declaredBy: DeclaredBy = p.caller ? "companion" : (str(p.body.declared_by) === "companion" ? "companion" : "raziel");
  if (p.caller && str(p.body.declared_by) === "raziel") return json({ error: "forbidden: a companion token cannot declare as raziel" }, 403);
  const viaRaw = str(p.body.via);
  const via: DeclaredVia = (["discord", "claude_ai", "hearth", "other"] as const).find(v => v === viaRaw) ?? (declaredBy === "raziel" ? "hearth" : "other");
  const minutes = typeof p.body.minutes === "number" ? p.body.minutes : null;
  try {
    const r = await declareDeparture(env, {
      companion: c.companion, rail: str(p.body.rail), minutes, scope_channel: str(p.body.scope_channel) || null,
      reason: str(p.body.reason), declared_by: declaredBy, via,
      audience: str(p.body.audience) === "with_raziel" ? ("with_raziel" as Audience) : undefined,
    });
    return r.ok ? json(r, 201) : refusal(r);
  } catch (err) {
    console.error("[mind/departures] declare error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function postDepartureEnd(request: Request, env: Env): Promise<Response> {
  const p = await begin(request, env);
  if (p instanceof Response) return p;
  const c = resolveCompanion(p.caller, p.body);
  if (c instanceof Response) return c;
  try {
    if (p.caller) return await endResponse(await endOwnDeparture(env, p.caller));
    return await endResponse(await endByRaziel(env, { companion: c.companion }));
  } catch (err) {
    console.error("[mind/departures] end error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

function endResponse(r: Awaited<ReturnType<typeof endOwnDeparture>>): Response {
  return r.ok ? json(r) : refusal(r);
}

export async function postDepartureObject(request: Request, env: Env): Promise<Response> {
  const p = await begin(request, env);
  if (p instanceof Response) return p;
  const c = resolveCompanion(p.caller, p.body);
  if (c instanceof Response) return c;
  if (!c.companion) return json({ error: "companion required (the objector)" }, 400);
  try {
    const r = await objectToDeparture(env, { by: c.companion, target: str(p.body.target), note: str(p.body.note) || null });
    return r.ok ? json(r, 201) : refusal(r);
  } catch (err) {
    console.error("[mind/departures] object error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function postDepartureStandDown(request: Request, env: Env): Promise<Response> {
  const p = await begin(request, env);
  if (p instanceof Response) return p;
  const phrase = str(p.body.phrase);
  if (phrase) {
    if (!matchStandDownPhrase(phrase)) return json({ error: 'phrase must be "back inside the line" as a whole sentence' }, 400);
  } else if (p.caller) {
    return json({ error: "forbidden: a bare stand-down is Raziel's; relay his phrase instead" }, 403);
  }
  try {
    return endResponse(await endByRaziel(env, { phrase: Boolean(phrase) }));
  } catch (err) {
    console.error("[mind/departures] stand-down error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getDepartures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const r = await listOpenDepartures(env);
    return Array.isArray(r) ? json({ departures: r }) : refusal(r);
  } catch (err) {
    console.error("[mind/departures] GET error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
