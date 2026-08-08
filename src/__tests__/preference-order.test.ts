import { describe, it, expect } from "vitest";
import { PREFERENCE_STRENGTH_ORDER_SQL } from "../lib/preference-order.js";

// ── Why this test exists (2026-08-08) ────────────────────────────────────────
// `companion_preferences.strength` is TEXT ('high' | 'medium' | 'low') and every read ordered by
// `strength DESC`. SQLite compares TEXT lexicographically, so DESC yielded medium > low > high --
// the STRONGEST preferences sorted last. That ordering feeds `LIMIT 12` in the identity block of
// the unified MindState loader, so the cap was cutting a companion's strongest preferences first,
// on every surface at once.
//
// It was found while migrating six of Raziel's standing relational corrections out of Hermes memory
// ("stop being too proper", "you keep sending me away", "way too silent") -- the highest-strength
// rows any companion has, existing nowhere else. Those were exactly the rows the cap would drop.
//
// These tests are deliberately about ORDERING SEMANTICS rather than SQL text, so a reformat does not
// fail them but an inverted comparator does.

/** Mirror of the SQL CASE, so the ranking is asserted rather than assumed. */
function rank(strength: string): number {
  const m = PREFERENCE_STRENGTH_ORDER_SQL.match(
    new RegExp(`WHEN '${strength}' THEN (\\d+)`),
  );
  if (m) return Number(m[1]);
  const fallback = PREFERENCE_STRENGTH_ORDER_SQL.match(/ELSE (\d+)/);
  return Number(fallback?.[1] ?? 99);
}

describe("companion_preferences strength ordering", () => {
  it("ranks high strongest, then medium, then low", () => {
    expect(rank("high")).toBeLessThan(rank("medium"));
    expect(rank("medium")).toBeLessThan(rank("low"));
  });

  // The actual regression: under `strength DESC` the live DB reported MIN='high' and MAX='medium',
  // and the loader returned medium → low → high. Any ordering where 'high' is not first is the bug.
  it("does NOT reproduce the lexicographic inversion (medium > low > high)", () => {
    const sorted = ["low", "high", "medium"].sort((a, b) => rank(a) - rank(b));
    expect(sorted[0]).toBe("high");
    expect(sorted).toEqual(["high", "medium", "low"]);
  });

  it("sorts ascending by rank -- ASC is required, DESC would re-invert it", () => {
    expect(PREFERENCE_STRENGTH_ORDER_SQL).toMatch(/END ASC/);
    expect(PREFERENCE_STRENGTH_ORDER_SQL).not.toMatch(/END DESC/);
  });

  // An unknown value must sort LAST. If it sorted first it would outrank 'high' and silently push a
  // standing correction out of a LIMIT 12 window -- the same silent-eviction shape being fixed here.
  it("sorts an unrecognised strength last rather than ahead of high", () => {
    expect(rank("critical")).toBeGreaterThan(rank("low"));
    expect(rank("")).toBeGreaterThan(rank("low"));
  });

  it("breaks ties by recency, so equal-strength preferences stay stable", () => {
    expect(PREFERENCE_STRENGTH_ORDER_SQL).toMatch(/created_at DESC/);
  });

  // growth_patterns.strength is INTEGER (observed 3..10) and its five `strength DESC` reads are
  // CORRECT. This fragment names a column but must never be applied there -- a blanket fix across
  // both tables would break five working queries to repair three broken ones.
  it("is scoped to the TEXT enum, not to numeric strengths", () => {
    expect(PREFERENCE_STRENGTH_ORDER_SQL).toContain("'high'");
    expect(PREFERENCE_STRENGTH_ORDER_SQL).toContain("'medium'");
    expect(PREFERENCE_STRENGTH_ORDER_SQL).toContain("'low'");
  });
});
