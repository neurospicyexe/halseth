// Read-only session endpoints.
// GET /sessions?days=7&limit=100  — sessions from the last N days
// GET /sessions/:id               — single session by id
//
// These are pure SELECT queries. No schema changes, no data modification.
// Added 2026-03-13 to support nullsafe-second-brain synthesis tools.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /sessions?days=7&limit=100
// Returns sessions created within the last N days, newest first.
export async function getSessions(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = isNaN(rawDays) || rawDays < 1 ? 7 : Math.min(rawDays, 365);
  const limit = clampLimit(url.searchParams.get("limit"), 100, 200);

  const result = await env.DB.prepare(`
    SELECT id, created_at, updated_at, front_state, co_con,
           emotional_frequency, active_anchor, facet, notes
    FROM sessions
    WHERE created_at >= datetime('now', ? || ' days')
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(`-${days}`, limit).all<Record<string, unknown>>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /sessions/:id
// Returns a single session by id, or 404 if not found.
export async function getSessionById(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing session id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const row = await env.DB.prepare(`
    SELECT id, created_at, updated_at, front_state, co_con,
           emotional_frequency, active_anchor, facet, notes
    FROM sessions
    WHERE id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!row) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(row), {
    headers: { "Content-Type": "application/json" },
  });
}
