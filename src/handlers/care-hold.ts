// src/handlers/care-hold.ts
//
// B32 D3: his word starts and clears care_hold (mig 0143; derivation in src/care/hold.ts).
//   POST /mind/care/hold   {action: 'start'|'clear', source: 'owner_phrase'|'companion', companion}
//                          -> {ok, action, id, at, care_hold, care_hold_reason, care_hold_since}
//   GET  /mind/care/hold   -> {care_hold, care_hold_reason, care_hold_since}   (the server's hold, fresh)
//
//   source 'owner_phrase'  the bot heard "bad night" / "good now" / "I'm okay now" from Raziel as the
//                          whole message or its own sentence. `companion` = the one he said it to.
//   source 'companion'     the companion he is talking to sets (or clears) it on his behalf, only when
//                          he has plainly said the night is bad (Drevan, D3). `companion` required.
// `companion_id` is accepted as an alias of `companion` (every other /mind route spells it that way).
//
// The response carries the hold as the server derives it AFTER the write, so the first reply can say
// "Hold's on. I'm here." from truth rather than from the bot's 5-minute cache.
//
// Auth: authGuard, as every /mind/* route. A per-companion token may only act as itself.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { readCareHold, writeHoldEvent, HOLD_ACTIONS, HOLD_SOURCES, type HoldAction, type HoldSource } from "../care/hold.js";

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

interface Body { action?: string; source?: string; companion?: string; companion_id?: string }

// POST /mind/care/hold
export async function postCareHold(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Body;
  try { body = await request.json() as Body; } catch { return json({ error: "invalid JSON body" }, 400); }

  const action = (body.action ?? "").trim() as HoldAction;
  if (!HOLD_ACTIONS.includes(action)) return json({ error: "action must be 'start' or 'clear'" }, 400);
  const source = (body.source ?? "").trim() as HoldSource;
  if (!HOLD_SOURCES.includes(source)) return json({ error: "source must be 'owner_phrase' or 'companion'" }, 400);

  const caller = identifyCallerCompanion(request, env);
  const named = (body.companion ?? body.companion_id ?? "").trim();
  if (named && !COMPANIONS.has(named)) return json({ error: "companion must be one of cypher, drevan, gaia" }, 400);
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  const companion = named || caller || null;
  if (source === "companion" && !companion) return json({ error: "source 'companion' needs companion" }, 400);

  try {
    const r = await writeHoldEvent(env, { action, source, companion });
    return json({ ok: true, action: r.action, id: r.id, at: r.at, ...r.state });
  } catch (err) {
    console.error("[mind/care/hold] error", { action, source, companion, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/care/hold
export async function getCareHold(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    return json(await readCareHold(env.DB));
  } catch (err) {
    console.error("[mind/care/hold] GET error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
