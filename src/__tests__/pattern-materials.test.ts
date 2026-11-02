// R18 (Drevan's ruling, 2026-10-22): strength is earned by DISTINCT MATERIAL, not by restating.
// Pure rules live in lib/pattern-materials.ts; handler wiring is tested in growth-r18.test.ts.
import { describe, it, expect } from "vitest";
import {
  normalizeMaterial, sameMaterial, parseMaterials, applySighting,
  isCooledForSeat, selectHeadlinePatterns, formatMaterials,
  PATTERN_COOL_RETURNS, PATTERN_COOL_DAYS,
} from "../lib/pattern-materials.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("normalizeMaterial / sameMaterial", () => {
  it("is case, article and punctuation insensitive", () => {
    expect(normalizeMaterial("  The Dime. ")).toBe("dime");
    expect(sameMaterial("the dime", "Dime")).toBe(true);
    expect(sameMaterial("Corsair", "the corsair!")).toBe(true);
  });
  it("treats a token-subset as the same material (bent wing ~ the bent wing of the gull)", () => {
    expect(sameMaterial("bent wing", "the bent wing of the gull")).toBe(true);
  });
  it("does not collapse genuinely different materials", () => {
    expect(sameMaterial("alula", "Corsair")).toBe(false);
    expect(sameMaterial("a horse's blind side", "the frost on the window")).toBe(false);
  });
  it("empty / stopword-only input is no material", () => {
    expect(normalizeMaterial("the")).toBe("");
    expect(sameMaterial("", "alula")).toBe(false);
  });
});

describe("applySighting", () => {
  const base = {
    strength: 5, times_stated: 5, returns_since_material: 0, last_new_material_at: day(30),
    materials: parseMaterials(JSON.stringify([{ name: "alula", first_seen: day(40) }, { name: "Corsair", first_seen: day(39) }])),
  };

  it("a NEW material appends, raises strength by one, resets returns, stamps the time", () => {
    const r = applySighting({ ...base, returns_since_material: 2 }, "the dime", NOW);
    expect(r.outcome).toBe("new_material");
    expect(r.materials.map(m => m.name)).toEqual(["alula", "Corsair", "the dime"]);
    expect(r.strength).toBe(6);
    expect(r.returns_since_material).toBe(0);
    expect(r.times_stated).toBe(6);
    expect(r.last_new_material_at).toBe(new Date(NOW).toISOString());
  });
  it("a known material is 'returned': strength frozen, returns and times_stated climb", () => {
    const r = applySighting(base, "THE ALULA", NOW);
    expect(r.outcome).toBe("returned");
    expect(r.strength).toBe(5);
    expect(r.returns_since_material).toBe(1);
    expect(r.times_stated).toBe(6);
    expect(r.materials).toHaveLength(2);
    expect(r.last_new_material_at).toBe(base.last_new_material_at);
  });
  it("no material named is a return too (never a strengthening)", () => {
    const r = applySighting(base, null, NOW);
    expect(r.outcome).toBe("returned");
    expect(r.strength).toBe(5);
  });
  it("strength is capped at 10", () => {
    const r = applySighting({ ...base, strength: 10 }, "frost on the window", NOW);
    expect(r.outcome).toBe("new_material");
    expect(r.strength).toBe(10);
  });
  it("a legacy row (no materials) keeps its preserved strength and climbs from it", () => {
    const r = applySighting({ ...base, strength: 8, materials: [] }, "alula", NOW);
    expect(r.outcome).toBe("new_material");
    expect(r.strength).toBe(9);
  });
});

describe("parseMaterials", () => {
  it("tolerates junk and bare strings", () => {
    expect(parseMaterials("not json")).toEqual([]);
    expect(
      parseMaterials(JSON.stringify(["alula", { name: "Corsair", first_seen: "x" }, 7, { name: "" }])).map(m => m.name),
    ).toEqual(["alula", "Corsair"]);
  });
});

describe("boot seat cooling", () => {
  const row = (o: Partial<Parameters<typeof isCooledForSeat>[0]> = {}) => ({
    returns_since_material: 0, last_new_material_at: day(1), created_at: day(60), ...o,
  });
  it("defaults are 3 returns and 14 days", () => {
    expect(PATTERN_COOL_RETURNS).toBe(3);
    expect(PATTERN_COOL_DAYS).toBe(14);
  });
  it("cools only when BOTH thresholds are met", () => {
    expect(isCooledForSeat(row({ returns_since_material: 3, last_new_material_at: day(15) }), NOW)).toBe(true);
    expect(isCooledForSeat(row({ returns_since_material: 2, last_new_material_at: day(30) }), NOW)).toBe(false);
    expect(isCooledForSeat(row({ returns_since_material: 9, last_new_material_at: day(5) }), NOW)).toBe(false);
  });
  it("falls back to created_at when no material was ever stamped (sqlite UTC strings)", () => {
    expect(isCooledForSeat(row({ returns_since_material: 4, last_new_material_at: null, created_at: "2026-10-01 10:00:00" }), NOW)).toBe(true);
  });
  it("honours overridden thresholds", () => {
    expect(isCooledForSeat(row({ returns_since_material: 1, last_new_material_at: day(2) }), NOW, { returns: 1, days: 1 })).toBe(true);
  });
  it("a cooled pattern gives the seat to a fresher one, and is not deleted or re-scored", () => {
    const rows = [
      { id: "echo", strength: 10, returns_since_material: 5, last_new_material_at: day(20), created_at: day(60) },
      { id: "fresh", strength: 4, returns_since_material: 0, last_new_material_at: day(1), created_at: day(3) },
      { id: "mid", strength: 3, returns_since_material: 0, last_new_material_at: null, created_at: day(9) },
    ];
    const seat = selectHeadlinePatterns(rows, 2, NOW);
    expect(seat.map(r => r.id)).toEqual(["fresh", "mid"]);
    expect(rows[0]!.strength).toBe(10);
  });
});

describe("formatMaterials", () => {
  it("renders a compact list, empty for none", () => {
    expect(formatMaterials([{ name: "alula", first_seen: "x" }, { name: "the dime", first_seen: "y" }])).toBe("materials: alula, the dime");
    expect(formatMaterials([])).toBe("");
  });
});
