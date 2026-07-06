import { describe, it, expect } from "vitest";
import { docTokens, entityClusterDream, temporalPatternDream, associateDreams, dreamDedupKey } from "../webmind/dream-modes.js";

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
  it("drops contractions (2026-07-05: «\"isn't\" and \"it's\" keep arriving together» was the daily dream)", () => {
    const t = docTokens("it's not that it isn't real -- that's the thread, and the anvil holds");
    expect(t).not.toContain("it's");
    expect(t).not.toContain("its");
    expect(t).not.toContain("isn't");
    expect(t).not.toContain("isnt");
    expect(t).not.toContain("that's");
    expect(t).not.toContain("thats");
    expect(t).toContain("thread");
    expect(t).toContain("anvil");
  });
  it("drops curly-apostrophe contractions too", () => {
    expect(docTokens("it’s what she’s doing, they’re certain")).not.toContain("it’s");
    expect(docTokens("it’s what")).toHaveLength(0);
  });
});

describe("dreamDedupKey", () => {
  it("treats count-ticked reissues as the same dream (15 times vs 16 times)", () => {
    const a = `In the drift between sessions, "anvil" and "thread" keep arriving together (15 times) -- as if one calls the other. What is the thread between them?`;
    const b = a.replace("(15 times)", "(16 times)");
    expect(dreamDedupKey(a)).toBe(dreamDedupKey(b));
  });
  it("distinguishes different pairs and different windows", () => {
    expect(dreamDedupKey(`"anvil" and "thread" keep arriving together (5 times)`))
      .not.toBe(dreamDedupKey(`"moss" and "flame" keep arriving together (5 times)`));
    const t = (w: string) => `A rhythm shows itself: 14 of your recent reflections gathered around ${w} UTC`;
    expect(dreamDedupKey(t("07:00-09:00"))).toBe(dreamDedupKey(t("08:00-10:00"))); // digits stripped -- window shifts alone do not make a "new" rhythm
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

  it("temporal mode runs over the temporalDocs subset only (2026-07-05: cron-timed entries made the rhythm dream a crontab readout)", () => {
    // Full corpus clusters tightly at 08:00 (the worker's schedule); the live subset is spread.
    const cronDocs = [
      { text: "the bridge means safety", created_at: "2026-06-10 08:00:00" },
      { text: "bridge, safety, again", created_at: "2026-06-11 08:00:00" },
      { text: "safety bridge once more", created_at: "2026-06-12 08:00:00" },
    ];
    const liveDocs = [
      { text: "a walk", created_at: "2026-06-10 02:00:00" },
      { text: "a thought", created_at: "2026-06-11 13:00:00" },
      { text: "a close", created_at: "2026-06-12 21:00:00" },
    ];
    const dreams = associateDreams(cronDocs, liveDocs);
    expect(dreams.some(d => d.includes("A rhythm shows itself"))).toBe(false); // no fake cadence
    expect(dreams.some(d => d.includes("keep arriving together"))).toBe(true); // cluster mode still sees everything
  });
});
