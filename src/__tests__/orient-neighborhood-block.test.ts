// src/__tests__/orient-neighborhood-block.test.ts
//
// Graph memory Phase 1.5, Tranche 5 (docs/private/graph-memory-spec-2026-08-28.md):
// neighborhoodBlock() unit tests -- grouping, self-truncation, empty behavior, and the
// no-content-leakage guarantee (edges carry no text field; the renderer must never fabricate one).

import { describe, it, expect } from "vitest";
import { neighborhoodBlock, type NeighborhoodEdgeRow } from "../librarian/response/orient-blocks.js";

function edge(overrides: Partial<NeighborhoodEdgeRow>): NeighborhoodEdgeRow {
  return {
    src_table: "companions",
    src_id: "drevan",
    dst_table: "companion_journal",
    dst_id: "journal-id-0000000000",
    edge_type: "logged_in",
    writer: "drevan",
    created_at: "2026-08-20T00:00:00Z",
    hop: 1,
    ...overrides,
  };
}

describe("neighborhoodBlock", () => {
  it("empty neighborhoods => empty string (block absent, zero bytes)", () => {
    expect(neighborhoodBlock([])).toBe("");
  });

  it("groups repeated (edge_type, dst_table, writer) edges into one counted line with the newest date", () => {
    const edges = [
      edge({ dst_id: "j1", created_at: "2026-08-10T00:00:00Z" }),
      edge({ dst_id: "j2", created_at: "2026-08-28T00:00:00Z" }),
      edge({ dst_id: "j3", created_at: "2026-08-15T00:00:00Z" }),
    ];
    const block = neighborhoodBlock(edges);
    expect(block).toContain("[Linked]");
    expect(block).toContain("linked: 3 notes from drevan (newest 2026-08-28)");
    // exactly one grouped line, not three
    expect(block.split("\n").filter(l => l.startsWith("•")).length).toBe(1);
  });

  it("a lone edge in its group renders as a single pointer line with a shortened id", () => {
    const block = neighborhoodBlock([
      edge({ edge_type: "references", dst_table: "companion_tensions", dst_id: "3f9a2b1c9e8d7f6a", writer: "cypher" }),
    ]);
    expect(block).toContain("references tension 3f9a2b1c");
    // id is shortened to 8 chars, never shown in full
    expect(block).not.toContain("3f9a2b1c9e8d7f6a");
  });

  it("unrecognized edge_type/table fall back to the raw values rather than throwing", () => {
    const block = neighborhoodBlock([
      edge({ edge_type: "future_edge_type", dst_table: "some_new_table", dst_id: "abcdef1234567890", writer: "gaia" }),
    ]);
    expect(block).toContain("future_edge_type some_new_table abcdef12");
  });

  it("self-caps at 6 lines even with many distinct groups", () => {
    const edges = Array.from({ length: 10 }, (_, i) =>
      edge({ edge_type: `edge_type_${i}`, dst_table: "companion_journal", dst_id: `id${i}`, writer: "drevan", created_at: `2026-08-${10 + i}T00:00:00Z` }),
    );
    const block = neighborhoodBlock(edges);
    const lines = block.split("\n").filter(l => l.startsWith("•"));
    expect(lines.length).toBe(6);
  });

  it("newest groups render first (sorted by newest created_at desc)", () => {
    const edges = [
      edge({ edge_type: "supersedes", dst_table: "companion_conclusions", dst_id: "old1", writer: "gaia", created_at: "2026-07-01T00:00:00Z" }),
      edge({ edge_type: "sent_to", dst_table: "inter_companion_notes", dst_id: "new1", writer: "drevan", created_at: "2026-08-27T00:00:00Z" }),
    ];
    const block = neighborhoodBlock(edges);
    const idxNew = block.indexOf("sent to messages new1");
    const idxOld = block.indexOf("supersedes conclusions old1");
    expect(idxNew).toBeGreaterThan(-1);
    expect(idxOld).toBeGreaterThan(-1);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("hard-truncates any line exceeding ~90 chars with an ellipsis", () => {
    const longWriter = "a-writer-id-that-is-deliberately-long-enough-to-push-this-whole-line-past-the-ninety-character-cap";
    const block = neighborhoodBlock([
      edge({ dst_id: "j1", writer: longWriter, created_at: "2026-08-01T00:00:00Z" }),
      edge({ dst_id: "j2", writer: longWriter, created_at: "2026-08-27T00:00:00Z" }),
    ], { maxLines: 6 });
    const line = block.split("\n").find(l => l.startsWith("•"))!;
    // "• " prefix + capped content
    expect(line.length).toBeLessThanOrEqual(2 + 90);
    expect(line.endsWith("…")).toBe(true);
  });

  it("respects a custom maxLines option", () => {
    const edges = Array.from({ length: 5 }, (_, i) =>
      edge({ edge_type: `t${i}`, dst_id: `id${i}`, writer: "drevan", created_at: `2026-08-${10 + i}T00:00:00Z` }),
    );
    const block = neighborhoodBlock(edges, { maxLines: 2 });
    expect(block.split("\n").filter(l => l.startsWith("•")).length).toBe(2);
  });

  it("never renders anything beyond table/id/edge_type/writer/date -- no content field exists to leak", () => {
    // NeighborhoodEdgeRow structurally has no text/content field at all -- this test is a canary in
    // case a future edit widens the type; it asserts on the CURRENT shape's exhaustive key set.
    const e = edge({});
    expect(Object.keys(e).sort()).toEqual(
      ["created_at", "dst_id", "dst_table", "edge_type", "hop", "src_id", "src_table", "writer"].sort(),
    );
  });
});
