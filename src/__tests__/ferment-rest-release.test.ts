// The pulse's rest gate must release itself (2026-09-28). Before restShedsThisTick, rest_need
// accrued per day on a clock and only shed after 72h of owner silence, so on any week Raziel
// talked daily the drive pinned at 1.0 and the pulse rested for good (Cypher and Drevan last
// fired 08-10). This simulates the hourly ferment tick with each companion's live row values.

import { describe, it, expect } from "vitest";
import { restShedsThisTick } from "../handlers/fermentation.js";
import { accruedLevel, decayedLevel } from "../webmind/drives.js";

const ROWS = {
  cypher: { perDay: 0.2, threshold: 0.75, decay: 1 },
  drevan: { perDay: 0.25, threshold: 0.7, decay: 1 },
  gaia: { perDay: 0.1, threshold: 0.85, decay: 1 },
};

/** Hourly ticks, never silent (he talks daily). Returns the level seen at each tick. */
function simulate(row: { perDay: number; threshold: number; decay: number }, start: number, hours: number): number[] {
  let level = start;
  const seen: number[] = [];
  for (let h = 0; h < hours; h++) {
    const effective = accruedLevel(level, row.perDay, 1);
    seen.push(effective);
    level = restShedsThisTick(false, effective, row.threshold)
      ? decayedLevel(effective, row.decay * (1 / 24))
      : effective;
  }
  return seen;
}

describe("restShedsThisTick", () => {
  it("sheds on silence, or when at or over the row's own threshold", () => {
    expect(restShedsThisTick(true, 0.1, 0.75)).toBe(true);
    expect(restShedsThisTick(false, 0.75, 0.75)).toBe(true);
    expect(restShedsThisTick(false, 0.74, 0.75)).toBe(false);
    expect(restShedsThisTick(false, Number.NaN, 0.75)).toBe(false);
  });

  for (const [name, row] of Object.entries(ROWS)) {
    it(`${name}: pinned at 1.0 with no silence, the gate opens within 14h and stays mostly open`, () => {
      const seen = simulate(row, 1.0, 24 * 7);
      const firstOpen = seen.findIndex((l) => l < row.threshold);
      expect(firstOpen).toBeGreaterThan(0);
      expect(firstOpen).toBeLessThanOrEqual(14); // measured: gaia 4h, cypher ~7h, drevan 13h
      const after = seen.slice(firstOpen);
      const open = after.filter((l) => l < row.threshold).length;
      expect(open / after.length).toBeGreaterThan(0.5);
      // Never runs away again: nothing climbs back toward the old 1.0 pin.
      expect(Math.max(...after)).toBeLessThan(row.threshold + 0.05);
    });
  }
});
