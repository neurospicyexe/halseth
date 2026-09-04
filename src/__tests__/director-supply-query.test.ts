import { describe, it, expect } from "vitest";
import { SUPPLY_SOURCES, mapRow, type SupplySource } from "../director/supply-query.js";

describe("director supply query", () => {
  it("declares all ten kinds, each with a since-bound predicate", () => {
    const kinds = SUPPLY_SOURCES.map((s: SupplySource) => s.kind).sort();
    expect(kinds).toEqual(["care_fact","club","council","forage","inter_note","listen","project","question","sibling_note","tension"]);
    for (const s of SUPPLY_SOURCES) expect(s.sql).toMatch(/> \?/);
  });
  it("care_fact never carries the gesture note or detail", () => {
    const care = SUPPLY_SOURCES.find((s) => s.kind === "care_fact")!;
    expect(care.sql).not.toMatch(/gesture_note|detail/);
    const item = mapRow(care, { id: "c1", owner: "drevan", title: "low_spoons", body: null, created_at: "2026-09-01T00:00:00Z", heat: null });
    expect(item.body).toBe("drevan made a low_spoons gesture");
  });
  it("no source references the sealed lane", () => {
    const sealed = ["sibling", "notes"].join("_");
    for (const s of SUPPLY_SOURCES) expect(s.sql).not.toContain(sealed);
  });
  it("mapRow truncates body to 700 chars and defaults heat/consumed_by", () => {
    const forage = SUPPLY_SOURCES.find((s) => s.kind === "forage")!;
    const item = mapRow(forage, { id: "f", owner: null, title: "t", body: "x".repeat(900), created_at: "2026-09-01", heat: null });
    expect(item.body.length).toBe(700);
    expect(item.owner).toBe("system");
    expect(item.consumed_by).toEqual([]);
  });
});
