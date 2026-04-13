// Read-only session endpoints.
// GET /sessions?days=7&limit=100               — sessions from the last N days
// GET /sessions/:id                             — single session by id
// GET /sessions/recent-relational               — recent hangout/checkin sessions + note coverage
//
// These are pure SELECT queries. No schema changes, no data modification.
// Added 2026-03-13 to support nullsafe-second-brain synthesis tools.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /sessions/recent-relational?companion_id=X&hours=N
// Returns recently closed hangout/checkin sessions for a companion and whether each has
// companion notes. Uses updated_at as the close-time proxy (sessions has no closed_at column).
// companion_id maps to sessions.companion_id; note coverage joins companion_journal.agent.
export async function getRecentRelationalSessions(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const companionId = url.searchParams.get("companion_id");
  const rawHours = parseInt(url.searchParams.get("hours") ?? "4", 10);
  const hours = isNaN(rawHours) || rawHours < 1 ? 4 : Math.min(rawHours, 24);

  const validCompanions = ["drevan", "cypher", "gaia"];
  if (!companionId || !validCompanions.includes(companionId)) {
    return new Response(
      JSON.stringify({ error: "companion_id must be drevan, cypher, or gaia" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // updated_at is used as the close-time proxy; sessions has no closed_at column.
  // Only return sessions that have actually been updated (closed) in the window AND
  // were created before updated_at (i.e. not a same-second no-op open).
  // companion_journal uses `agent` column, not companion_id.
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(`
    SELECT
      s.id,
      s.session_type,
      s.front_state,
      s.emotional_frequency,
      s.notes,
      s.updated_at,
      s.created_at,
      CASE WHEN cn.note_count > 0 THEN 1 ELSE 0 END AS has_notes
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS note_count
      FROM companion_journal
      WHERE session_id IS NOT NULL
        AND agent = ?
      GROUP BY session_id
    ) cn ON cn.session_id = s.id
    WHERE s.companion_id = ?
      AND s.session_type IN ('hangout', 'checkin')
      AND s.updated_at >= ?
      AND s.updated_at != s.created_at
    ORDER BY s.updated_at DESC
    LIMIT 10
  `).bind(companionId, companionId, cutoff).all<{
    id: string;
    session_type: string;
    front_state: string | null;
    emotional_frequency: string | null;
    notes: string | null;
    updated_at: string;
    created_at: string;
    has_notes: number;
  }>();

  return new Response(
    JSON.stringify({ sessions: result.results ?? [] }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// GET /sessions?days=7&limit=100[&companion_id=drevan]
// Returns sessions created within the last N days, newest first.
// When companion_id is provided, query uses idx_sessions_companion_created(companion_id, created_at DESC)
// -- a composite covering scan. Without it, falls back to idx_sessions_created(created_at DESC)
// plus rowid lookups for each result row.
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
  const companionId = url.searchParams.get("companion_id");
  const validCompanions = ["drevan", "cypher", "gaia"];
  const scopedCompanion = companionId && validCompanions.includes(companionId) ? companionId : null;

  let sql = `
    SELECT s.id, s.created_at, s.updated_at, s.front_state, s.co_con,
           s.emotional_frequency, s.active_anchor, s.facet, s.notes,
           s.companion_id, s.session_type, s.spine,
           h.last_real_thing, h.motion_state
    FROM sessions s
    LEFT JOIN handover_packets h ON h.session_id = s.id
    WHERE s.created_at >= datetime('now', ? || ' days')
  `;
  const bindings: unknown[] = [`-${days}`];
  if (scopedCompanion) {
    sql += " AND s.companion_id = ?";
    bindings.push(scopedCompanion);
  }
  sql += " ORDER BY s.created_at DESC LIMIT ?";
  bindings.push(limit);

  const result = await env.DB.prepare(sql).bind(...bindings).all<Record<string, unknown>>();

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
    SELECT s.id, s.created_at, s.updated_at, s.front_state, s.co_con,
           s.emotional_frequency, s.active_anchor, s.facet, s.notes,
           s.companion_id, s.session_type, s.spine,
           h.last_real_thing, h.motion_state
    FROM sessions s
    LEFT JOIN handover_packets h ON h.session_id = s.id
    WHERE s.id = ?
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
