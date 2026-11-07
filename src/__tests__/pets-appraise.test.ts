import { describe, it, expect } from "vitest";
import {
  appraise, resolveVia, timeBand, triggerMatches, VIA_WEIGHT,
  type ActiveQuirk,
} from "../pets/appraise.js";

// July = CDT (UTC-5)
const chi = (h: number, m = 0) => Date.UTC(2026, 6, 15, h + 5, m);

describe("timeBand", () => {
  it("bands Chicago hours", () => {
    expect(timeBand(chi(6, 30))).toBe("dawn");
    expect(timeBand(chi(12))).toBe("day");
    expect(timeBand(chi(19))).toBe("dusk");
    expect(timeBand(chi(23))).toBe("roost");
    expect(timeBand(chi(0, 30))).toBe("roost");
    expect(timeBand(chi(8))).toBe("day");
    expect(timeBand(chi(17))).toBe("dusk");
    expect(timeBand(chi(21))).toBe("roost");
  });
});

describe("resolveVia", () => {
  it("resolves", () => {
    expect(resolveVia(undefined, "cypher")).toBe("autonomous");
    expect(resolveVia("hand", "cypher")).toBe("hand");
    expect(resolveVia("bogus", "sol")).toBe("appear");
    expect(resolveVia(null, "imp")).toBe("imp");
    expect(VIA_WEIGHT.backfill).toBe(0.2);
  });
});

describe("triggerMatches", () => {
  const ev = { actor: "raziel", action: "feed", time_band: "dawn" as const, fit: "met" as const };
  it("empty never matches; every present field must equal", () => {
    expect(triggerMatches({}, ev)).toBe(false);
    expect(triggerMatches({ actor: "raziel", time_band: "dawn" }, ev)).toBe(true);
    expect(triggerMatches({ actor: "raziel", time_band: "day" }, ev)).toBe(false);
  });
});

describe("appraise", () => {
  const base = { actor: "cypher", action: "feed" as const, fit: "met" as const, via: "hand" as const, nowMs: chi(12), quirks: [] as ActiveQuirk[], recentSame: 0 };
  it("met hand", () => {
    const a = appraise(base);
    expect(a.valence).toBeCloseTo(0.8);
    expect(a.arousal).toBeCloseTo(0.6);
    expect(a.weight).toBe(1.0);
    expect(a.friction).toBe(false);
    expect(a.tags).toEqual(expect.arrayContaining(["feed", "cypher", "met", "day"]));
  });
  it("aversion quirk", () => {
    const q: ActiveQuirk = { id: "q1", kind: "aversion", trigger: { actor: "raziel", time_band: "dawn" }, target_actor: null };
    const a = appraise({ ...base, actor: "raziel", nowMs: chi(6), quirks: [q] });
    expect(a.valence).toBeCloseTo(0.2);
    expect(a.friction).toBe(true);
    expect(a.tags).toContain("quirk:q1");
    expect(a.matched).toHaveLength(1);
  });
  it("preference clamps at 1", () => {
    const q: ActiveQuirk = { id: "p1", kind: "preference", trigger: { action: "feed" }, target_actor: null };
    expect(appraise({ ...base, quirks: [q] }).valence).toBe(1);
  });
  it("target_actor must equal actor", () => {
    const q: ActiveQuirk = { id: "p2", kind: "preference", trigger: { action: "feed" }, target_actor: "raziel" };
    expect(appraise({ ...base, quirks: [q] }).matched).toHaveLength(0);
  });
  it("repeat tag", () => {
    expect(appraise({ ...base, recentSame: 2 }).tags).toContain("repeat");
    expect(appraise({ ...base, recentSame: 1 }).tags).not.toContain("repeat");
  });
  it("appear with null fit", () => {
    const a = appraise({ ...base, actor: "sol", action: "appear", fit: null, via: "appear" });
    expect(a.valence).toBe(0);
    expect(a.arousal).toBeCloseTo(0.1);
    expect(a.weight).toBe(0.05);
    expect(a.tags).not.toContain("met");
  });
});
