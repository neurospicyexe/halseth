import { Env, RelationalDeltaV4 } from "../types.js";

// GET /deltas?limit=N — returns cross-companion relational deltas (spec v0.4 rows only).
// v0.4 rows are identified by delta_text IS NOT NULL.
// Returns newest first.
export async function getAllDeltas(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200);

  const result = await env.DB.prepare(`
    SELECT id, session_id, created_at, agent, delta_text, valence, initiated_by
    FROM relational_deltas
    WHERE delta_text IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<RelationalDeltaV4>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
