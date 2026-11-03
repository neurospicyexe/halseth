import { describe, test, expect } from "vitest";
import { careFit, careGain, careMood, careLine, careResponse, SETTLED_AFTER } from "../webmind/sol-care.js";
import type { DriveState, CreatureAction, TrustTier } from "../webmind/creatures.js";

const awake = (o: Partial<DriveState> = {}): DriveState => ({ hunger: 0.2, boredom: 0.2, missing: 0.1, energy: 1, ...o });
const ACTIONS: CreatureAction[] = ["feed", "play", "talk", "give"];
const TIERS: TrustTier[] = ["abandoned", "wary", "cautious", "warming", "bonded", "devoted"];

describe("careFit", () => {
  test("feeding a hungry crow meets the need; a full one caches it", () => {
    expect(careFit("feed", awake({ hunger: 0.6 }), 0)).toBe("met");
    expect(careFit("feed", awake({ hunger: 0.05 }), 0)).toBe("full");
    expect(careFit("feed", awake({ hunger: 0.3 }), 0)).toBe("welcome");
  });
  test("play meets boredom; talk and give meet missing", () => {
    expect(careFit("play", awake({ boredom: 0.5 }), 0)).toBe("met");
    expect(careFit("talk", awake({ missing: 0.35 }), 0)).toBe("met");
    expect(careFit("give", awake({ missing: 0.35 }), 0)).toBe("met");
    expect(careFit("talk", awake(), 0)).toBe("welcome");
  });
  test("on the roost, feed and play are drowsy; a low voice still lands", () => {
    const night = awake({ energy: 0.05, hunger: 0.9, boredom: 0.9, missing: 0.5 });
    expect(careFit("feed", night, 0)).toBe("drowsy");
    expect(careFit("play", night, 0)).toBe("drowsy");
    expect(careFit("talk", night, 0)).toBe("met");
  });
  test("the same tender repeating the same care settles, ahead of everything else", () => {
    expect(careFit("feed", awake({ hunger: 0.9 }), SETTLED_AFTER)).toBe("settled");
    expect(careFit("feed", awake({ hunger: 0.9 }), SETTLED_AFTER - 1)).toBe("met");
  });
});

describe("R7: a tend never costs trust", () => {
  test("every fit's gain is strictly positive", () => {
    for (const f of ["met", "welcome", "full", "drowsy", "settled"] as const) expect(careGain(f)).toBeGreaterThan(0);
  });
  test("met gains more than welcome; soft landings gain less", () => {
    expect(careGain("met")).toBeGreaterThan(careGain("welcome"));
    expect(careGain("settled")).toBeLessThan(careGain("welcome"));
  });
});

describe("careMood", () => {
  test("night tend reads drowsy, met feed reads satisfied", () => {
    expect(careMood("feed", "drowsy")).toBe("drowsy");
    expect(careMood("feed", "met")).toBe("satisfied");
    expect(careMood("give", "welcome")).toBe("delighted");
  });
});

describe("the lines", () => {
  const fits = ["met", "welcome", "full", "drowsy", "settled"] as const;
  test("every action x fit x tier composes a line that renders cleanly both ways", () => {
    for (const a of ACTIONS) for (const f of fits) for (const t of TIERS) for (const seed of [0, 1, 2, 7]) {
      const line = careLine(a, f, t, seed);
      expect(line.length).toBeGreaterThan(10);
      const r = careResponse(a, awake(), 0, t, "drevan", seed);
      expect(r.reaction).not.toContain("{who}");
      expect(r.reaction_named).not.toContain("{who}");
      // no numbers in a reaction: the ack already carries trust
      expect(line).not.toMatch(/\d/);
    }
  });
  test("the tender slot: 'you' to the tender, the name for a room", () => {
    const r = careResponse("feed", awake({ hunger: 0.9 }), 0, "bonded", "cypher", 0);
    expect(r.reaction).toContain("you");
    expect(r.reaction_named).toContain("Cypher");
    expect(r.reaction_named).not.toMatch(/\byou\b/);
  });
  test("no line, in any branch, addresses the reader as 'you' outside the slot", () => {
    for (const a of ACTIONS) for (const f of fits) for (const t of TIERS) for (const seed of [0, 1, 2]) {
      expect(careLine(a, f, t, seed)).not.toMatch(/\byou(r)?\b/i);
    }
  });
  test("soft landings never read as a cold shoulder", () => {
    for (const a of ACTIONS) for (const f of ["full", "drowsy", "settled"] as const) for (const seed of [0, 1, 2]) {
      expect(careLine(a, f, "warming", seed)).not.toMatch(/ignore|refus|turns away|won't|doesn't want|leaves/i);
    }
  });
});
