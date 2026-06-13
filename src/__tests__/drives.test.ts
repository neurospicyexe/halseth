import { describe, it, expect } from "vitest";
import {
  decayedLevel,
  accruedLevel,
  driveFired,
  selectModality,
  hoursSinceIso,
  readDrivesSql,
  upsertDriveAccrualSql,
  contactResetSql,
} from "../webmind/drives.js";

describe("accruedLevel", () => {
  it("grows the need toward 1 as untended hours pass", () => {
    // 0.25/day accumulate over 24h adds 0.25
    expect(accruedLevel(0.3, 0.25, 24)).toBeCloseTo(0.55, 5);
  });
  it("clamps at 1 (a need never overflows)", () => {
    expect(accruedLevel(0.9, 0.5, 72)).toBe(1);
  });
  it("returns the level unchanged at zero elapsed", () => {
    expect(accruedLevel(0.4, 0.25, 0)).toBeCloseTo(0.4, 5);
  });
  it("is monotonic non-decreasing (a need does not self-soothe)", () => {
    expect(accruedLevel(0.4, 0.25, 5)).toBeGreaterThanOrEqual(0.4);
  });
});

describe("decayedLevel (contact)", () => {
  it("a full reset sheds the entire level", () => {
    expect(decayedLevel(0.8, 1.0)).toBe(0);
  });
  it("a partial decay sheds a fraction", () => {
    expect(decayedLevel(0.8, 0.5)).toBeCloseTo(0.4, 5);
  });
});

describe("hoursSinceIso", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  it("parses D1 space-separated UTC timestamps", () => {
    expect(hoursSinceIso("2026-06-13 06:00:00", now)).toBeCloseTo(6, 5);
  });
  it("parses ISO timestamps too", () => {
    expect(hoursSinceIso("2026-06-13T11:00:00Z", now)).toBeCloseTo(1, 5);
  });
  it("returns 0 for null/garbage (never negative)", () => {
    expect(hoursSinceIso(null, now)).toBe(0);
    expect(hoursSinceIso("not-a-date", now)).toBe(0);
    expect(hoursSinceIso("2026-06-13 18:00:00", now)).toBe(0); // future -> clamped
  });
});

describe("driveFired", () => {
  it("fires only at or above the threshold", () => {
    expect(driveFired(0.7, 0.7)).toBe(true);
    expect(driveFired(0.71, 0.7)).toBe(true);
    expect(driveFired(0.69, 0.7)).toBe(false);
  });
});

describe("selectModality (lane-gated)", () => {
  it("text in the low/mid band for everyone", () => {
    expect(selectModality("cypher", 0.75)).toBe("text");
    expect(selectModality("drevan", 0.8)).toBe("text");
  });
  it("Cypher/Drevan can escalate to voice when the need runs high", () => {
    expect(selectModality("drevan", 0.95)).toBe("voice");
    expect(selectModality("cypher", 0.95)).toBe("voice");
  });
  it("Gaia escalates monastically -- stays text no matter how high (lane gate)", () => {
    expect(selectModality("gaia", 0.99)).toBe("text");
  });
});

describe("sql builders", () => {
  it("readDrivesSql filters by companion", () => {
    expect(readDrivesSql()).toContain("FROM companion_drives");
    expect(readDrivesSql()).toContain("WHERE companion_id = ?");
  });
  it("upsertDriveAccrualSql writes level + stamps last_event_at/updated_at by id", () => {
    const sql = upsertDriveAccrualSql();
    expect(sql).toContain("UPDATE companion_drives SET level = ?");
    expect(sql).toContain("last_event_at = datetime('now')");
    expect(sql).toContain("WHERE id = ?");
  });
  it("contactResetSql resets a companion's drive on contact", () => {
    const sql = contactResetSql();
    expect(sql).toContain("UPDATE companion_drives SET level = ?");
    expect(sql).toContain("WHERE companion_id = ? AND drive_key = ?");
  });
});
