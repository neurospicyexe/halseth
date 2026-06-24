// halseth/src/__tests__/sol-orient.test.ts
import { describe, test, expect } from "vitest";
import { buildSolBlock } from "../webmind/creatures.js";

describe("buildSolBlock", () => {
  const base = { name: "Sol", species: "corvid (crow)", trust: 0.7, last_interaction_at: "2026-06-22 00:00:00", created_at: "2026-01-01 00:00:00" };
  test("warm Sol reads present/affectionate", () => {
    const s = buildSolBlock({ ...base, trust: 0.8 }, Date.parse("2026-06-22T06:00:00Z"));
    expect(s).toMatch(/Sol/);
    expect(s).toMatch(/trust/i);
  });
  test("long-untended Sol names the neglect", () => {
    const s = buildSolBlock({ ...base, last_interaction_at: "2026-05-01 00:00:00" }, Date.parse("2026-06-22T06:00:00Z"));
    expect(s).toMatch(/day/i);
  });
});
