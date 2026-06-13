import { describe, it, expect } from "vitest";
import {
  trustDelta,
  actionMood,
  clampTrust,
  decayedTrust,
  deriveMood,
  daysSinceIso,
  isValidAction,
  TRUST_BASELINE,
  listCreaturesSql,
  getCreatureSql,
  recentInteractionsSql,
  insertInteractionSql,
  interactBumpSql,
  tickUpdateSql,
} from "../webmind/creatures.js";

describe("interaction trust deltas", () => {
  it("each action gives a positive bump, give is the most generous", () => {
    expect(trustDelta("talk")).toBeGreaterThan(0);
    expect(trustDelta("give")).toBeGreaterThan(trustDelta("talk"));
  });
  it("maps each action to a fresh mood", () => {
    expect(actionMood("play")).toBe("playful");
    expect(actionMood("give")).toBe("delighted");
  });
  it("validates actions", () => {
    expect(isValidAction("feed")).toBe(true);
    expect(isValidAction("scold")).toBe(false);
  });
});

describe("clampTrust", () => {
  it("bounds to [0,1] and rejects NaN", () => {
    expect(clampTrust(1.4)).toBe(1);
    expect(clampTrust(-0.2)).toBe(0);
    expect(clampTrust(NaN)).toBe(0);
    expect(clampTrust(0.5)).toBe(0.5);
  });
});

describe("decayedTrust", () => {
  it("cools toward baseline over untended days, monotonic non-increasing", () => {
    expect(decayedTrust(0.8, 3)).toBeCloseTo(0.71, 5); // 0.8 - 0.03*3
    expect(decayedTrust(0.8, 0)).toBeCloseTo(0.8, 5);
  });
  it("never falls below the baseline (a met creature stays met)", () => {
    expect(decayedTrust(0.5, 1000)).toBe(TRUST_BASELINE);
  });
  it("leaves already-cool creatures untouched", () => {
    expect(decayedTrust(0.05, 100)).toBeCloseTo(0.05, 5);
  });
});

describe("deriveMood", () => {
  it("bands trust into mood labels", () => {
    expect(deriveMood(0.9)).toBe("affectionate");
    expect(deriveMood(0.5)).toBe("watchful");
    expect(deriveMood(0.25)).toBe("wary");
    expect(deriveMood(0.05)).toBe("aloof");
  });
});

describe("daysSinceIso", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  it("parses D1 + ISO timestamps to whole-ish days", () => {
    expect(daysSinceIso("2026-06-11 12:00:00", now)).toBeCloseTo(2, 5);
    expect(daysSinceIso("2026-06-12T12:00:00Z", now)).toBeCloseTo(1, 5);
  });
  it("returns 0 for null/garbage/future", () => {
    expect(daysSinceIso(null, now)).toBe(0);
    expect(daysSinceIso("nope", now)).toBe(0);
    expect(daysSinceIso("2026-06-20 12:00:00", now)).toBe(0);
  });
});

describe("sql builders", () => {
  it("interactBumpSql clamps trust at SQL level and json_sets mood", () => {
    const sql = interactBumpSql();
    expect(sql).toContain("MIN(1.0, MAX(0.0, trust + ?))");
    expect(sql).toContain("json_set(COALESCE(state_json,'{}'), '$.mood', ?)");
    expect(sql).toContain("last_interaction_at = datetime('now')");
  });
  it("insertInteractionSql is append-only", () => {
    expect(insertInteractionSql()).toContain("INSERT INTO creature_interactions");
  });
  it("tickUpdateSql writes computed trust + mood by id", () => {
    const sql = tickUpdateSql();
    expect(sql).toContain("UPDATE creatures SET trust = ?");
    expect(sql).toContain("json_set");
    expect(sql).toContain("WHERE id = ?");
  });
  it("read builders target the creatures tables", () => {
    expect(listCreaturesSql()).toContain("FROM creatures");
    expect(getCreatureSql()).toContain("WHERE id = ?");
    expect(recentInteractionsSql()).toContain("FROM creature_interactions");
  });
});
