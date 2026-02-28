import { Env } from "../types.js";

// ── Auth helper ──────────────────────────────────────────────────────────────

function checkBridgeAuth(request: Request, env: Env): boolean {
  if (!env.BRIDGE_SECRET) return true; // no secret configured — open (dev only)
  const auth = request.headers.get("Authorization") ?? "";
  return auth === `Bearer ${env.BRIDGE_SECRET}`;
}

// ── GET /bridge/shared ────────────────────────────────────────────────────────
// Returns shared items for all currently-enabled categories.
// Protected by BRIDGE_SECRET. Partner calls this to read shared data.

export async function getBridgeShared(request: Request, env: Env): Promise<Response> {
  if (!checkBridgeAuth(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sharingRows = await env.DB.prepare(
    "SELECT category, enabled FROM bridge_sharing"
  ).all<{ category: string; enabled: number }>();

  const enabledSet = new Set(
    (sharingRows.results ?? []).filter((r) => r.enabled === 1).map((r) => r.category)
  );

  const [tasksResult, eventsResult, listsResult] = await Promise.all([
    enabledSet.has("tasks")
      ? env.DB.prepare("SELECT * FROM tasks WHERE shared = 1 AND status != 'done'").all()
      : Promise.resolve({ results: [] }),
    enabledSet.has("events")
      ? env.DB.prepare("SELECT * FROM events WHERE shared = 1").all()
      : Promise.resolve({ results: [] }),
    enabledSet.has("lists")
      ? env.DB.prepare("SELECT * FROM lists WHERE shared = 1 AND completed = 0").all()
      : Promise.resolve({ results: [] }),
  ]);

  return new Response(
    JSON.stringify({
      system: env.SYSTEM_NAME,
      enabled: [...enabledSet],
      tasks:  tasksResult.results ?? [],
      events: eventsResult.results ?? [],
      lists:  listsResult.results ?? [],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ── POST /bridge/act ──────────────────────────────────────────────────────────
// Applies a partner-initiated action to a shared item.
// Safety: only operates on rows where shared = 1.

export async function postBridgeAct(request: Request, env: Env): Promise<Response> {
  if (!checkBridgeAuth(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { action?: string; id?: string; status?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { action, id, status } = body;
  if (!action || !id) {
    return new Response("Missing action or id", { status: 400 });
  }

  const now = new Date().toISOString();

  if (action === "task_status") {
    const validStatuses = ["open", "in_progress", "done"];
    if (!status || !validStatuses.includes(status)) {
      return new Response("Invalid status", { status: 400 });
    }
    const result = await env.DB.prepare(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND shared = 1"
    ).bind(status, now, id).run();
    if (result.meta.changes === 0) {
      return new Response("Not found or not shared", { status: 404 });
    }
    return new Response(JSON.stringify({ ok: true, id, status }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (action === "list_complete") {
    const result = await env.DB.prepare(
      "UPDATE lists SET completed = 1, completed_at = ? WHERE id = ? AND shared = 1"
    ).bind(now, id).run();
    if (result.meta.changes === 0) {
      return new Response("Not found or not shared", { status: 404 });
    }
    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Unknown action", { status: 400 });
}
