import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { authGuard } from "../lib/auth.js";

// GET /routines is served by handlers/history.ts (?date=YYYY-MM-DD). A second
// unrouted (and unauthenticated) getRoutines used to live here; removed 2026-07-06.

// POST /routines — log a routine completion. Append-only: meds AM + PM,
// water five times, mid-day re-logs are all separate rows.
// Body: { routine_name, owner?, notes? }
export async function logRoutine(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  if (env.COORDINATION_ENABLED !== "true") {
    return new Response("Coordination zone disabled", { status: 403 });
  }

  let body: { routine_name?: string; owner?: string; notes?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.routine_name) {
    return new Response("routine_name is required", { status: 400 });
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO routines (id, routine_name, owner, logged_at, notes) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, body.routine_name, body.owner ?? null, now, body.notes ?? null).run();

  return new Response(JSON.stringify({ id, logged_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
