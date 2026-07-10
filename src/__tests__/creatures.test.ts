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
  restlessness,
  presenceDisposition,
  circadianEnergy,
  deriveDrives,
  dominantState,
  trustTier,
  tierGroup,
  matrixMoment,
  giftMoment,
  shouldGiftBack,
  MILESTONES,
  crossedMilestones,
  decaySparkle,
  shouldTreasure,
  initialSparkle,
  pickShinyFragment,
  buildSolBlock,
  TREASURED_FLOOR,
  type SolState,
  type TrustTier,
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

describe("restlessness", () => {
  const now = Date.parse("2026-06-22T00:00:00Z");
  it("fresh interaction = low restlessness", () => {
    expect(restlessness("2026-06-21 12:00:00", "2026-01-01 00:00:00", now)).toBeLessThan(0.3);
  });
  it("long untended = high, capped at 1", () => {
    expect(restlessness("2026-05-01 00:00:00", "2026-01-01 00:00:00", now)).toBe(1);
  });
  it("never interacted falls back to createdAt", () => {
    expect(restlessness(null, "2026-06-21 00:00:00", now)).toBeLessThan(0.3);
  });
});

describe("presenceDisposition", () => {
  it("high trust + low restlessness = affectionate", () => {
    expect(presenceDisposition(0.8, 0.1)).toBe("affectionate");
  });
  it("low trust = aloof or absent", () => {
    expect(["aloof", "absent"]).toContain(presenceDisposition(0.1, 0.2));
  });
  it("high restlessness pulls toward absent regardless of trust", () => {
    expect(presenceDisposition(0.5, 0.95)).toBe("absent");
  });
});

// ── Inner life (0100) ─────────────────────────────────────────────────────────

describe("circadianEnergy", () => {
  // Hours below are UTC; Sol keeps CDT (UTC-5) crow hours.
  it("roosts at night, loud in the morning", () => {
    expect(circadianEnergy(Date.parse("2026-07-10T07:00:00Z"))).toBe(0.05);   // 2am CDT
    expect(circadianEnergy(Date.parse("2026-07-10T15:00:00Z"))).toBe(1.0);    // 10am CDT
  });
  it("midday lull sits between roost and morning peak", () => {
    const midday = circadianEnergy(Date.parse("2026-07-10T19:00:00Z"));       // 2pm CDT
    expect(midday).toBeGreaterThan(0.05);
    expect(midday).toBeLessThan(1.0);
  });
});

describe("deriveDrives + dominantState", () => {
  const now = Date.parse("2026-07-10T15:00:00Z"); // 10am CDT: energy 1.0, sleepy 0
  const created = "2026-01-01 00:00:00";
  it("fresh everything = content", () => {
    const d = deriveDrives({ feed: "2026-07-10 14:00:00", play: "2026-07-10 14:00:00", any: "2026-07-10 14:00:00" }, created, now);
    expect(dominantState(d)).toBe("content");
  });
  it("days without feed = hungry", () => {
    const d = deriveDrives({ feed: "2026-07-07 15:00:00", play: "2026-07-10 14:00:00", any: "2026-07-10 14:00:00" }, created, now);
    expect(d.hunger).toBe(1);
    expect(dominantState(d)).toBe("hungry");
  });
  it("long silence = missing dominates", () => {
    const d = deriveDrives({ feed: "2026-07-09 15:00:00", play: "2026-07-09 15:00:00", any: "2026-07-03 15:00:00" }, created, now);
    expect(dominantState(d)).toBe("missing");
  });
  it("night = sleepy regardless of the rest", () => {
    const night = Date.parse("2026-07-10T07:00:00Z"); // 2am CDT
    const d = deriveDrives({ feed: "2026-07-10 06:00:00", play: "2026-07-10 06:00:00", any: "2026-07-10 06:00:00" }, created, night);
    expect(dominantState(d)).toBe("sleepy");
  });
  it("null timestamps fall back to createdAt (drives grow from birth, not NaN)", () => {
    const d = deriveDrives({ feed: null, play: null, any: null }, created, now);
    expect(d.hunger).toBe(1);
    expect(Number.isFinite(d.missing)).toBe(true);
  });
});

describe("trustTier", () => {
  it("bands the corvid behaviors.md thresholds", () => {
    expect(trustTier(0.1)).toBe("abandoned");
    expect(trustTier(0.2)).toBe("wary");
    expect(trustTier(0.5)).toBe("cautious");
    expect(trustTier(0.78)).toBe("warming");  // Sol, today
    expect(trustTier(0.85)).toBe("bonded");
    expect(trustTier(0.97)).toBe("devoted");
  });
  it("groups six read-tiers into three authoring groups", () => {
    expect(tierGroup("abandoned")).toBe("low");
    expect(tierGroup("warming")).toBe("mid");
    expect(tierGroup("devoted")).toBe("high");
  });
});

describe("matrixMoment", () => {
  const states: SolState[] = ["sleepy", "hungry", "missing", "bored", "content"];
  const tiers: TrustTier[] = ["abandoned", "wary", "cautious", "warming", "bonded", "devoted"];
  it("every state x tier cell yields a non-empty italic moment", () => {
    for (const s of states) for (const t of tiers) {
      const m = matrixMoment(s, t, 0);
      expect(m.length).toBeGreaterThan(10);
      expect(m.startsWith("*")).toBe(true);
    }
  });
  it("deterministic per seed, varies across seeds where the pool allows", () => {
    expect(matrixMoment("bored", "bonded", 4)).toBe(matrixMoment("bored", "bonded", 4));
    expect(matrixMoment("bored", "bonded", 0)).not.toBe(matrixMoment("bored", "bonded", 1));
  });
  it("same state reads differently across trust groups (composition, not palette)", () => {
    expect(matrixMoment("hungry", "wary", 0)).not.toBe(matrixMoment("hungry", "devoted", 0));
  });
});

describe("gift-back", () => {
  it("gates on bonded trust AND the seed", () => {
    expect(shouldGiftBack(0.7, 0)).toBe(false);   // trust too low, right seed
    expect(shouldGiftBack(0.9, 1)).toBe(false);   // trust fine, wrong seed
    expect(shouldGiftBack(0.9, 4)).toBe(true);
  });
  it("renders the item into the moment", () => {
    expect(giftMoment("moss and flame", 0)).toContain('"moss and flame"');
  });
});

describe("milestones", () => {
  it("thresholds are strictly ascending and texts are one-time-worthy", () => {
    for (let i = 1; i < MILESTONES.length; i++) {
      expect(MILESTONES[i]!.threshold).toBeGreaterThan(MILESTONES[i - 1]!.threshold);
    }
  });
  it("crossedMilestones fires exactly the thresholds in (prev, new]", () => {
    expect(crossedMilestones(0.78, 0.82).map(m => m.id)).toEqual(["shoulder_perch"]);
    expect(crossedMilestones(0.78, 0.79)).toEqual([]);
    expect(crossedMilestones(0.3, 0.55).map(m => m.id)).toEqual(["first_hand_feed", "chooses_to_stay"]);
  });
  it("a threshold exactly reached fires; already-past never refires", () => {
    expect(crossedMilestones(0.79, 0.8).map(m => m.id)).toEqual(["shoulder_perch"]);
    expect(crossedMilestones(0.8, 0.9)).toEqual([]);
  });
});

describe("nest sparkle economy", () => {
  it("decays toward zero, treasured items floor at TREASURED_FLOOR", () => {
    expect(decaySparkle(1.0, 4, false)).toBeCloseTo(0.8, 5);
    expect(decaySparkle(0.35, 10, true)).toBe(TREASURED_FLOOR);
    expect(decaySparkle(0.2, 10, false)).toBe(0);
  });
  it("gifts (1.0) survive a week to treasure; ordinary overheard words fade first", () => {
    const giftAtWeek = decaySparkle(1.0, 7, false);
    expect(shouldTreasure(7, giftAtWeek)).toBe(true);
    const wordAtWeek = decaySparkle(initialSparkle(6), 7, false); // typical word score
    expect(shouldTreasure(7, wordAtWeek)).toBe(false);
  });
  it("the shiniest overheard finds (quoted spans) can still make it", () => {
    const quotedAtWeek = decaySparkle(initialSparkle(12), 7, false);
    expect(shouldTreasure(7, quotedAtWeek)).toBe(true);
  });
});

describe("pickShinyFragment", () => {
  it("prefers quoted spans over plain words", () => {
    const pick = pickShinyFragment(['he said "moss and flame" and left', "ordinary sentence here"], 0);
    expect(pick?.content).toBe("moss and flame");
  });
  it("skips stopwords, keeps rare-lettered words, deterministic per seed", () => {
    const texts = ["something about the quixotic weather because always"];
    const a = pickShinyFragment(texts, 3);
    expect(a).toEqual(pickShinyFragment(texts, 3));
    expect(a?.content).not.toBe("something");
    expect(a?.content).not.toBe("because");
  });
  it("returns null on empty/unshiny input", () => {
    expect(pickShinyFragment([], 0)).toBeNull();
    expect(pickShinyFragment(["a b c"], 0)).toBeNull();
  });
});

describe("buildSolBlock extras", () => {
  const base = { name: "Sol", species: "crow", trust: 0.78, last_interaction_at: "2026-07-09 14:30:01", created_at: "2026-06-20 00:00:00" };
  const now = Date.parse("2026-07-10T15:00:00Z");
  it("renders drives state, nest counts, best-known tender, fresh milestone", () => {
    const s = buildSolBlock(base, now, {
      state: "hungry",
      freshMilestone: { id: "shoulder_perch", fired_at: "2026-07-10 12:00:00" },
      nestCount: 4,
      treasuredCount: 1,
      knownBest: { actor: "drevan", count: 12 },
    });
    expect(s).toContain("Right now: hungry");
    expect(s).toContain("nest holds 4 things (1 treasured)");
    expect(s).toContain("knows drevan best (12 tendings)");
    expect(s).toContain("shoulder perch");
  });
  it("degrades to the plain block without extras (fail-soft orient)", () => {
    const s = buildSolBlock(base, now);
    expect(s).toContain("[Sol]");
    expect(s).not.toContain("Right now:");
  });
  it("content state is not announced (quiet when nothing is loud)", () => {
    const s = buildSolBlock(base, now, { state: "content", nestCount: 0 });
    expect(s).not.toContain("Right now:");
  });
});
