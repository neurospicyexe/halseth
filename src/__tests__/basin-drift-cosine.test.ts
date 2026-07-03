// Cosine corroboration for the basin drift check (2026-07-02).
import { describe, it, expect } from "vitest";
import { cosineSim } from "../synthesis/jobs/basin-drift-check.js";

describe("cosineSim", () => {
  it("returns 1 for identical vectors and -1 for opposite", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns null on dimension mismatch, empty, or zero vectors", () => {
    expect(cosineSim([1, 2], [1, 2, 3])).toBeNull();
    expect(cosineSim([], [])).toBeNull();
    expect(cosineSim([0, 0], [1, 1])).toBeNull();
  });
});
