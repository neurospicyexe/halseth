// Tests for the graph memory Phase 1 bounded traversal (src/graph/traverse.ts).
// Mirrors the suite's miniflare-free style (see graph-rebuild.test.ts): a minimal in-memory D1
// fake, hand-shaped to the exact query patterns traverse.ts issues (a single dynamic
// graph_edges SELECT per (table, id-chunk) pair, and a heat SELECT per heat-bearing table).

import { describe, it, expect } from "vitest";
import { neighborhood, type GraphSeed } from "../graph/traverse.js";
import type { Env } from "../types.js";

interface EdgeRow {
  id: string;
  src_table: string;
  src_id: string;
  dst_table: string;
  dst_id: string;
  edge_type: string;
  writer: string;
  created_at: string;
}

interface HeatRow {
  id: string;
  heat: number;
}

const SEALED_TABLE = ["sibling", "notes"].join("_");

/** Reconstructs the WHERE-clause semantics of buildEdgeQuery() from the bound params, since the
 *  SQL text is dynamic (variable-length IN (...) lists). This fake is deliberately coupled to
 *  traverse.ts's exact binding layout -- table, idChunk, table, idChunk, sealed, sealed,
 *  [...edgeTypes] -- documented at graph/traverse.ts::buildEdgeQuery. */
function evalEdgeQuery(sql: string, bound: unknown[], edges: EdgeRow[]): EdgeRow[] {
  const idCountMatch = /IN \((\?(?:, \?)*)\)/.exec(sql);
  const idCount = idCountMatch ? (idCountMatch[1] ?? "").split(",").length : 0;

  const table = bound[0] as string;
  const idChunk = bound.slice(1, 1 + idCount) as string[];
  // bound[1 + idCount] repeats `table`; bound[1 + idCount + 1 .. +idCount] repeats idChunk.
  const afterSecondChunk = 1 + idCount + 1 + idCount;
  const sealedA = bound[afterSecondChunk] as string;
  const sealedB = bound[afterSecondChunk + 1] as string;
  const edgeTypes = bound.slice(afterSecondChunk + 2) as string[];

  return edges.filter((e) => {
    const touchesFrontier =
      (e.src_table === table && idChunk.includes(e.src_id)) ||
      (e.dst_table === table && idChunk.includes(e.dst_id));
    if (!touchesFrontier) return false;
    if (e.src_table === sealedA || e.dst_table === sealedB) return false;
    if (edgeTypes.length > 0 && !edgeTypes.includes(e.edge_type)) return false;
    return true;
  });
}

class FakeStatement {
  constructor(
    private sql: string,
    private state: { edges: EdgeRow[]; heat: Record<string, HeatRow[]>; mutations: string[] },
    private bound: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.state, args);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.state.mutations.push(this.sql.trim());
    return { meta: { changes: 0 } };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const sql = this.sql.trim();

    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
      this.state.mutations.push(sql);
      return { results: [] };
    }

    if (sql.includes("FROM graph_edges")) {
      const rows = evalEdgeQuery(sql, this.bound, this.state.edges);
      rows.sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { results: (rows as unknown) as T[] };
    }

    const tableMatch = /FROM (\w+)/.exec(sql);
    const table = tableMatch?.[1];
    if (table && this.state.heat[table]) {
      const ids = this.bound as string[];
      const rows = this.state.heat[table]
        .filter((r) => ids.includes(r.id))
        .map((r) => ({ id: r.id, node_heat: r.heat }));
      return { results: (rows as unknown) as T[] };
    }

    return { results: [] };
  }

  async first<T = unknown>(): Promise<T | null> {
    return null;
  }
}

function makeEnv(edges: EdgeRow[], heat: Record<string, HeatRow[]> = {}) {
  const state = { edges, heat, mutations: [] as string[] };
  const env = {
    DB: {
      prepare: (sql: string) => new FakeStatement(sql, state),
      batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run())),
    },
  } as unknown as Env;
  return { env, state };
}

function edge(
  id: string,
  src: [string, string],
  dst: [string, string],
  edge_type: string,
  created_at: string,
  writer = "cypher",
): EdgeRow {
  return {
    id,
    src_table: src[0],
    src_id: src[1],
    dst_table: dst[0],
    dst_id: dst[1],
    edge_type,
    writer,
    created_at,
  };
}

describe("neighborhood", () => {
  it("walks 1 hop in both directions from a seed", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env } = makeEnv([
      edge("e1", ["companion_journal", "a1"], ["companion_conclusions", "b1"], "logged_in", "2026-01-01T00:00:00Z"),
      edge("e2", ["companion_conclusions", "b2"], ["companion_journal", "a1"], "supersedes", "2026-01-02T00:00:00Z"),
    ]);

    const result = await neighborhood(env, seeds, { hops: 1 });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.hop === 1)).toBe(true);
    const ids = result.map((r) => (r.src_id === "a1" ? r.dst_id : r.src_id)).sort();
    expect(ids).toEqual(["b1", "b2"]);
  });

  it("expands to hop 2 without revisiting seed nodes or re-surfacing the hop-1 edge", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env } = makeEnv([
      // hop 1: a1 -> b1
      edge("e1", ["companion_journal", "a1"], ["companion_journal", "b1"], "logged_in", "2026-01-01T00:00:00Z"),
      // hop 2 from b1: back to the seed (must not be treated as a NEW frontier node)...
      edge("e2", ["companion_journal", "b1"], ["companion_journal", "a1"], "logged_in", "2026-01-02T00:00:00Z"),
      // ...and forward to a genuinely new node c1
      edge("e3", ["companion_journal", "b1"], ["companion_journal", "c1"], "logged_in", "2026-01-03T00:00:00Z"),
    ]);

    const result = await neighborhood(env, seeds, { hops: 2 });

    const hop2 = result.filter((r) => r.hop === 2);
    // e2 (b1 -> a1, a revisit of the seed) must be excluded from hop 2's *new discovery* set;
    // only e3 (b1 -> c1) surfaces as new.
    expect(hop2.map((r) => r.dst_id)).toEqual(["c1"]);
    // e1 must not be re-collected at hop 2 even though it also touches b1.
    expect(result.filter((r) => r.src_id === "a1" && r.dst_id === "b1")).toHaveLength(1);
  });

  it("caps each hop at the limit and orders deterministically (created_at DESC, then id)", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const edges = [
      edge("e1", ["companion_journal", "a1"], ["companion_journal", "n1"], "logged_in", "2026-01-01T00:00:00Z"),
      edge("e2", ["companion_journal", "a1"], ["companion_journal", "n2"], "logged_in", "2026-01-02T00:00:00Z"),
      edge("e3", ["companion_journal", "a1"], ["companion_journal", "n3"], "logged_in", "2026-01-03T00:00:00Z"),
    ];
    const { env } = makeEnv(edges);

    const result1 = await neighborhood(env, seeds, { hops: 1, limit: 2 });
    const result2 = await neighborhood(env, seeds, { hops: 1, limit: 2 });

    expect(result1).toHaveLength(2);
    // Newest first: n3 (01-03), then n2 (01-02); n1 (01-01) is dropped by the cap.
    expect(result1.map((r) => r.dst_id)).toEqual(["n3", "n2"]);
    expect(result2.map((r) => r.dst_id)).toEqual(result1.map((r) => r.dst_id));
  });

  it("hard-caps limit at 100 even when a larger value is requested", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const many = Array.from({ length: 120 }, (_, i) =>
      edge(`e${i}`, ["companion_journal", "a1"], ["companion_journal", `n${i}`], "logged_in", `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const { env } = makeEnv(many);

    const result = await neighborhood(env, seeds, { hops: 1, limit: 500 });
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("filters by edgeTypes", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env } = makeEnv([
      edge("e1", ["companion_journal", "a1"], ["companion_journal", "b1"], "logged_in", "2026-01-01T00:00:00Z"),
      edge("e2", ["companion_journal", "a1"], ["companion_conclusions", "c1"], "supersedes", "2026-01-02T00:00:00Z"),
    ]);

    const result = await neighborhood(env, seeds, { hops: 1, edgeTypes: ["supersedes"] });

    expect(result).toHaveLength(1);
    expect(result[0]!.edge_type).toBe("supersedes");
    expect(result[0]!.dst_id).toBe("c1");
  });

  it("never queries or returns an edge touching the sealed lane, even as the seed itself", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env } = makeEnv([
      edge("e1", ["companion_journal", "a1"], ["companion_journal", "b1"], "logged_in", "2026-01-01T00:00:00Z"),
      edge("e2", ["companion_journal", "a1"], [SEALED_TABLE, "s1"], "logged_in", "2026-01-02T00:00:00Z"),
    ]);

    const result = await neighborhood(env, seeds, { hops: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.dst_id).toBe("b1");
    for (const r of result) {
      expect(r.src_table).not.toBe(SEALED_TABLE);
      expect(r.dst_table).not.toBe(SEALED_TABLE);
    }

    // A seed that IS the sealed table is refused outright -- empty frontier, empty result, no
    // edge query is ever issued for it.
    const sealedSeedResult = await neighborhood(env, [{ table: SEALED_TABLE, id: "s1" }], { hops: 1 });
    expect(sealedSeedResult).toEqual([]);
  });

  it("attaches node_heat for the newly-discovered endpoint without mutating anything", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env, state } = makeEnv(
      [edge("e1", ["companion_journal", "a1"], ["companion_conclusions", "c1"], "supersedes", "2026-01-01T00:00:00Z")],
      { companion_conclusions: [{ id: "c1", heat: 3.5 }] },
    );

    const result = await neighborhood(env, seeds, { hops: 1, withHeat: true });

    expect(result).toHaveLength(1);
    expect(result[0]!.node_heat).toBe(3.5);
    expect(state.mutations).toEqual([]); // no UPDATE/INSERT/DELETE ever issued

    const withoutHeat = await neighborhood(env, seeds, { hops: 1, withHeat: false });
    expect(withoutHeat[0]!.node_heat).toBeNull();
  });

  it("does not drop a cold neighbor -- withHeat attaches heat, it never filters by it", async () => {
    const seeds: GraphSeed[] = [{ table: "companion_journal", id: "a1" }];
    const { env } = makeEnv(
      [edge("e1", ["companion_journal", "a1"], ["companion_conclusions", "cold1"], "supersedes", "2026-01-01T00:00:00Z")],
      { companion_conclusions: [{ id: "cold1", heat: 0.01 }] },
    );

    const result = await neighborhood(env, seeds, { hops: 1, withHeat: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.node_heat).toBe(0.01);
  });
});
