// src/handlers/ingest.ts
//
// Read-only ingest endpoints for the Second Brain pull pipeline.
// GET /ingest/synthesis-summaries
// GET /ingest/inter-companion-notes
// GET /ingest/mind-handoffs
// GET /ingest/wounds
// GET /ingest/companion-dreams
// GET /ingest/open-loops
// GET /ingest/relational-state
// GET /ingest/tensions

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(raw: string | null): number {
  const n = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  return Math.min(Math.max(1, isNaN(n) ? DEFAULT_LIMIT : n), MAX_LIMIT);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /ingest/synthesis-summaries?since=<ISO8601>&limit=<n>
export async function getSynthesisSummaries(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, summary_type, subject, narrative, emotional_register,
             open_threads, drevan_state, created_at
      FROM synthesis_summary
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/synthesis-summaries] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/inter-companion-notes?since=<ISO8601>&limit=<n>
export async function getInterCompanionNotes(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, from_id, to_id, content, read_at, created_at
      FROM inter_companion_notes
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/inter-companion-notes] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/mind-handoffs?since=<ISO8601>&limit=<n>
export async function getMindHandoffs(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT handoff_id AS id, agent_id, thread_id, title, summary, next_steps, open_loops,
             state_hint, created_at
      FROM wm_session_handoffs
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/mind-handoffs] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/wounds?since=<ISO8601>&limit=<n>
export async function getIngestWounds(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, description, last_visited, last_surfaced_by, created_at
      FROM living_wounds
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/wounds] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/companion-dreams?since=<ISO8601>&limit=<n>
export async function getIngestCompanionDreams(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, dream_text, source, examined, examined_at, created_at
      FROM companion_dreams
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/companion-dreams] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/open-loops?since=<ISO8601>&limit=<n>
// Returns all loops (open and closed) for full history in Second Brain.
// opened_at is used as the canonical timestamp for HWM tracking.
export async function getIngestOpenLoops(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("opened_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, loop_text, weight, opened_at, closed_at
      FROM companion_open_loops
      ${where}
      ORDER BY opened_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/open-loops] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/relational-state?since=<ISO8601>&limit=<n>
// noted_at is used as the canonical timestamp for HWM tracking.
export async function getIngestRelationalState(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("noted_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, toward, state_text, weight, state_type, noted_at
      FROM companion_relational_state
      ${where}
      ORDER BY noted_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/relational-state] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/tensions?since=<ISO8601>&limit=<n>
// first_noted_at is used as the canonical timestamp for HWM tracking.
export async function getIngestTensions(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url   = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) {
    conditions.push("first_noted_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, tension_text, status, first_noted_at, last_surfaced_at, notes
      FROM companion_tensions
      ${where}
      ORDER BY first_noted_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/tensions] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/somatic-snapshots?since=<ISO8601>&companion_id=<id>&limit=<n>
export async function getIngestSomaticSnapshots(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url         = new URL(request.url);
  const since       = url.searchParams.get("since") ?? undefined;
  const companionId = url.searchParams.get("companion_id") ?? undefined;
  const limit       = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) { conditions.push("created_at > ?"); bindings.push(since); }
  if (companionId !== undefined) { conditions.push("companion_id = ?"); bindings.push(companionId); }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, snapshot, model_used, stale_after, created_at
      FROM somatic_snapshot
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/somatic-snapshots] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/drift-log?since=<ISO8601>&companion_id=<id>&limit=<n>
export async function getIngestDriftLog(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url         = new URL(request.url);
  const since       = url.searchParams.get("since") ?? undefined;
  const companionId = url.searchParams.get("companion_id") ?? undefined;
  const limit       = clampLimit(url.searchParams.get("limit"));

  if (since !== undefined && isNaN(Date.parse(since))) {
    return json({ error: "invalid since parameter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (since !== undefined) { conditions.push("detected_at > ?"); bindings.push(since); }
  if (companionId !== undefined) { conditions.push("companion_id = ?"); bindings.push(companionId); }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, signal_type, context, detected_at
      FROM drift_log
      ${where}
      ORDER BY detected_at ${orderDir}
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/drift-log] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/live-threads?companion_id=<id>&status=<active|all>&limit=<n>
export async function getIngestLiveThreads(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url         = new URL(request.url);
  const companionId = url.searchParams.get("companion_id") ?? undefined;
  const status      = url.searchParams.get("status") ?? "active";
  const limit       = clampLimit(url.searchParams.get("limit"));

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId !== undefined) { conditions.push("companion_id = ?"); bindings.push(companionId); }
  if (status !== "all") { conditions.push("status = ?"); bindings.push(status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, name, flavor, charge, status, active_since_count, notes, created_at, closed_at
      FROM live_threads
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/live-threads] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /ingest/basin-history?companion_id=<id>&limit=<n>
export async function getIngestBasinHistory(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url         = new URL(request.url);
  const companionId = url.searchParams.get("companion_id") ?? undefined;
  const limit       = clampLimit(url.searchParams.get("limit"));

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId !== undefined) { conditions.push("companion_id = ?"); bindings.push(companionId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(`
      SELECT id, companion_id, drift_score, drift_type, caleth_confirmed, worst_basin, notes, recorded_at
      FROM companion_basin_history
      ${where}
      ORDER BY recorded_at DESC
      LIMIT ?
    `).bind(...bindings).all();

    return json(result.results ?? []);
  } catch (err) {
    console.error("[ingest/basin-history] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
