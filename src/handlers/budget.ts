// src/handlers/budget.ts
//
// HTTP surface for the weekly budget (consequence layer C3, mig 0124).
//
//   GET  /mind/budget/:companion_id -- remaining/total/week/spent-by-purpose. The render rule
//                                      rides the shape: a budget must state its denominator.
//   POST /mind/budget/spend         -- the autonomous worker debits 1 credit per run with its
//                                      purpose. An empty budget answers ok:false WITH the reason;
//                                      the worker turns that into an in-band skip, never silence.

import type { Env } from "../types.js";
import { readBudget, spendBudget, type SpendPurpose } from "../care/budget.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

export async function getBudget(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  return json(await readBudget(env, companionId));
}

export async function postBudgetSpend(request: Request, env: Env): Promise<Response> {
  let body: { companion_id?: string; purpose?: string; ref?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  const purpose = String(body.purpose ?? "");
  if (!VALID_COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  if (!(purpose === "project" || purpose === "self" || purpose.startsWith("gift:"))) {
    return json({ error: "purpose must be project | self | gift:<who>" }, 400);
  }
  const result = await spendBudget(env, companionId, purpose as SpendPurpose, body.ref);
  return json(result, result.ok ? 200 : 409);
}
