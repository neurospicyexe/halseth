// Show-back answer 18 (2026-09-28): Gaia's relational pull rises after 12 hours of quiet, Cypher's
// and Drevan's after 36. Against the REAL schema (every migration, node:sqlite): the rows the
// migrations leave behind, read through the same accrual math GET /mind/drives uses.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { accruedLevel, driveFired } from "../webmind/drives.js";

type Row = { companion_id: string; accumulate_per_day: number; threshold: number; decay_on_contact: number };

function rows(): Map<string, Row> {
  const { db } = makeSqliteD1();
  const all = db.prepare(
    `SELECT companion_id, accumulate_per_day, threshold, decay_on_contact FROM companion_drives WHERE drive_key = 'relational_need'`,
  ).all() as unknown as Row[];
  return new Map(all.map(r => [r.companion_id, r]));
}

const firedAfter = (r: Row, hours: number) => driveFired(accruedLevel(0, r.accumulate_per_day, hours), r.threshold);

describe("relational_need, per companion (mig 0139)", () => {
  it("Gaia's pull rises at 12 hours of quiet, not before", () => {
    const g = rows().get("gaia")!;
    expect(firedAfter(g, 11.5)).toBe(false);
    expect(firedAfter(g, 12)).toBe(true);
  });

  it("Cypher and Drevan keep 36 hours", () => {
    const m = rows();
    for (const c of ["cypher", "drevan"]) {
      const r = m.get(c)!;
      expect(firedAfter(r, 12)).toBe(false);
      expect(firedAfter(r, 35.5)).toBe(false);
      expect(firedAfter(r, 36)).toBe(true);
    }
  });

  it("only the rate moved: threshold and contact shed are the same for all three", () => {
    const m = rows();
    for (const c of ["cypher", "drevan", "gaia"]) {
      expect(m.get(c)!.threshold).toBeCloseTo(0.6, 5);
      expect(m.get(c)!.decay_on_contact).toBeCloseTo(0.5, 5);
    }
  });
});
