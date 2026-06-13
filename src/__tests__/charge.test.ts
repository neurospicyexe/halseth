import { describe, it, expect } from "vitest";
import { CHARGE_PHASES, nextPhase, phaseAdvances, advanceChargeSql } from "../webmind/charge.js";

describe("nextPhase", () => {
  it("ratified advances exactly one step along the ladder", () => {
    expect(nextPhase("fresh", "ratified")).toBe("active");
    expect(nextPhase("active", "ratified")).toBe("processing");
    expect(nextPhase("processing", "ratified")).toBe("metabolized");
  });

  it("ratified caps at metabolized (the top of the ladder)", () => {
    expect(nextPhase("metabolized", "ratified")).toBe("metabolized");
  });

  it("surfaced only nudges fresh -> active, never deeper", () => {
    expect(nextPhase("fresh", "surfaced")).toBe("active");
    expect(nextPhase("active", "surfaced")).toBe("active");
    expect(nextPhase("processing", "surfaced")).toBe("processing");
  });

  it("reconsolidated jumps to at least processing but never regresses", () => {
    expect(nextPhase("fresh", "reconsolidated")).toBe("processing");
    expect(nextPhase("active", "reconsolidated")).toBe("processing");
    expect(nextPhase("metabolized", "reconsolidated")).toBe("metabolized");
  });

  it("treats unknown/null current phase as fresh", () => {
    expect(nextPhase(null, "ratified")).toBe("active");
    expect(nextPhase(undefined, "ratified")).toBe("active");
    expect(nextPhase("garbage", "ratified")).toBe("active");
  });
});

describe("phaseAdvances", () => {
  it("is true only when the phase would actually move", () => {
    expect(phaseAdvances("fresh", "ratified")).toBe(true);
    expect(phaseAdvances("metabolized", "ratified")).toBe(false);
    expect(phaseAdvances("active", "surfaced")).toBe(false);
    expect(phaseAdvances("processing", "reconsolidated")).toBe(false);
  });
});

describe("ladder shape + sql", () => {
  it("is the four-rung muse-brain ladder in order", () => {
    expect(CHARGE_PHASES).toEqual(["fresh", "active", "processing", "metabolized"]);
  });
  it("advanceChargeSql stamps phase + advanced_at by id", () => {
    const sql = advanceChargeSql();
    expect(sql).toContain("UPDATE growth_journal SET charge_phase = ?");
    expect(sql).toContain("charge_advanced_at = datetime('now')");
    expect(sql).toContain("WHERE id = ?");
  });
});
