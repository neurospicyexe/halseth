import { Env, Routine } from "../types.js";
import { generateId } from "../db/queries.js";

function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// GET /routines?today=true — returns routine logs.
// today=true: only today's logs. Otherwise returns the most recent 20.
export async function getRoutines(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const todayOnly = url.searchParams.get("today") === "true";

  const result = todayOnly
    ? await env.DB.prepare(
        "SELECT * FROM routines WHERE DATE(logged_at) = DATE('now') ORDER BY logged_at DESC"
      ).all<Routine>()
    : await env.DB.prepare(
        "SELECT * FROM routines ORDER BY logged_at DESC LIMIT 20"
      ).all<Routine>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /routines — log a routine completion.
// Body: { routine_name, owner?, notes? }
export async function logRoutine(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

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
