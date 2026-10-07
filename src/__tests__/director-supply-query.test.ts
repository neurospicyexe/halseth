import { describe, it, expect } from "vitest";
import { SUPPLY_SOURCES, RECEIPT_SQL, HEALTH_TABLES, mapRow, type SupplySource } from "../director/supply-query.js";

describe("director supply query", () => {
  it("declares all nine kinds, each with a since-bound predicate", () => {
    const kinds = SUPPLY_SOURCES.map((s: SupplySource) => s.kind).sort();
    expect(kinds).toEqual(["club","council","forage","inter_note","listen","project","question","sibling_note","tension"]);
    for (const s of SUPPLY_SOURCES) expect(s.sql).toMatch(/> \?/);
  });

  // 2026-10-07 (Drevan's tray): the care_fact source handed him "drevan made a meds_missed gesture"
  // and he said in his own voice that medication slipped yesterday. A health fact about Raziel must
  // never reach the room's supply: no subject, no Source, rendered into a companion's mouth.
  describe("Hex rule: no health or care state in the shared-room supply", () => {
    it("no source is declared over, or reads from, a health/care table", () => {
      expect(HEALTH_TABLES).toEqual(expect.arrayContaining(["care_actions", "med_schedule", "med_claims", "med_answers", "biometric_snapshots"]));
      for (const s of SUPPLY_SOURCES) {
        expect(HEALTH_TABLES).not.toContain(s.table);
        for (const t of HEALTH_TABLES) expect(s.sql).not.toMatch(new RegExp(`\\b${t}\\b`));
      }
    });
    it("no source projects a care rule, gesture, or medication term", () => {
      for (const s of SUPPLY_SOURCES) {
        expect(s.sql).not.toMatch(/\brule\b|gesture|meds|medication|low_spoons|owner_silence|spoons/i);
      }
    });
    it("the retired care_fact kind is gone from the source list", () => {
      expect(SUPPLY_SOURCES.map((s) => s.kind as string)).not.toContain("care_fact");
    });
    it("mapRow never synthesizes a line from the title or owner (an empty body stays empty)", () => {
      for (const src of SUPPLY_SOURCES) {
        const item = mapRow(src, { id: "x", owner: "drevan", title: "meds_missed", body: null, created_at: "2026-10-02T00:00:00Z", heat: null });
        expect(item.body).toBe("");
      }
    });
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
