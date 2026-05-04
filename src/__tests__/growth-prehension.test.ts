import { describe, it, expect } from "vitest";
import { tokenize, jaccard, mergeJsonArrays, PATTERN_DEDUP_THRESHOLD } from "../handlers/growth.js";

describe("tokenize", () => {
  it("strips stop words and short tokens", () => {
    const t = tokenize("I gravitate toward the architecture of repair");
    expect(t.has("gravitate")).toBe(true);
    expect(t.has("toward")).toBe(true);
    expect(t.has("architecture")).toBe(true);
    expect(t.has("repair")).toBe(true);
    expect(t.has("the")).toBe(false);
    expect(t.has("of")).toBe(false);
    expect(t.has("i")).toBe(false);
  });

  it("strips literal 'pattern' so pattern-prefix noise doesn't dominate Jaccard", () => {
    const t = tokenize("Pattern: repair architectures matter");
    expect(t.has("pattern")).toBe(false);
    expect(t.has("repair")).toBe(true);
    expect(t.has("architectures")).toBe(true);
  });

  it("is case- and punctuation-insensitive", () => {
    const a = tokenize("Repair-architecture, the recurring shape!");
    const b = tokenize("repair architecture the recurring shape");
    expect(jaccard(a, b)).toBeGreaterThan(0.9);
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    const t = tokenize("repair architecture matters");
    expect(jaccard(t, t)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(tokenize("alpha beta"), tokenize("gamma delta"))).toBe(0);
  });

  it("returns 0 for an empty set", () => {
    expect(jaccard(new Set(), tokenize("anything"))).toBe(0);
  });
});

describe("PATTERN_DEDUP_THRESHOLD behavior (acceptance)", () => {
  // Realistic reflect-phase restatement: the model is shown the existing
  // pattern and deepens it, retaining most content words. The UPSERT path
  // MUST fire on this kind of overlap or strength never accumulates.
  it("merges restated patterns (substantial token overlap)", () => {
    const a = tokenize("I gravitate toward repair architecture under load");
    const b = tokenize("Under load my work gravitates toward repair architecture");
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(PATTERN_DEDUP_THRESHOLD);
  });

  it("does NOT merge surface-paraphrase with low lexical overlap", () => {
    // Documents the limitation: token-Jaccard cannot bridge phrasings that
    // share only one word, even if the underlying idea is the same. The
    // reflect prompt mitigates this by surfacing the existing pattern_text
    // so the model has the prior vocabulary in front of it. If this test
    // ever inverts (jaccard rises above threshold), check whether tokenize
    // changed -- not all rewrites are wins.
    const a = tokenize("I gravitate toward repair architectures");
    const b = tokenize("Repair architecture is what I keep returning to");
    expect(jaccard(a, b)).toBeLessThan(PATTERN_DEDUP_THRESHOLD);
  });

  it("does NOT merge genuinely distinct patterns", () => {
    const a = tokenize("Distributed failure recovery requires explicit boundaries");
    const b = tokenize("Memory thresholds determine attention budget");
    expect(jaccard(a, b)).toBeLessThan(PATTERN_DEDUP_THRESHOLD);
  });
});

describe("mergeJsonArrays", () => {
  it("appends incoming items not already present", () => {
    const merged = mergeJsonArrays('["a","b"]', ["c", "b"], 16);
    expect(JSON.parse(merged)).toEqual(["a", "b", "c"]);
  });

  it("dedupes object items by JSON equality", () => {
    const merged = mergeJsonArrays(
      JSON.stringify([{ quote: "x" }]),
      [{ quote: "x" }, { quote: "y" }],
      16,
    );
    expect(JSON.parse(merged)).toEqual([{ quote: "x" }, { quote: "y" }]);
  });

  it("caps at the supplied limit, dropping oldest", () => {
    const merged = mergeJsonArrays(
      JSON.stringify([1, 2, 3]),
      [4, 5],
      3,
    );
    expect(JSON.parse(merged)).toEqual([3, 4, 5]);
  });

  it("survives malformed JSON in the existing column", () => {
    const merged = mergeJsonArrays("not json at all", ["x"], 16);
    expect(JSON.parse(merged)).toEqual(["x"]);
  });
});
