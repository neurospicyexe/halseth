import { describe, it, expect } from "vitest";
import { renderEdgeLines, scoreNode } from "../graph/render.js";
import { nodeKey } from "../graph/salience.js";
import type { TraverseEdge } from "../graph/traverse.js";

const e = (o: Partial<TraverseEdge>): TraverseEdge => ({
  src_table: "companion_tensions", src_id: "t1", dst_table: "companions", dst_id: "drevan",
  edge_type: "holds_tension", writer: "drevan", created_at: "2026-09-01T00:00:00Z", hop: 1, node_heat: 0.4, ...o,
});

describe("graph render", () => {
  it("caps lines and width", () => {
    const edges = Array.from({ length: 10 }, (_, i) => e({ src_id: `t${i}`.padEnd(120, "x") }));
    const lines = renderEdgeLines(edges, new Map(), 6);
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(90);
  });
  it("scores post-decay heat times the capped connectivity multiplier", () => {
    expect(scoreNode(0.8, 0)).toBeCloseTo(0.8);
    expect(scoreNode(0.3, 20)).toBeCloseTo(0.3 * 1.45, 3);
    expect(scoreNode(null, 50)).toBe(0);
  });
  it("mentions degree in the line when the reader has one", () => {
    const d = new Map([[nodeKey("companion_tensions", "t1"), 3]]);
    const [line] = renderEdgeLines([e({})], d);
    expect(line).toContain("3 links");
  });

  describe("labels map", () => {
    it("uses the label when present for a node keyed table/id", () => {
      const edge = e({ dst_table: "watch_shelf", dst_id: "ws1" });
      const labels = new Map([["watch_shelf/ws1", "Fargo"]]);
      const [line] = renderEdgeLines([edge], new Map(), 6, labels);
      expect(line).toContain("-> Fargo");
      expect(line).not.toContain("watch_shelf/ws1");
    });

    it("falls back to the id-shortened label when no entry exists", () => {
      const edge = e({ dst_table: "watch_shelf", dst_id: "ws-no-label-12345" });
      const labels = new Map([["watch_shelf/some-other-id", "Severance"]]);
      const [line] = renderEdgeLines([edge], new Map(), 6, labels);
      expect(line).toContain("watch_shelf/ws-no-la");
      expect(line).not.toContain("Severance");
    });

    it("falls back identically when no labels map is passed at all", () => {
      const edge = e({ dst_table: "watch_shelf", dst_id: "ws1" });
      const withUndefined = renderEdgeLines([edge], new Map(), 6);
      const withEmptyMap = renderEdgeLines([edge], new Map(), 6, new Map());
      expect(withUndefined).toEqual(withEmptyMap);
    });

    it("width cap still applies when a label is used", () => {
      const longTitle = "A".repeat(120);
      const edge = e({ dst_table: "watch_shelf", dst_id: "ws1" });
      const labels = new Map([["watch_shelf/ws1", longTitle]]);
      const [line] = renderEdgeLines([edge], new Map(), 6, labels);
      expect(line!.length).toBeLessThanOrEqual(90);
    });
  });
});
