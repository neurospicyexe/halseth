// src/mind/blocks/graph.ts
//
// Graph memory Phase 1.5, Tranche 4 (docs/private/graph-memory-spec-2026-08-28.md): the MindState
// `graph.neighborhoods` block. Orient gains a FIELD, not retrieval logic -- this module's whole job
// is calling src/graph/traverse.ts::neighborhood() with seeds the loader already holds and shaping
// the result for the contract. No new query shape, no raw `graph_edges` SQL here or anywhere outside
// src/graph/ -- that stays traverse.ts's job, including the 0126 sealed-lane refusal (hard law from
// the spec: "Surfacing must never increment the ranking that decides surfacing").
//
// SEEDING. `loadMindState`'s fan-out already fetches companion_conclusions (beliefs.conclusions) and
// companion_journal (relational.journal_recent) rows before this block runs -- seeded FROM those ids,
// never from a fresh retrieval, per the tranche instruction "do NOT add new retrieval". Two seed
// tables today; more can be added later by extending the seeds this module is CALLED with, not by
// adding a query inside it.
//
// SHAPE. TraverseEdge minus `node_heat`: this block renders structure (who links to what), not a
// ranking signal. `node_heat` exists for salience math (src/graph/salience.ts), which orient does not
// do -- the render-time renderer (neighborhoodBlock, orient-blocks.ts) groups and truncates on
// edge_type/writer/table, never on heat. Dropping it here keeps the contract from carrying a field no
// consumer reads and that would otherwise need its own null-vs-degraded story.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { neighborhood, type GraphSeed, type TraverseEdge } from "../../graph/traverse.js";

/** TraverseEdge minus `node_heat` -- see file header for why heat is dropped at the contract boundary. */
export interface GraphNeighborhoodEdge {
  src_table: string;
  src_id: string;
  dst_table: string;
  dst_id: string;
  edge_type: string;
  writer: string;
  created_at: string;
  hop: number;
}

export interface GraphBlocks {
  neighborhoods: GraphNeighborhoodEdge[];
}

export const EMPTY_GRAPH: GraphBlocks = { neighborhoods: [] };

function stripHeat(e: TraverseEdge): GraphNeighborhoodEdge {
  return {
    src_table: e.src_table,
    src_id: e.src_id,
    dst_table: e.dst_table,
    dst_id: e.dst_id,
    edge_type: e.edge_type,
    writer: e.writer,
    created_at: e.created_at,
    hop: e.hop,
  };
}

/**
 * `seeds` come from the caller (loader.ts), already assembled from ids the fan-out fetched for other
 * blocks -- this function issues no query beyond the bounded traverse itself. Empty seeds short-circuits
 * to EMPTY_GRAPH without touching the DB at all (a companion with no conclusions or journal rows yet
 * has no neighborhood to walk).
 */
export async function loadGraphBlocks(
  env: Env,
  companionId: WmAgentId,
  seeds: GraphSeed[],
): Promise<GraphBlocks> {
  if (seeds.length === 0) return EMPTY_GRAPH;
  try {
    const edges = await neighborhood(env, seeds, { hops: 1, limit: 30 });
    return { neighborhoods: edges.map(stripHeat) };
  } catch (err) {
    console.warn("[mind/graph] neighborhood load failed", { companionId, error: String(err) });
    return EMPTY_GRAPH;
  }
}
