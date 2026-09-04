// src/graph/render.ts
//
// Text render for graph neighborhoods consumed OUTSIDE orient (the Conversation Director). Same
// budget as orient-blocks.ts::neighborhoodBlock (6 lines x 90 chars) so the two surfaces stay
// comparable; kept separate on purpose -- orient's render is under byte-identity review and the
// director's needs degree + score, which orient never shows. Pure; no D1.

import type { TraverseEdge } from "./traverse.js";
import { connectivityMultiplier, nodeKey } from "./salience.js";

export const RENDER_MAX_LINES = 6;
export const RENDER_MAX_WIDTH = 90;

/** effectiveHeat x connectivityMultiplier(degree); null heat scores 0 (a node with no heat table never outranks one with). */
export function scoreNode(effectiveHeat: number | null, degree: number): number {
  if (effectiveHeat === null || !Number.isFinite(effectiveHeat)) return 0;
  return effectiveHeat * connectivityMultiplier(degree);
}

function label(table: string, id: string): string {
  return `${table.replace(/^companion_/, "")}/${id.slice(0, 8)}`;
}

export function renderEdgeLines(edges: TraverseEdge[], degrees: Map<string, number>, max = RENDER_MAX_LINES): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (out.length >= max) break;
    const deg = degrees.get(nodeKey(e.src_table, e.src_id)) ?? degrees.get(nodeKey(e.dst_table, e.dst_id)) ?? 0;
    const heat = e.node_heat === null ? "" : ` heat ${e.node_heat.toFixed(2)}`;
    const links = deg > 0 ? ` ${deg} links` : "";
    const line = `${e.edge_type}: ${label(e.src_table, e.src_id)} -> ${label(e.dst_table, e.dst_id)} (${e.writer}${heat}${links})`;
    out.push(line.length > RENDER_MAX_WIDTH ? line.slice(0, RENDER_MAX_WIDTH - 1) + "…" : line);
  }
  return out;
}
