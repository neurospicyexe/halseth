// src/graph/reach.ts
//
// Graph reach (M7, docs/PLAN-memory-map-2026-10-28.md). The 10-27 audit found the graph machinery
// healthy by every number /admin/graph/health reported (fresh rebuild, 50k edges) while almost
// nothing reached a companion: the orient neighborhood rendered Fargo and little else. Freshness
// is not reach. This records, per companion, what the last orient actually RENDERED from the graph,
// so the VPS health check can alarm on zero reach instead of inferring health from row counts.
//
// Storage: one companion_settings row per companion under the '_system' sentinel (the same KV table
// and sentinel the rebuild gate uses, src/graph/tick.ts), key 'graph_reach:<companion>'. No
// migration. The value is a small JSON record; zero_streak counts consecutive orients that rendered
// nothing, so one empty boot (a brand-new companion state, a transient traverse failure) is not an
// alarm but three in a row is.
//
// Best-effort by construction: a failed write logs and returns. A boot never fails over telemetry.

import type { Env } from "../types.js";

export const GRAPH_REACH_COMPANION_ID = "_system";
/** An unchanged reading inside this window is not re-recorded. The Discord bots re-orient every 5
 *  minutes (SOMA_REFRESH_INTERVAL_MS), so without it the record is rewritten ~860 times a day and the
 *  zero streak counts refreshes: three empty ones would be fifteen minutes, not three boots. With it,
 *  the streak counts at most one empty reading per hour per surface. A CHANGED reading always records. */
export const GRAPH_REACH_RECORD_MIN_MS = 60 * 60 * 1000;
/** Claude.ai orient records under the bare companion id; another surface appends `@<surface>`
 *  ("cypher@discord"), so one surface's frequent boots never overwrite another's reading. */
export const graphReachKey = (companionId: string, surface?: string) =>
  `graph_reach:${companionId}${surface ? `@${surface}` : ""}`;

export interface GraphReachRecord {
  at: string;
  edges: number;
  nodes: number;
  rendered: boolean;
  zero_streak: number;
  last_nonzero_at: string | null;
}

interface ReachEdge { src_table: string; src_id: string; dst_table: string; dst_id: string }

export function summarizeReach(edges: readonly ReachEdge[], renderedText: string): { edges: number; nodes: number; rendered: boolean } {
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(`${e.src_table}:${e.src_id}`);
    nodes.add(`${e.dst_table}:${e.dst_id}`);
  }
  return { edges: edges.length, nodes: nodes.size, rendered: renderedText.trim().length > 0 };
}

export function nextReachRecord(prev: GraphReachRecord | null, now: { edges: number; nodes: number; rendered: boolean }, at: string): GraphReachRecord {
  const reached = now.rendered && now.edges > 0;
  return {
    at,
    ...now,
    zero_streak: reached ? 0 : (prev?.zero_streak ?? 0) + 1,
    last_nonzero_at: reached ? at : (prev?.last_nonzero_at ?? null),
  };
}

function parseRecord(value: string | null | undefined): GraphReachRecord | null {
  if (!value) return null;
  try {
    const r = JSON.parse(value) as GraphReachRecord;
    return typeof r === "object" && r !== null ? r : null;
  } catch { return null; }
}

export async function recordGraphReach(
  env: Env,
  companionId: string,
  edges: readonly ReachEdge[],
  renderedText: string,
  surface?: string,
): Promise<void> {
  try {
    const key = graphReachKey(companionId, surface);
    const row = await env.DB.prepare(
      "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?",
    ).bind(GRAPH_REACH_COMPANION_ID, key).first<{ value: string }>();
    const prev = parseRecord(row?.value);
    const now = summarizeReach(edges, renderedText);
    if (prev && prev.edges === now.edges && prev.nodes === now.nodes && prev.rendered === now.rendered
        && Date.now() - Date.parse(prev.at) < GRAPH_REACH_RECORD_MIN_MS) return;
    const next = nextReachRecord(prev, now, new Date().toISOString());
    await env.DB.prepare(
      `INSERT INTO companion_settings (companion_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(GRAPH_REACH_COMPANION_ID, key, JSON.stringify(next)).run();
  } catch (err) {
    console.warn("[graph-reach] record failed", { companionId, error: String(err) });
  }
}

/** Every companion's last reach record, keyed by companion id (absent = never recorded). */
export async function readGraphReach(env: Env): Promise<Record<string, GraphReachRecord>> {
  const res = await env.DB.prepare(
    "SELECT key, value FROM companion_settings WHERE companion_id = ? AND key LIKE 'graph_reach:%'",
  ).bind(GRAPH_REACH_COMPANION_ID).all<{ key: string; value: string }>();
  const out: Record<string, GraphReachRecord> = {};
  for (const r of res.results ?? []) {
    const rec = parseRecord(r.value);
    if (rec) out[r.key.slice("graph_reach:".length)] = rec;
  }
  return out;
}
