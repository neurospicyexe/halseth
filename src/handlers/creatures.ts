// src/handlers/creatures.ts
//
// HTTP routes for creatures (migration 0078, take 10).
//   GET  /mind/creatures                 -- all creatures (corvid + Raziel's animals)
//   GET  /mind/creatures/:id             -- one creature + its recent interaction log
//   POST /mind/creatures/:id/interact    -- feed|play|talk|give (atomic trust bump)
//   POST /mind/creatures/tick            -- daily decay/mood recompute (server-side)
//
// Interaction trust is bumped at the SQL level (concurrent owner + triad interactions
// never race a JS read-modify-write). The tick is a single server-side pass that cools
// untended trust toward baseline and re-derives mood -- deterministic, no LLM. Auth:
// authGuard, matching handlers/forage.ts + handlers/drives.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  isValidAction,
  trustDelta,
  actionMood,
  decayedTrust,
  deriveMood,
  daysSinceIso,
  listCreaturesSql,
  getCreatureSql,
  recentInteractionsSql,
  insertInteractionSql,
  interactBumpSql,
  tickUpdateSql,
} from "../webmind/creatures.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_ACTORS = new Set<string>(["raziel", "cypher", "drevan", "gaia"]);

interface CreatureRow {
  id: string; name: string; species: string | null; kind: string; owner: string;
  bio: string | null; state_json: string | null; trust: number;
  last_interaction_at: string | null; created_at: string;
}

// GET /mind/creatures
export async function getCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const rows = await env.DB.prepare(listCreaturesSql()).all<CreatureRow>();
    return json({ creatures: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/creatures] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/creatures/:id
export async function getCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const creature = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!creature) return json({ error: "creature not found" }, 404);
    const interactions = await env.DB.prepare(recentInteractionsSql()).bind(id, 20).all();
    return json({ creature, interactions: interactions.results ?? [] });
  } catch (err) {
    console.error("[mind/creatures] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/:id/interact   { actor, action, note? }
export async function interactCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { actor?: string; action?: string; note?: string };
  try {
    body = await request.json() as { actor?: string; action?: string; note?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const actor = (body.actor ?? "").trim().toLowerCase();
  const action = (body.action ?? "").trim().toLowerCase();
  if (!VALID_ACTORS.has(actor)) {
    return json({ error: "actor must be one of raziel, cypher, drevan, gaia" }, 400);
  }
  if (!isValidAction(action)) {
    return json({ error: "action must be one of feed, play, talk, give" }, 400);
  }
  const note = body.note?.trim().slice(0, 500) ?? null;

  try {
    const exists = await env.DB.prepare("SELECT id FROM creatures WHERE id = ?").bind(id).first<{ id: string }>();
    if (!exists) return json({ error: "creature not found" }, 404);

    const interactionId = crypto.randomUUID().replace(/-/g, "");
    await env.DB.batch([
      env.DB.prepare(insertInteractionSql()).bind(interactionId, id, actor, action, note),
      env.DB.prepare(interactBumpSql()).bind(trustDelta(action), actionMood(action), id),
    ]);

    const updated = await env.DB.prepare("SELECT trust, state_json FROM creatures WHERE id = ?").bind(id).first<{ trust: number; state_json: string | null }>();
    return json({ interacted: true, action, trust: updated?.trust ?? null, state_json: updated?.state_json ?? null });
  } catch (err) {
    console.error("[mind/creatures] interact error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/tick   -- daily decay + mood recompute (worker CREATURE_CRON trigger)
export async function tickCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const rows = await env.DB.prepare(listCreaturesSql()).all<CreatureRow>();
    const creatures = rows.results ?? [];
    const now = Date.now();
    let ticked = 0;
    for (const c of creatures) {
      const days = daysSinceIso(c.last_interaction_at ?? c.created_at, now);
      const newTrust = decayedTrust(c.trust, days);
      const newMood = deriveMood(newTrust);
      // Only write when something actually changed (avoid pointless churn on fresh rows).
      if (Math.abs(newTrust - c.trust) > 1e-6 || days >= 1) {
        await env.DB.prepare(tickUpdateSql()).bind(Number(newTrust.toFixed(4)), newMood, c.id).run();
        ticked++;
      }
    }
    return json({ ok: true, ticked, total: creatures.length });
  } catch (err) {
    console.error("[mind/creatures] tick error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
