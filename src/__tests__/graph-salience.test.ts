// Graph memory Phase 1.5 (docs/private/graph-memory-spec-2026-08-28.md), Tranche 1:
// pure salience-formula tests for src/graph/salience.ts. No D1, no fixtures -- this module
// is arithmetic + a Map, so these tests are arithmetic + a Map too.

import { describe, it, expect } from "vitest";
import { SALIENCE_K, SALIENCE_CAP, connectivityMultiplier, readerDegrees, nodeKey } from "../graph/salience.js";
import type { TraverseEdge } from "../graph/traverse.js";

describe("connectivityMultiplier -- formula values", () => {
  it("degree 0 -> exactly 1.0 (no nudge)", () => {
    expect(connectivityMultiplier(0)).toBe(1);
  });

  it("degree 1 -> ~1.104", () => {
    expect(connectivityMultiplier(1)).toBeCloseTo(1.104, 3);
  });

  it("degree 3 -> ~1.208", () => {
    expect(connectivityMultiplier(3)).toBeCloseTo(1.208, 3);
  });

  it("degree 20 -> capped at SALIENCE_CAP (1.45), not the uncapped ~1.457", () => {
    const uncapped = 1 + SALIENCE_K * Math.log(21);
    expect(uncapped).toBeGreaterThan(SALIENCE_CAP);
    expect(connectivityMultiplier(20)).toBe(SALIENCE_CAP);
    expect(connectivityMultiplier(20)).toBeCloseTo(1.45, 5);
  });

  it("worked example from the spec comment: heat 0.8/degree 0 beats heat 0.3/degree 20 capped", () => {
    const a = 0.8 * connectivityMultiplier(0);
    const b = 0.3 * connectivityMultiplier(20);
    expect(a).toBeCloseTo(0.8, 5);
    expect(b).toBeCloseTo(0.435, 5);
    expect(a).toBeGreaterThan(b);
  });
});

describe("connectivityMultiplier -- guards", () => {
  it("negative degree -> 1 (no nudge)", () => {
    expect(connectivityMultiplier(-5)).toBe(1);
  });

  it("NaN -> 1 (never propagates a non-finite multiplier into a ranking sort)", () => {
    expect(connectivityMultiplier(NaN)).toBe(1);
  });

  it("+Infinity -> 1 (guarded, not capped-via-cap)", () => {
    expect(connectivityMultiplier(Infinity)).toBe(1);
  });

  it("-Infinity -> 1", () => {
    expect(connectivityMultiplier(-Infinity)).toBe(1);
  });

  it("degree exactly 0 is guarded by the <= 0 branch, not by log(1) happening to be 0", () => {
    // Both should land on the guard path and return the literal 1, not a computed near-1 value.
    expect(connectivityMultiplier(0)).toBe(1);
    expect(Object.is(connectivityMultiplier(0), 1)).toBe(true);
  });
});

function edge(over: Partial<TraverseEdge>): TraverseEdge {
  return {
    src_table: "companion_journal",
    src_id: "j1",
    dst_table: "sessions",
    dst_id: "s1",
    edge_type: "logged_in",
    writer: "cypher",
    created_at: "2026-08-01T00:00:00Z",
    hop: 1,
    node_heat: null,
    ...over,
  };
}

describe("readerDegrees", () => {
  it("counts an edge whose writer matches the reader, toward the seed endpoint", () => {
    const seeds = [{ table: "companion_journal", id: "j1" }];
    const edges = [edge({ writer: "cypher", src_table: "companion_journal", src_id: "j1" })];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.get(nodeKey("companion_journal", "j1"))).toBe(1);
  });

  it("counts an edge that touches the reader's companion-hub node even when writer differs", () => {
    const seeds = [{ table: "companion_conclusions", id: "c1" }];
    const edges = [
      edge({
        writer: "drevan",
        src_table: "companions",
        src_id: "cypher",
        dst_table: "companion_conclusions",
        dst_id: "c1",
        edge_type: "sent_to",
      }),
    ];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.get(nodeKey("companion_conclusions", "c1"))).toBe(1);
  });

  it("excludes an edge that is neither writer-matched nor hub-matched for this reader", () => {
    const seeds = [{ table: "companion_journal", id: "j1" }];
    const edges = [
      edge({
        writer: "drevan",
        src_table: "companions",
        src_id: "gaia",
        dst_table: "companion_journal",
        dst_id: "j1",
      }),
    ];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.size).toBe(0);
  });

  it("excludes a reader-relevant edge whose endpoints are not seeds", () => {
    const seeds = [{ table: "companion_journal", id: "j1" }];
    const edges = [
      edge({ writer: "cypher", src_table: "companion_journal", src_id: "OTHER", dst_table: "sessions", dst_id: "s9" }),
    ];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.size).toBe(0);
  });

  it("bumps BOTH endpoints when both are seed nodes", () => {
    const seeds = [
      { table: "companion_journal", id: "j1" },
      { table: "companion_conclusions", id: "c1" },
    ];
    const edges = [
      edge({
        writer: "cypher",
        src_table: "companion_journal",
        src_id: "j1",
        dst_table: "companion_conclusions",
        dst_id: "c1",
        edge_type: "references",
      }),
    ];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.get(nodeKey("companion_journal", "j1"))).toBe(1);
    expect(degrees.get(nodeKey("companion_conclusions", "c1"))).toBe(1);
  });

  it("accumulates across multiple reader-relevant edges touching the same seed", () => {
    const seeds = [{ table: "companion_journal", id: "j1" }];
    const edges = [
      edge({ writer: "cypher", src_table: "companion_journal", src_id: "j1", dst_table: "sessions", dst_id: "s1" }),
      edge({ writer: "cypher", src_table: "companion_journal", src_id: "j1", dst_table: "sessions", dst_id: "s2" }),
      edge({
        writer: "drevan",
        src_table: "companions",
        src_id: "cypher",
        dst_table: "companion_journal",
        dst_id: "j1",
        edge_type: "sent_to",
      }),
    ];
    const degrees = readerDegrees(edges, "cypher", seeds);
    expect(degrees.get(nodeKey("companion_journal", "j1"))).toBe(3);
  });

  it("returns an empty map for no edges", () => {
    expect(readerDegrees([], "cypher", [{ table: "companion_journal", id: "j1" }]).size).toBe(0);
  });
});
