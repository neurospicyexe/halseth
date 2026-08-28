// src/handlers/graph.ts
//
// POST /admin/graph/rebuild -- full, deterministic rebuild of the graph_edges projection (mig 0127,
// docs/private/graph-memory-spec-2026-08-28.md). Mirrors GET /admin/edges (src/handlers/edges.ts):
// admin-tier auth via authGuard, one JSON response, no side effects beyond the one table this
// endpoint owns. Safe to call repeatedly -- rebuildGraph deletes and re-derives every mechanical
// row each time, so a second call with unchanged source data returns the same counts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { rebuildGraph } from "../graph/rebuild.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function postGraphRebuild(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const counts = await rebuildGraph(env);
  return json({
    rebuilt_at: new Date().toISOString(),
    sources: counts,
  });
}
