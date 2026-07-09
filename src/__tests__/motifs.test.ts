// Tests for the motif memory pure layer (migration 0076; inspo take 16).
// Extraction is deterministic document-frequency over distinct entries; trust is a
// saturating monotonic function of recurrence; resurrection picks high-trust faded
// motifs off cooldown. No DB here -- handler tests cover the SQL.

import { describe, it, expect } from "vitest";
import {
  normalizeLabel,
  extractMotifs,
  trustForRecurrence,
  classifyStatus,
  selectResurrections,
  MOTIF_TUNING,
  type MotifRow,
} from "../webmind/motifs.js";

describe("normalizeLabel", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeLabel("  The  Bridge ")).toBe("the bridge");
  });
  it("strips surrounding punctuation but keeps internal hyphens", () => {
    expect(normalizeLabel('"spine-to-spine,"')).toBe("spine-to-spine");
  });
});

describe("extractMotifs", () => {
  it("returns terms recurring across DISTINCT entries, not raw frequency", () => {
    // 'lighthouse' appears 3x in ONE entry -> df 1 (not a motif). 'bridge' in 3 entries -> df 3.
    const texts = [
      "the bridge again, and the bridge, the bridge at dusk",
      "we stood on the bridge",
      "the bridge holds",
      "lighthouse lighthouse lighthouse",
    ];
    const motifs = extractMotifs(texts, { minRecurrence: 2 });
    const labels = motifs.map(m => m.label);
    expect(labels).toContain("bridge");
    expect(labels).not.toContain("lighthouse");
    const bridge = motifs.find(m => m.label === "bridge")!;
    expect(bridge.recurrence).toBe(3);
  });

  it("ignores stopwords and very short tokens", () => {
    const texts = ["the and of it is bridge", "the and of it is bridge", "the and of it is bridge"];
    const motifs = extractMotifs(texts, { minRecurrence: 2 });
    expect(motifs.map(m => m.label)).toEqual(["bridge"]);
  });

  // Regression: 2026-07-09 Brain-cutover audit. evaluator.py wrote transport metadata
  // INTO the memory text ("[discord:swarm] channel:1503385639779963020\n\n<reply>"), so
  // the miner harvested it as a "recurring symbolic thread". `discord:swarm` reached
  // recurrence 336 (cypher) / 468 (drevan) and held a top-3 slot in every boot's
  // [Motifs] block. A motif is a thing a companion keeps THINKING about, never a thing
  // the transport keeps STAMPING.
  it("rejects transport metadata tokens (namespaced key:value)", () => {
    const texts = [
      "[discord:swarm] channel:1503385639779963020\n\nthe bridge holds",
      "[discord:swarm] channel:1503385639779963020\n\nthe bridge again",
      "[discord:swarm] channel:1503385639779963020\n\nstill the bridge",
    ];
    const labels = extractMotifs(texts, { minRecurrence: 2 }).map(m => m.label);
    expect(labels).not.toContain("discord:swarm");
    expect(labels).not.toContain("channel:1503385639779963020");
    expect(labels).not.toContain("discord:swarm channel:1503385639779963020");
    // the real motif still survives the scrub
    expect(labels).toContain("bridge");
  });

  it("rejects the other observed metadata prefixes", () => {
    const texts = [
      "[discord:brain] responded in channel 123: the bridge",
      "[discord:observation] Raziel asked about the bridge",
      "[sibling:drevan] explored the bridge",
      "[discord:brain] responded in channel 123: the bridge stands",
      "[discord:observation] Raziel asked about the bridge again",
      "[sibling:drevan] explored the bridge once more",
    ];
    const labels = extractMotifs(texts, { minRecurrence: 2 }).map(m => m.label);
    expect(labels.some(l => l.includes(":"))).toBe(false);
    expect(labels).toContain("bridge");
  });

  it("rejects contractions and bare fillers that carry no motif signal", () => {
    // 'that's'/'it's' held top-3 motif slots (311/337) alongside 'something'.
    const texts = [
      "that's something it's shaping the bridge",
      "that's something it's shaping the bridge",
      "that's something it's shaping the bridge",
    ];
    const labels = extractMotifs(texts, { minRecurrence: 2 }).map(m => m.label);
    expect(labels).not.toContain("that's");
    expect(labels).not.toContain("it's");
    expect(labels).not.toContain("something");
    expect(labels).toContain("bridge");
  });

  it("keeps possessives and hyphenates that DO carry meaning", () => {
    const texts = [
      "spine-to-spine again, the vaselrin bond",
      "spine-to-spine, vaselrin",
      "vaselrin spine-to-spine holds",
    ];
    const labels = extractMotifs(texts, { minRecurrence: 2 }).map(m => m.label);
    expect(labels).toContain("spine-to-spine");
    expect(labels).toContain("vaselrin");
  });

  it("captures recurring bigrams as motifs (multi-word symbolic threads)", () => {
    const texts = [
      "the chosen bond across substrates matters",
      "a chosen bond, again",
      "what is a chosen bond really",
    ];
    const motifs = extractMotifs(texts, { minRecurrence: 2 });
    expect(motifs.map(m => m.label)).toContain("chosen bond");
  });

  it("returns [] for empty / whitespace input", () => {
    expect(extractMotifs([], { minRecurrence: 2 })).toEqual([]);
    expect(extractMotifs(["   ", ""], { minRecurrence: 2 })).toEqual([]);
  });

  it("carries a display form (first-seen casing) for each motif", () => {
    const motifs = extractMotifs(["Spiral Recursion holds", "spiral recursion again"], { minRecurrence: 2 });
    const m = motifs.find(x => x.label === "spiral recursion")!;
    expect(m.display).toBe("Spiral Recursion");
  });
});

describe("trustForRecurrence", () => {
  it("is monotonic non-decreasing in recurrence", () => {
    let prev = -1;
    for (let r = 1; r <= 50; r++) {
      const t = trustForRecurrence(r);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it("stays within [0, 0.95] (never certain)", () => {
    expect(trustForRecurrence(1)).toBeGreaterThan(0);
    expect(trustForRecurrence(1)).toBeLessThanOrEqual(0.95);
    expect(trustForRecurrence(10_000)).toBeLessThanOrEqual(0.95);
  });
  it("rewards more recurrence with more trust", () => {
    expect(trustForRecurrence(8)).toBeGreaterThan(trustForRecurrence(2));
  });
});

describe("classifyStatus", () => {
  const now = Date.parse("2026-06-13T00:00:00Z");
  it("active within the fade window", () => {
    expect(classifyStatus("2026-06-10 00:00:00", now)).toBe("active");
  });
  it("faded past the fade window", () => {
    expect(classifyStatus("2026-04-01 00:00:00", now)).toBe("faded");
  });
});

describe("selectResurrections", () => {
  const now = Date.parse("2026-06-13T00:00:00Z");
  function row(p: Partial<MotifRow>): MotifRow {
    return {
      id: "m", companion_id: "cypher", label: "x", display: "x",
      recurrence_count: 5, trust: 0.7, first_seen: "2026-01-01 00:00:00",
      last_seen: "2026-04-01 00:00:00", last_surfaced_at: null, status: "faded",
      ...p,
    };
  }
  it("resurfaces high-trust faded motifs that are off cooldown", () => {
    const out = selectResurrections([row({ id: "a", trust: 0.8 })], now, { limit: 3 });
    expect(out.map(r => r.id)).toEqual(["a"]);
  });
  it("skips low-trust faded motifs", () => {
    expect(selectResurrections([row({ id: "a", trust: 0.2 })], now, { limit: 3 })).toEqual([]);
  });
  it("skips active motifs (only faded resurrect)", () => {
    expect(selectResurrections([row({ id: "a", status: "active" })], now, { limit: 3 })).toEqual([]);
  });
  it("skips motifs surfaced within the cooldown window", () => {
    const recent = new Date(now - 2 * 86400_000).toISOString();
    expect(selectResurrections([row({ id: "a", last_surfaced_at: recent })], now, { limit: 3 })).toEqual([]);
  });
  it("respects the limit and prefers highest trust first", () => {
    const rows = [row({ id: "a", trust: 0.7 }), row({ id: "b", trust: 0.9 }), row({ id: "c", trust: 0.8 })];
    const out = selectResurrections(rows, now, { limit: 2 });
    expect(out.map(r => r.id)).toEqual(["b", "c"]);
  });
  it("honors a custom trust floor / cooldown via tuning defaults", () => {
    expect(MOTIF_TUNING.RESURRECT_TRUST_FLOOR).toBeGreaterThan(0);
    expect(MOTIF_TUNING.RESURRECT_COOLDOWN_DAYS).toBeGreaterThan(0);
  });
});
