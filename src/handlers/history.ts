// Read-only history feed endpoints.
// GET /handovers, /companion-journal, /cypher-audit, /gaia-witness, /wounds, /routines, /deltas
// GET /tasks, /events, /lists
// PATCH /tasks/:id

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { generateId } from "../db/queries.js";
import type {
  HandoverPacket,
  CypherAudit,
  GaiaWitness,
  LivingWound,
  Task,
  CalendarEvent,
  ListItem,
  Routine,
  RelationalDeltaV4,
} from "../types.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /handovers?limit=20&offset=0
export async function getHandovers(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url    = new URL(request.url);
  const limit  = clampLimit(url.searchParams.get("limit"), 20, 100);
  const rawOff = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = isNaN(rawOff) ? 0 : Math.max(0, rawOff);

  const result = await env.DB.prepare(`
    SELECT hp.*, s.session_type, s.front_state AS session_front_state
    FROM handover_packets hp
    LEFT JOIN sessions s ON hp.session_id = s.id
    ORDER BY hp.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<HandoverPacket & { session_type: string | null; session_front_state: string | null }>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /companion-journal?agent=drevan&limit=20&since=<ISO8601>
export async function getCompanionJournal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url   = new URL(request.url);
  const agent = url.searchParams.get("agent");
  const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
  const since = url.searchParams.get("since") ?? undefined;

  if (since !== undefined && isNaN(Date.parse(since))) {
    return new Response(JSON.stringify({ error: "invalid since parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validAgents = new Set(["drevan", "cypher", "gaia"]);
  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (agent && validAgents.has(agent)) {
    conditions.push("agent = ?");
    bindings.push(agent);
  }
  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT id, created_at, agent, note_text, tags, session_id
    FROM companion_journal
    ${where}
    ORDER BY created_at ${orderDir}
    LIMIT ?
  `).bind(...bindings).all();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /cypher-audit?limit=50
export async function getCypherAudit(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url   = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  const result = await env.DB.prepare(`
    SELECT * FROM cypher_audit ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all<CypherAudit>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /gaia-witness?limit=50
export async function getGaiaWitness(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url   = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  const result = await env.DB.prepare(`
    SELECT * FROM gaia_witness ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all<GaiaWitness>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /wounds
export async function getWounds(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const result = await env.DB.prepare(`
    SELECT id, created_at, name, description FROM living_wounds
  `).all<Pick<LivingWound, "id" | "created_at" | "name" | "description">>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /routines?date=YYYY-MM-DD
// Returns routine completions for the given date (defaults to today UTC).
export async function getRoutines(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url      = new URL(request.url);
  const rawDate  = url.searchParams.get("date");
  // Validate date format: YYYY-MM-DD
  const dateStr  = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date().toISOString().slice(0, 10);

  const result = await env.DB.prepare(`
    SELECT id, routine_name, owner, logged_at, notes
    FROM routines
    WHERE DATE(logged_at) = ?
    ORDER BY logged_at ASC
  `).bind(dateStr).all<Routine>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /deltas?valence=tender&agent=drevan&limit=20&since=<ISO8601>
// Cross-companion delta feed — only returns rows with delta_text (spec v0.4 rows).
export async function getDeltas(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url    = new URL(request.url);
  const limit  = clampLimit(url.searchParams.get("limit"), 20, 100);
  const since  = url.searchParams.get("since") ?? undefined;

  if (since !== undefined && isNaN(Date.parse(since))) {
    return new Response(JSON.stringify({ error: "invalid since parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validValences = new Set(["toward", "neutral", "tender", "rupture", "repair"]);
  const validAgents   = new Set(["drevan", "cypher", "gaia"]);

  const valence = url.searchParams.get("valence");
  const agent   = url.searchParams.get("agent");

  const conditions: string[] = ["delta_text IS NOT NULL"];
  const bindings: unknown[]  = [];

  if (valence && validValences.has(valence)) {
    conditions.push("valence = ?");
    bindings.push(valence);
  }
  if (agent && validAgents.has(agent)) {
    conditions.push("agent = ?");
    bindings.push(agent);
  }
  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT id, session_id, created_at, agent, delta_text, valence, initiated_by
    FROM relational_deltas
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ${orderDir}
    LIMIT ?
  `).bind(...bindings).all<RelationalDeltaV4>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /tasks?status=open|in_progress|done — all tasks, sorted by priority then due date.
// Defaults to non-done tasks.
export async function getTasks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url    = new URL(request.url);
  const status = url.searchParams.get("status");
  const validStatuses = new Set(["open", "in_progress", "done"]);

  const sql = status && validStatuses.has(status)
    ? `SELECT id, title, description, priority, status, due_at, assigned_to, created_by
       FROM tasks WHERE status = ?
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, due_at ASC NULLS LAST`
    : `SELECT id, title, description, priority, status, due_at, assigned_to, created_by
       FROM tasks WHERE status != 'done'
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, due_at ASC NULLS LAST`;

  const result = status && validStatuses.has(status)
    ? await env.DB.prepare(sql).bind(status).all<Task>()
    : await env.DB.prepare(sql).all<Task>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /events — upcoming calendar events, ordered by start_time.
export async function getEvents(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const result = await env.DB.prepare(`
    SELECT id, title, description, start_time, end_time, category
    FROM events
    WHERE start_time >= datetime('now')
    ORDER BY start_time ASC
    LIMIT 50
  `).all<CalendarEvent>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /lists?name=groceries — list items grouped by list_name, incomplete first.
// If ?name= is provided, filters to that list only.
export async function getLists(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url  = new URL(request.url);
  const name = url.searchParams.get("name");

  // Exclude items completed more than 7 days ago — they fall away naturally.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = name
    ? await env.DB.prepare(`
        SELECT id, list_name, item_text, added_by, added_at, completed
        FROM lists WHERE list_name = ?
          AND (completed = 0 OR completed_at > ?)
        ORDER BY completed ASC, added_at ASC
      `).bind(name, cutoff).all<ListItem>()
    : await env.DB.prepare(`
        SELECT id, list_name, item_text, added_by, added_at, completed
        FROM lists WHERE completed = 0 OR completed_at > ?
        ORDER BY list_name ASC, completed ASC, added_at ASC
      `).bind(cutoff).all<ListItem>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// POST /lists/:id/complete — mark a list item as completed.
export async function completeListItem(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: { "Content-Type": "application/json" } });

  await env.DB.prepare(
    "UPDATE lists SET completed = 1, completed_at = ? WHERE id = ?"
  ).bind(new Date().toISOString(), id).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}

// PATCH /tasks/:id — update task status. When → "done", logs a companion_journal entry
// so companions see the completion and don't re-surface the task.
export async function patchTask(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;

  const id = params.id;
  if (!id) return new Response("Missing task id", { status: 400 });

  let body: { status?: string };
  try { body = await request.json() as { status?: string }; }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const VALID = ["open", "in_progress", "done"] as const;
  if (!body.status || !VALID.includes(body.status as typeof VALID[number])) {
    return new Response("status must be open, in_progress, or done", { status: 400 });
  }
  const status = body.status as typeof VALID[number];
  const now = new Date().toISOString();

  const existing = await env.DB.prepare(
    "SELECT id, title, assigned_to FROM tasks WHERE id = ?"
  ).bind(id).first<{ id: string; title: string; assigned_to: string | null }>();
  if (!existing) return new Response("Task not found", { status: 404 });

  const result = await env.DB.prepare(
    "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?"
  ).bind(status, now, id).run();
  if (result.meta.changes === 0) return new Response("Task not found", { status: 404 });

  if (status === "done") {
    const noteId = generateId();
    const assignee = existing.assigned_to ? ` (${existing.assigned_to})` : "";
    await env.DB.prepare(
      `INSERT INTO companion_journal (id, created_at, agent, note_text, tags)
       VALUES (?, ?, 'system', ?, ?)`
    ).bind(
      noteId,
      now,
      `✓ Task completed${assignee}: ${existing.title}`,
      JSON.stringify(["task-done"]),
    ).run();
  }

  return new Response(
    JSON.stringify({ ok: true, id, status }),
    { headers: { "Content-Type": "application/json" } },
  );
}
