import { describe, it, expect } from "vitest";
import { docTokens, entityClusterDream, temporalPatternDream, associateDreams } from "../webmind/dream-modes.js";

describe("docTokens", () => {
  it("keeps significant terms, drops stopwords and short tokens", () => {
    const t = docTokens("the bridge connects safety and home");
    expect(t).toContain("bridge");
    expect(t).toContain("safety");
    expect(t).toContain("home");
    expect(t).not.toContain("the");
    expect(t).not.toContain("and");
  });
  it("dedups within a doc", () => {
    expect(docTokens("bridge bridge bridge").filter(x => x === "bridge")).toHaveLength(1);
  });
});

describe("entityClusterDream", () => {
  it("finds the pair that co-occurs across the most entries", () => {
    const docs = [
      { text: "the bridge at dusk felt like safety", created_at: "2026-06-10 09:00:00" },
      { text: "safety again near the bridge", created_at: "2026-06-11 09:00:00" },
      { text: "an unrelated note about coffee", created_at: "2026-06-12 09:00:00" },
    ];
    const dream = entityClusterDream(docs);
    expect(dream).toMatch(/bridge/);
    expect(dream).toMatch(/safety/);
    expect(dream).toMatch(/keep arriving together/);
  });
  it("returns null when nothing co-occurs across entries", () => {
    const docs = [
      { text: "alpha beta gamma", created_at: "2026-06-10 09:00:00" },
      { text: "delta epsilon zeta", created_at: "2026-06-11 09:00:00" },
    ];
    expect(entityClusterDream(docs)).toBeNull();
  });
});

describe("temporalPatternDream", () => {
  it("surfaces a cadence when entries cluster in a 3h window", () => {
    const docs = [
      { text: "a", created_at: "2026-06-10 02:00:00" },
      { text: "b", created_at: "2026-06-11 03:00:00" },
      { text: "c", created_at: "2026-06-12 02:30:00" },
    ];
    const dream = temporalPatternDream(docs);
    expect(dream).toMatch(/A rhythm shows itself/);
  });
  it("returns null when activity is spread across the day", () => {
    const docs = [
      { text: "a", created_at: "2026-06-10 02:00:00" },
      { text: "b", created_at: "2026-06-11 10:00:00" },
      { text: "c", created_at: "2026-06-12 18:00:00" },
    ];
    expect(temporalPatternDream(docs)).toBeNull();
  });
});

describe("associateDreams", () => {
  it("returns 0-2 dreams from the corpus", () => {
    const docs = [
      { text: "the bridge means safety", created_at: "2026-06-10 02:00:00" },
      { text: "bridge, safety, again", created_at: "2026-06-11 03:00:00" },
      { text: "safety bridge once more", created_at: "2026-06-12 02:30:00" },
    ];
    const dreams = associateDreams(docs);
    expect(dreams.length).toBeGreaterThanOrEqual(1);
    expect(dreams.length).toBeLessThanOrEqual(2);
  });
});
