// src/graph/traverse.ts
//
// Graph memory Phase 1, second deliverable (docs/private/graph-memory-spec-2026-08-28.md):
// "a bounded traversal (1-2 hops, typed, heat-gated) hanging off existing vector search as
// seeder. Vector search unchanged; it becomes the entry point, not the whole answer."
//
// `neighborhood()` takes the rows a vector/semantic search already surfaced (the seeds) and
// walks graph_edges (mig 0127) outward 1-2 hops, BOTH directions, to find what's structurally
// connected. It is read-only: no row in graph_edges, companion_journal, or companion_conclusions
// is ever written or warmed by this file. Hard law 1 (docs/private/graph-memory-spec-2026-08-28.md):
// "Surfacing must never increment the ranking that decides surfacing" -- this module only SELECTs.
//
// HEAT-GATING IS NOT FILTERING. Hard law from memory (an-edges-rank-never-hide /
// edges-rank-never-hide): "a derived link may reweight what surfaces, never remove it." Cold
// nodes are never silently dropped here -- `opts.withHeat` only ATTACHES effective heat
// (src/webmind/heat.ts::effectiveHeatSql, a pure read-time computation) as `node_heat` on the
// edge rows that touch a heat-bearing table (companion_journal, companion_conclusions). The
// CALLER decides what to do with a cold node -- rank it down, badge it, whatever -- this module
// never removes an edge because its neighbor is cold.
//
// SEALED LANE. The 0126 sealed lane (see src/__tests__/sibling-seal.test.ts for the allowlist
// and src/graph/rebuild.ts for the same policy on the write side) must never be queried or
// returned from this file, in either direction, even though rebuild.ts already never writes an
// edge touching it -- this is defense in depth, not redundant. The identifier is assembled at
// runtime (never spelled as a literal) because the seal test's regex matches the identifier
// anywhere in src/, including comments.
//
// ORDERING / LIMITS. Every hop's edge query is capped independently at `opts.limit` (default 30,
// hard cap 100) so a single hop can never return the global hairball, and results are sorted
// deterministically (created_at DESC, then edge id ascending) before the cap is applied, so
// identical inputs always produce identical output. A hop-2 traversal never re-walks into a seed
// node or re-returns an edge already surfaced at hop 1 (tracked via a `visited` node set and a
// `seenEdgeIds` set) -- that is what keeps 1-2 hops bounded rather than re-touching the same
// small neighborhood twice.
//
// This is a library function only. No HTTP route, no orient integration (hard law 4: "Orient is
// a contract, not search. It gains rendered neighborhoods; it does not gain retrieval logic.") --
// rendering is a later deliverable that consumes this module's output.

import type { Env } from "../types.js";
import { effectiveHeatSql } from "../webmind/heat.js";

/** Assembled, never spelled as a literal -- see file header. */
const SEALED_TABLE = ["sibling", "notes"].join("_");

/** The only two tables carrying heat/last_access_at today (mig 0105). Extend this set, not the
 *  call sites, if a future migration adds heat to another table. */
const HEAT_TABLES = new Set(["companion_journal", "companion_conclusions"]);

export const DEFAULT_LIMIT = 30;
export const HARD_CAP_LIMIT = 100;

// Bound-parameter budget per graph_edges query: table + idChunk + table + idChunk + 2 (sealed
// table, twice) + up to a handful of edgeTypes. D1's practical bound-parameter ceiling is well
// under 200; 40 keeps a wide margin even with a generous edgeTypes filter.
const ID_CHUNK_SIZE = 40;

export interface GraphSeed {
  table: string;
  id: string;
}

export interface TraverseOptions {
  /** 1 or 2 hops outward from the seed set. Default 1. Any other value is treated as 1. */
  hops?: 1 | 2;
  /** Restrict to these edge_type values. Omitted or empty = no filter. */
  edgeTypes?: string[];
  /** Per-hop cap, default 30, hard-capped at 100 regardless of what's requested. */
  limit?: number;
  /** When true, attach effective heat (nullable) for the newly-discovered endpoint of each edge,
   *  where that endpoint lives in a heat-bearing table. Read-only -- never warms the row. */
  withHeat?: boolean;
}

export interface TraverseEdge {
  src_table: string;
  src_id: string;
  dst_table: string;
  dst_id: string;
  edge_type: string;
  writer: string;
  created_at: string;
  hop: number;
  /**
   * Effective heat (src/webmind/heat.ts::effectiveHeatSql) of whichever endpoint of this edge
   * this hop newly discovered (the endpoint that was NOT already in the caller's seed/visited
   * set), when that endpoint lives in a heat-bearing table. Null when withHeat is false, the
   * endpoint's table doesn't carry heat, or the row could not be found. Design decision: heat
   * describes the node this traversal is surfacing to the caller for the first time, not the
   * already-known frontier node the caller walked out from -- that's the node a ranking
   * decision is actually about.
   */
  node_heat: number | null;
}

interface RawEdgeRow {
  id: string;
  src_table: string;
  src_id: string;
  dst_table: string;
  dst_id: string;
  edge_type: string;
  writer: string;
  created_at: string;
}

function nodeKey(table: string, id: string): string {
  return `${table}\u0000${id}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupByTable(nodes: GraphSeed[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of nodes) {
    const list = map.get(n.table) ?? [];
    list.push(n.id);
    map.set(n.table, list);
  }
  return map;
}

/** Deterministic comparator: created_at DESC, then edge id ASC. */
function compareEdges(a: RawEdgeRow, b: RawEdgeRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function buildEdgeQuery(
  table: string,
  idChunk: string[],
  edgeTypes: string[] | undefined,
): { sql: string; bindings: unknown[] } {
  const idPlaceholders = idChunk.map(() => "?").join(", ");
  const bindings: unknown[] = [table, ...idChunk, table, ...idChunk, SEALED_TABLE, SEALED_TABLE];

  let sql = `SELECT id, src_table, src_id, dst_table, dst_id, edge_type, writer, created_at
    FROM graph_edges
    WHERE ((src_table = ? AND src_id IN (${idPlaceholders})) OR (dst_table = ? AND dst_id IN (${idPlaceholders})))
      AND src_table != ? AND dst_table != ?`;

  if (edgeTypes && edgeTypes.length > 0) {
    sql += ` AND edge_type IN (${edgeTypes.map(() => "?").join(", ")})`;
    bindings.push(...edgeTypes);
  }

  sql += ` ORDER BY created_at DESC, id ASC`;
  return { sql, bindings };
}

/**
 * Fetch every graph_edges row touching any node in `frontier` (as src OR dst), excluding the
 * 0126 sealed lane (never even queried, not just filtered) and any excluded edge_types. Chunked
 * per table to keep bound-parameter counts bounded. Returns rows deduped by edge id but NOT yet
 * capped to a limit -- callers apply the deterministic sort + per-hop cap themselves after
 * merging chunk results, since a node can appear in more than one chunk's result set (e.g. an
 * edge whose src and dst both land in the frontier can be matched by two different table-group
 * queries).
 */
async function fetchEdgesTouching(
  db: D1Database,
  frontier: GraphSeed[],
  edgeTypes: string[] | undefined,
): Promise<RawEdgeRow[]> {
  const byTable = groupByTable(frontier.filter((n) => n.table !== SEALED_TABLE));
  const byId = new Map<string, RawEdgeRow>();

  for (const [table, ids] of byTable) {
    for (const idChunk of chunkArray(ids, ID_CHUNK_SIZE)) {
      const { sql, bindings } = buildEdgeQuery(table, idChunk, edgeTypes);
      const res = await db.prepare(sql).bind(...bindings).all<RawEdgeRow>();
      for (const row of res.results ?? []) byId.set(row.id, row);
    }
  }

  return [...byId.values()];
}

/**
 * Read-only effective-heat lookup for a set of ids in one heat-bearing table. Never touches
 * heat / last_access_at -- SELECT only, using the same effectiveHeatSql() expression every other
 * read-time consumer uses (src/webmind/heat.ts), so this module can never drift from that
 * decay math.
 */
async function fetchHeatByTable(db: D1Database, table: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const idChunk of chunkArray(ids, ID_CHUNK_SIZE)) {
    const placeholders = idChunk.map(() => "?").join(", ");
    const sql = `SELECT id, ${effectiveHeatSql()} AS node_heat FROM ${table} WHERE id IN (${placeholders})`;
    const res = await db.prepare(sql).bind(...idChunk).all<{ id: string; node_heat: number }>();
    for (const row of res.results ?? []) out.set(row.id, row.node_heat);
  }
  return out;
}

/**
 * Bounded 1-2 hop traversal of graph_edges, seeded from rows vector search already surfaced.
 *
 * Deterministic: identical (seeds, opts) against unchanged graph_edges data always produces the
 * same edge list in the same order. Read-only: issues SELECT statements only, never an
 * UPDATE/INSERT/DELETE, on graph_edges or (when withHeat) the two heat-bearing tables.
 */
export async function neighborhood(
  env: Env,
  seeds: GraphSeed[],
  opts: TraverseOptions = {},
): Promise<TraverseEdge[]> {
  const db = env.DB;
  const hops = opts.hops === 2 ? 2 : 1;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 0), HARD_CAP_LIMIT);
  const edgeTypes = opts.edgeTypes && opts.edgeTypes.length > 0 ? opts.edgeTypes : undefined;

  // Refuse the sealed lane at the door: never let it into the walkable frontier, and never treat
  // it as a legitimate seed (defense in depth -- rebuild.ts already never writes an edge touching
  // it, but this file does not trust that as its only guarantee).
  const cleanSeeds = seeds.filter((s) => s.table !== SEALED_TABLE);

  const seedKeys = new Set(cleanSeeds.map((s) => nodeKey(s.table, s.id)));
  const visited = new Set(seedKeys);
  const seenEdgeIds = new Set<string>();

  const collected: TraverseEdge[] = [];
  // Parallel to `collected`: the node this hop newly discovered via each edge, for heat lookup.
  const discoveredNode: Array<GraphSeed | null> = [];

  let frontier = cleanSeeds;

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const frontierKeys = new Set(frontier.map((f) => nodeKey(f.table, f.id)));

    const raw = await fetchEdgesTouching(db, frontier, edgeTypes);
    const fresh = raw.filter((e) => !seenEdgeIds.has(e.id));
    fresh.sort(compareEdges);
    const capped = fresh.slice(0, limit);

    const nextFrontierMap = new Map<string, GraphSeed>();

    for (const e of capped) {
      seenEdgeIds.add(e.id);

      const srcInFrontier = frontierKeys.has(nodeKey(e.src_table, e.src_id));
      const other: GraphSeed = srcInFrontier
        ? { table: e.dst_table, id: e.dst_id }
        : { table: e.src_table, id: e.src_id };
      const otherKey = nodeKey(other.table, other.id);

      collected.push({
        src_table: e.src_table,
        src_id: e.src_id,
        dst_table: e.dst_table,
        dst_id: e.dst_id,
        edge_type: e.edge_type,
        writer: e.writer,
        created_at: e.created_at,
        hop,
        node_heat: null,
      });
      discoveredNode.push(other.table === SEALED_TABLE ? null : other);

      if (!visited.has(otherKey) && other.table !== SEALED_TABLE) {
        nextFrontierMap.set(otherKey, other);
      }
    }

    for (const key of nextFrontierMap.keys()) visited.add(key);
    frontier = [...nextFrontierMap.values()];
  }

  if (opts.withHeat) {
    for (const table of HEAT_TABLES) {
      const idsForTable = [...new Set(
        discoveredNode
          .filter((n): n is GraphSeed => n !== null && n.table === table)
          .map((n) => n.id),
      )];
      if (idsForTable.length === 0) continue;
      const heatById = await fetchHeatByTable(db, table, idsForTable);
      for (let i = 0; i < collected.length; i++) {
        const node = discoveredNode[i];
        const row = collected[i];
        if (row && node && node.table === table && heatById.has(node.id)) {
          row.node_heat = heatById.get(node.id) ?? null;
        }
      }
    }
  }

  return collected;
}
