// src/handlers/graph.ts
//
// POST /admin/graph/rebuild -- full, deterministic rebuild of the graph_edges projection (mig 0127,
// docs/private/graph-memory-spec-2026-08-28.md). Mirrors GET /admin/edges (src/handlers/edges.ts):
// admin-tier auth via authGuard, one JSON response, no side effects beyond the one table this
// endpoint owns. Safe to call repeatedly -- rebuildGraph deletes and re-derives every mechanical
// row each time, so a second call with unchanged source data returns the same counts.
//
// GET /admin/graph/health -- the OUTSIDE-half readout (2026-08-28, standing health check extension).
// The VPS health-check script (nullsafe-discord/ops/health-check.py) cannot see D1 directly -- it is
// a Cloudflare-only store -- so any check it runs against graph_edges has to go through an endpoint.
// Three numbers, one query each, no interpretation here (severity/thresholds are the script's job,
// not this one's -- same split as /admin/health's `checks[]` shape):
//   * last_rebuild_at -- the nightly tick's own gate stamp (src/graph/tick.ts), so staleness of the
//     tick is visible from outside the Worker.
//   * live_count      -- rows in the 'live' provenance lane (write-time-only, e.g. resumed_from,
//     src/graph/live.ts). This lane is NEVER touched by rebuildGraph's mechanical-only DELETE, so a
//     drop here means something else deleted rows a rebuild should never be able to touch.
//   * total_count     -- whole-table count, to catch a rebuild wipe or regression the mechanical
//     DELETE+re-derive should never produce but a bug could.
// M7 (2026-10-28) adds two readouts, still raw (thresholds stay the script's job):
//   * rebuild_counts  -- the last two completed runs' per-source counts and diff
//     (src/graph/tick.ts), so a lane that went from N to 0 is visible as a DEAD LANE even while
//     the total holds steady.
//   * reach           -- per companion, what the last orient actually rendered from the graph
//     (src/graph/reach.ts). Freshness is not reach: the 10-27 audit found a fresh 50k-edge graph
//     that reached almost nothing.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { GRAPH_REBUILD_GATE_COMPANION_ID, GRAPH_REBUILD_GATE_KEY, readGraphRebuildCounts, runGraphRebuildTick } from "../graph/tick.js";
import { readGraphReach } from "../graph/reach.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function postGraphRebuild(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  // Through the tick's single-flight lease (2026-10-10), never rebuildGraph directly: a manual run
  // racing the minute cron is the same overlap that left the graph ragged (51269 -> 42130).
  const r = await runGraphRebuildTick(env, { force: true });
  if (!r.ran) return json({ error: "a rebuild is already running -- nothing started; retry after it finishes" }, 409);
  return json({
    rebuilt_at: new Date().toISOString(),
    sources: r.sources,
    diff: r.diff,
    ms: r.ms,
  });
}

export async function getGraphHealth(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const gate = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?"
  ).bind(GRAPH_REBUILD_GATE_COMPANION_ID, GRAPH_REBUILD_GATE_KEY).first<{ value: string }>();

  const liveRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM graph_edges WHERE provenance = 'live'"
  ).first<{ n: number }>();

  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM graph_edges"
  ).first<{ n: number }>();

  const [rebuildCounts, reach] = await Promise.all([
    readGraphRebuildCounts(env).catch(() => null),
    readGraphReach(env).catch(() => ({})),
  ]);

  return json({
    last_rebuild_at: gate?.value ?? null,
    live_count: Number(liveRow?.n ?? 0),
    total_count: Number(totalRow?.n ?? 0),
    rebuild_counts: rebuildCounts,
    reach,
  });
}
