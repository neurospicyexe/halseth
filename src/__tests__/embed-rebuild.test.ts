import { describe, it, expect } from "vitest";
import { vectorId, EMBEDDING_MODEL } from "../mcp/embed.js";

// Locks the invariant that makes the Vectorize index rebuildable: vector ids are
// deterministic, so re-embedding a row upserts (replaces) rather than accumulates.
describe("vectorId (rebuildable index)", () => {
  it("is deterministic per table+row", () => {
    expect(vectorId("feelings", "abc")).toBe("feelings:abc");
    expect(vectorId("dreams", "r1")).toBe(vectorId("dreams", "r1"));
  });

  it("namespaces by table so the same row id across tables never collides", () => {
    expect(vectorId("feelings", "1")).not.toBe(vectorId("dreams", "1"));
  });

  it("stays within Vectorize's 64-byte id cap for a UUID row id", () => {
    const worst = vectorId("relational_deltas", "1f435fb4-e1ca-4e47-8116-2eefd7bf03d7");
    expect(worst.length).toBeLessThanOrEqual(64);
  });
});

describe("EMBEDDING_MODEL (single source)", () => {
  it("is one exported constant so the model swaps in one place", () => {
    expect(typeof EMBEDDING_MODEL).toBe("string");
    expect(EMBEDDING_MODEL.length).toBeGreaterThan(0);
  });
});
