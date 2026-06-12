import { describe, it, expect } from "vitest";
import { effectiveHeatSql, warmSql, HEAT_BUMP, HEAT_MAX } from "../webmind/heat.js";

describe("effectiveHeatSql", () => {
  it("decays by days since last access and adds a 4h coherence bonus", () => {
    const sql = effectiveHeatSql();
    // hyperbolic decay -- portable, no exp()
    expect(sql).toContain("heat / (1.0 +");
    expect(sql).toContain("julianday('now')");
    expect(sql).toContain("coalesce(last_access_at, created_at)");
    // 4h session-coherence bonus, linear fade: age_days * 6 == age_hours / 4
    expect(sql).toContain("* 6.0");
    expect(sql).not.toContain("exp(");
  });

  it("exports bump/cap constants used by warm updates", () => {
    expect(HEAT_BUMP).toBeGreaterThan(0);
    expect(HEAT_MAX).toBeGreaterThan(1);
  });
});

describe("warmSql", () => {
  it("builds an UPDATE with one placeholder per id, capped at HEAT_MAX", () => {
    const sql = warmSql("wm_continuity_notes", "note_id", 3);
    expect(sql).toContain("UPDATE wm_continuity_notes");
    expect(sql).toContain(`MIN(${HEAT_MAX}, heat + ${HEAT_BUMP})`);
    expect(sql).toContain("last_access_at = datetime('now')");
    expect(sql).toContain("note_id IN (?, ?, ?)");
  });
});
