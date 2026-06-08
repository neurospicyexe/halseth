// src/handlers/home.ts
//
// HTTP route handlers for "The Home" inhabited place-graph.
//   GET  /home/presence -- all home_presence rows + room graph
//   GET  /home/events   -- recent events for a companion (?companion_id=, ?limit=)
//   POST /home/tick     -- run a placement tick on demand
//
// Auth: authGuard (ADMIN_SECRET / per-companion tokens), enforced here at the
// handler level so the test suite exercises the 401 path directly, matching the
// pattern used by handlers/growth.ts. The worker entry (index.ts) also runs
// authGuard before routing, so this is defense-in-depth, not redundant cost.

import type { Env } from "../types.js";
import type { CompanionId } from "../webmind/types.js";
import { authGuard } from "../lib/auth.js";
import { getRooms } from "../webmind/home/rooms.js";
import { recentEvents, upsertPresence } from "../webmind/home/store.js";
import { runHomeTick } from "../webmind/home/tick.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);

// GET /home/presence
export async function getHomePresence(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const rooms = await getRooms(env);
  const rows = await env.DB.prepare(
    "SELECT * FROM home_presence ORDER BY companion_id",
  ).all();
  return json({ presence: rows.results ?? [], rooms });
}

// GET /home/events?companion_id=cypher&limit=20
export async function getHomeEvents(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const raw = url.searchParams.get("companion_id") ?? "cypher";
  const id = (VALID_COMPANIONS.has(raw) ? raw : "cypher") as CompanionId;

  const parsed = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;

  const events = await recentEvents(env, id, limit);
  return json({ events });
}

// POST /home/tick
export async function postHomeTick(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const result = await runHomeTick(env);
  return json({ ran: true, result });
}

// PATCH /home/presence
// Allows the autonomous worker to write its current room at pipeline start.
// Body: { companion_id, current_room, activity? }
export async function patchHomePresence(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ error: "invalid JSON" }, 400); }

  const companionId = body["companion_id"];
  const currentRoom = body["current_room"];
  const activity = body["activity"];

  if (typeof companionId !== "string" || !VALID_COMPANIONS.has(companionId)) {
    return json({ error: "invalid companion_id" }, 400);
  }
  if (typeof currentRoom !== "string" || !currentRoom.trim()) {
    return json({ error: "current_room required" }, 400);
  }

  const activityText = (typeof activity === "string" && activity.trim()) ? activity.trim() : "present";

  try {
    await upsertPresence(env, companionId as CompanionId, currentRoom.trim(), activityText, 0);
    return json({ ok: true });
  } catch {
    return json({ error: "invalid room or write failed" }, 400);
  }
}
