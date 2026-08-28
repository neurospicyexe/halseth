// src/__tests__/mind-graph-block.test.ts
//
// Graph memory Phase 1.5, Tranche 4: src/mind/blocks/graph.ts::loadGraphBlocks.
//
// Two things under test: (1) empty seeds never touch D1 at all -- a companion with no
// conclusions/journal rows yet has nothing to traverse from, and the loader must not issue a
// query to find that out; (2) when seeds ARE present, the block strips `node_heat` off
// TraverseEdge before it reaches the contract (orient doesn't rank, it only renders structure).

import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import { loadGraphBlocks } from "../mind/blocks/graph.js";

describe("loadGraphBlocks", () => {
  it("empty seeds short-circuit to EMPTY_GRAPH without querying D1", async () => {
    let prepared = false;
    const env = {
      DB: { prepare: () => { prepared = true; throw new Error("must not be called"); } },
    } as unknown as Env;

    const result = await loadGraphBlocks(env, "cypher", []);
    expect(result).toEqual({ neighborhoods: [] });
    expect(prepared).toBe(false);
  });

  it("strips node_heat from returned edges -- graph block renders structure, not ranking", async () => {
    const row = {
      id: "e1",
      src_table: "companion_conclusions",
      src_id: "c1",
      dst_table: "companion_journal",
      dst_id: "j1",
      edge_type: "logged_in",
      writer: "cypher",
      created_at: "2026-08-20T00:00:00Z",
    };
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      all: async () => ({ results: [row] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    const env = { DB: { prepare: () => stmt } } as unknown as Env;

    const result = await loadGraphBlocks(env, "cypher", [{ table: "companion_conclusions", id: "c1" }]);
    expect(result.neighborhoods).toHaveLength(1);
    expect(result.neighborhoods[0]).toEqual({
      src_table: "companion_conclusions",
      src_id: "c1",
      dst_table: "companion_journal",
      dst_id: "j1",
      edge_type: "logged_in",
      writer: "cypher",
      created_at: "2026-08-20T00:00:00Z",
      hop: 1,
    });
    expect(result.neighborhoods[0]).not.toHaveProperty("node_heat");
  });

  it("degrades to EMPTY_GRAPH rather than throwing when the traverse query rejects", async () => {
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      all: async () => { throw new Error("D1 unavailable"); },
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    const env = { DB: { prepare: () => stmt } } as unknown as Env;

    const result = await loadGraphBlocks(env, "cypher", [{ table: "companion_conclusions", id: "c1" }]);
    expect(result).toEqual({ neighborhoods: [] });
  });
});
