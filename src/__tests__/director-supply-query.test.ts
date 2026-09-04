import { describe, it, expect } from "vitest";
import { SUPPLY_SOURCES, RECEIPT_SQL, mapRow, type SupplySource } from "../director/supply-query.js";

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
  it("inter_note source has no NOT EXISTS filter -- directed notes stay in the shared stream (I2)", () => {
    const interNote = SUPPLY_SOURCES.find((s) => s.kind === "inter_note")!;
    expect(interNote.sql).not.toContain("NOT EXISTS");
    expect(interNote.sql).not.toContain("inter_companion_note_reads");
    // Per-reader consumption still tracked via RECEIPT_SQL, not a WHERE-clause filter.
    expect(RECEIPT_SQL.inter_note).toBeDefined();
  });
  it("every source drains oldest-first (ORDER BY strftime(...) ASC, id ASC, no DESC)", () => {
    for (const s of SUPPLY_SOURCES) {
      expect(s.sql).toMatch(/ORDER BY strftime\(.*\) ASC, [\w.]+ ASC\s+LIMIT \?/);
      expect(s.sql).not.toContain(" DESC");
    }
  });
  it("every source normalizes created_at via strftime in both projection and predicate (C1)", () => {
    for (const s of SUPPLY_SOURCES) {
      const occurrences = s.sql.split("strftime('%Y-%m-%dT%H:%M:%SZ'").length - 1;
      // At least one occurrence in the projected alias and one in the cursor predicate.
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });
  it("the two staleness gates (tension/project) compare normalized timestamps on both sides", () => {
    const tension = SUPPLY_SOURCES.find((s) => s.kind === "tension")!;
    expect(tension.sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%SZ', last_surfaced_at\) < strftime\('%Y-%m-%dT%H:%M:%SZ', datetime\('now','-1 day'\)\)/);
    const project = SUPPLY_SOURCES.find((s) => s.kind === "project")!;
    expect(project.sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%SZ', last_worked_at\) < strftime\('%Y-%m-%dT%H:%M:%SZ', datetime\('now','-2 days'\)\)/);
  });
  it("documents why the SQL normalizes: mixed formats do not compare chronologically as plain strings", () => {
    // The SQLite datetime('now') format ("2026-09-03 09:00:00") sorts BEFORE the JS ISO format
    // ("2026-09-03T05:00:00.000Z") as a plain string even though 09:00 is chronologically LATER
    // than 05:00 -- the space vs "T" separator breaks lexicographic ordering. This is exactly why
    // a scalar `> ?` cursor across mixed-format sources silently drops rows, and why every source
    // above normalizes through strftime('%Y-%m-%dT%H:%M:%SZ', ...) before comparing.
    expect("2026-09-03 09:00:00" > "2026-09-03T05:00:00.000Z").toBe(false);
  });
});
