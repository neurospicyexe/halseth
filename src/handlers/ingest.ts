// src/handlers/ingest.ts
//
// Read-only ingest endpoints for the Second Brain pull pipeline.
// GET /ingest/synthesis-summaries
// GET /ingest/inter-companion-notes
// GET /ingest/mind-handoffs

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
      SELECT id, companion_id, summary_type, content, thread_key, created_at
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
      SELECT id, from_id, to_id, note_text, tags, created_at
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
      SELECT id, agent_id, session_id, handoff_text, key_threads, mood_snapshot, created_at
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
