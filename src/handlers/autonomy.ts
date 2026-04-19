// src/handlers/autonomy.ts
//
// HTTP route handlers for /mind/autonomy/* endpoints.
// Execution tracking for the autonomous worker: runs, seeds, logs, reflections.
// All routes require ADMIN_SECRET Bearer auth (enforced at index.ts level).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
const MAX_TEXT = 8000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateCompanion(id: unknown): id is string {
  return typeof id === "string" && VALID_COMPANIONS.has(id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// POST /mind/autonomy/runs
export async function postAutonomyRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.run_type !== "string" || !body.run_type.trim()) return json({ error: "run_type required" }, 400);

  const valid_types = new Set(["exploration", "reflection", "synthesis", "continuation"]);
  if (!valid_types.has(body.run_type as string)) return json({ error: "run_type must be exploration, reflection, synthesis, or continuation" }, 400);

  const thread_id = typeof body.thread_id === "string" && body.thread_id.trim() ? body.thread_id.trim() : null;
  const thread_position = typeof body.thread_position === "number" ? Math.max(1, body.thread_position) : null;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO autonomy_runs (id, companion_id, run_type, status, thread_id, thread_position) VALUES (?, ?, ?, 'running', ?, ?)"
  ).bind(id, body.companion_id, body.run_type, thread_id, thread_position).run();

  return json({ id, message: "ok" }, 201);
}

// PATCH /mind/autonomy/runs/:id
export async function patchAutonomyRun(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const body = await request.json() as Record<string, unknown>;
  const fields: string[] = [];
  const bindings: unknown[] = [];

  const valid_statuses = new Set(["pending", "running", "completed", "failed"]);
  if (body.status !== undefined) {
    if (!valid_statuses.has(body.status as string)) return json({ error: "invalid status" }, 400);
    fields.push("status = ?");
    bindings.push(body.status);
  }
  if (body.completed_at !== undefined) { fields.push("completed_at = ?"); bindings.push(body.completed_at); }
  if (body.tokens_used !== undefined) { fields.push("tokens_used = ?"); bindings.push(body.tokens_used); }
  if (body.artifacts_created !== undefined) { fields.push("artifacts_created = ?"); bindings.push(body.artifacts_created); }
  if (body.error_message !== undefined) { fields.push("error_message = ?"); bindings.push(body.error_message); }
  if (body.thread_id !== undefined) { fields.push("thread_id = ?"); bindings.push(body.thread_id ?? null); }
  if (body.thread_position !== undefined) { fields.push("thread_position = ?"); bindings.push(body.thread_position ?? null); }

  if (fields.length === 0) return json({ error: "no fields to update" }, 400);
  bindings.push(id);

  const result = await env.DB.prepare(
    `UPDATE autonomy_runs SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...bindings).run();

  if (result.meta.changes === 0) return json({ error: "not found" }, 404);
  return json({ message: "ok" });
}

// GET /mind/autonomy/runs/:companion_id
export async function getAutonomyRuns(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 50);

  const rows = await env.DB.prepare(
    "SELECT * FROM autonomy_runs WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companion_id, limit).all();

  return json({ runs: rows.results });
}

// ---------------------------------------------------------------------------
// Run logs
// ---------------------------------------------------------------------------

// POST /mind/autonomy/run-logs
export async function postAutonomyRunLog(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (typeof body.run_id !== "string" || !body.run_id.trim()) return json({ error: "run_id required" }, 400);
  if (typeof body.step !== "string" || !body.step.trim()) return json({ error: "step required" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO autonomy_run_logs (id, run_id, step, detail) VALUES (?, ?, ?, ?)"
  ).bind(id, body.run_id, body.step, body.detail ?? null).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/autonomy/run-logs/:run_id
export async function getAutonomyRunLogs(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { run_id } = params;
  if (!run_id) return json({ error: "run_id required" }, 400);

  const rows = await env.DB.prepare(
    "SELECT * FROM autonomy_run_logs WHERE run_id = ? ORDER BY created_at ASC"
  ).bind(run_id).all();

  return json({ logs: rows.results });
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// POST /mind/autonomy/seeds
export async function postAutonomySeed(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.content !== "string" || !body.content.trim()) return json({ error: "content required" }, 400);
  if (body.content.toString().length > MAX_TEXT) return json({ error: `content too long (max ${MAX_TEXT})` }, 400);

  const valid_seed_types = new Set(["topic", "question", "reflection_prompt"]);
  const seed_type = typeof body.seed_type === "string" && valid_seed_types.has(body.seed_type)
    ? body.seed_type
    : "topic";

  const claim_source = typeof body.claim_source === "string" && body.claim_source.trim()
    ? body.claim_source.trim()
    : null;
  const justification = typeof body.justification === "string" && body.justification.trim()
    ? body.justification.trim()
    : null;

  if (claim_source && !justification) return json({ error: "justification required when claim_source is set" }, 400);

  // Claims float above all queue seeds regardless of what priority was passed in
  const priority = claim_source
    ? 10
    : typeof body.priority === "number" ? Math.max(1, Math.min(9, body.priority)) : 5;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO autonomy_seeds (id, companion_id, seed_type, content, priority, claim_source, justification) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, body.companion_id, seed_type, body.content, priority, claim_source, justification).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/autonomy/seeds/:companion_id  -- unused seeds, priority desc
export async function getAutonomySeeds(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "5", 10), 20);

  const rows = await env.DB.prepare(
    "SELECT * FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at ASC LIMIT ?"
  ).bind(companion_id, limit).all();

  return json({ seeds: rows.results });
}

// PATCH /mind/autonomy/seeds/:id  -- mark used
export async function patchAutonomySeed(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const result = await env.DB.prepare(
    "UPDATE autonomy_seeds SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL"
  ).bind(id).run();

  if (result.meta.changes === 0) return json({ error: "not found or already used" }, 404);
  return json({ message: "ok" });
}

// ---------------------------------------------------------------------------
// Reflections
// ---------------------------------------------------------------------------

// POST /mind/autonomy/reflections
export async function postAutonomyReflection(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.reflection_text !== "string" || !body.reflection_text.trim()) return json({ error: "reflection_text required" }, 400);
  if (body.reflection_text.toString().length > MAX_TEXT) return json({ error: `reflection_text too long (max ${MAX_TEXT})` }, 400);

  const id = crypto.randomUUID();
  const newSeedsRaw = body.new_seeds_json ?? null;
  const newSeedsJson = newSeedsRaw ? JSON.stringify(newSeedsRaw) : null;

  await env.DB.prepare(
    "INSERT INTO autonomy_reflections (id, companion_id, run_id, reflection_text, new_seeds_json) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    id,
    body.companion_id,
    body.run_id ?? null,
    body.reflection_text,
    newSeedsJson,
  ).run();

  // Auto-promote new_seeds_json into autonomy_seeds so the next run has fresh material.
  // Handles both string[] and { content, seed_type?, priority? }[] formats.
  if (Array.isArray(newSeedsRaw) && newSeedsRaw.length > 0) {
    const valid_seed_types = new Set(["topic", "question", "reflection_prompt"]);
    const inserts: Promise<unknown>[] = [];
    for (const raw of newSeedsRaw as unknown[]) {
      let content: string | null = null;
      let seed_type = "reflection_prompt";
      let priority = 6; // slightly above default -- reflection-generated seeds are targeted

      if (typeof raw === "string" && raw.trim()) {
        content = raw.trim().slice(0, MAX_TEXT);
      } else if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.content === "string" && obj.content.trim()) {
          content = obj.content.trim().slice(0, MAX_TEXT);
          if (typeof obj.seed_type === "string" && valid_seed_types.has(obj.seed_type)) {
            seed_type = obj.seed_type;
          }
          if (typeof obj.priority === "number") {
            priority = Math.max(1, Math.min(10, obj.priority));
          }
        }
      }

      if (content) {
        const sid = crypto.randomUUID();
        inserts.push(
          env.DB.prepare(
            "INSERT INTO autonomy_seeds (id, companion_id, seed_type, content, priority) VALUES (?, ?, ?, ?, ?)"
          ).bind(sid, body.companion_id, seed_type, content, priority).run()
        );
      }
    }
    if (inserts.length > 0) {
      const settled = await Promise.allSettled(inserts);
      const promoted = settled.filter(r => r.status === "fulfilled").length;
      return json({ id, seeds_promoted: promoted, message: "ok" }, 201);
    }
  }

  return json({ id, seeds_promoted: 0, message: "ok" }, 201);
}

// GET /mind/autonomy/threads/:companion_id
// Returns active/paused wm_threads (lane='growth') with last run context.
export async function getAutonomyThreads(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const threads = await env.DB.prepare(`
    SELECT
      t.thread_key,
      t.title,
      t.status,
      t.created_at,
      t.updated_at,
      r.thread_position  AS last_position,
      r.run_type         AS last_run_type,
      r.created_at       AS last_run_at,
      j.content          AS last_entry_snippet
    FROM wm_mind_threads t
    LEFT JOIN autonomy_runs r
      ON r.thread_id = t.thread_key
      AND r.created_at = (
        SELECT MAX(r2.created_at) FROM autonomy_runs r2 WHERE r2.thread_id = t.thread_key
      )
    LEFT JOIN growth_journal j
      ON j.thread_id = t.thread_key
      AND j.created_at = (
        SELECT MAX(j2.created_at) FROM growth_journal j2 WHERE j2.thread_id = t.thread_key
      )
    WHERE t.agent_id = ? AND t.lane = 'growth' AND t.status IN ('open', 'paused')
    ORDER BY t.updated_at DESC
    LIMIT 10
  `).bind(companion_id).all<Record<string, unknown>>();

  const results = (threads.results ?? []).map(row => ({
    ...row,
    last_entry_snippet: typeof row.last_entry_snippet === "string"
      ? row.last_entry_snippet.slice(0, 200)
      : null,
  }));

  return json({ threads: results });
}

// GET /mind/autonomy/reflections/:companion_id
export async function getAutonomyReflections(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10), 50);

  const rows = await env.DB.prepare(
    "SELECT * FROM autonomy_reflections WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companion_id, limit).all();

  return json({ reflections: rows.results });
}
