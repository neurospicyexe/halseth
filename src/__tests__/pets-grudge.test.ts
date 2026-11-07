import { describe, it, expect } from "vitest";
import {
  stepGrudge, expired, grudgeLabel, grudgeUnit, GRUDGE_MAX_HOURS,
  type OpenGrudge, type Resolution,
} from "../pets/grudge.js";
import type { ActiveQuirk } from "../pets/appraise.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const quirk: ActiveQuirk = { id: "q1", kind: "aversion", trigger: { action: "play" }, target_actor: null };

function open(over: Partial<OpenGrudge> = {}): OpenGrudge {
  return {
    id: "g1", quirk_id: "q1", actor: "raziel", label: "still sore about being poked",
    resolution: { kind: "visits", n: 2 }, progress: 0, opened_at: new Date(T0).toISOString(), ...over,
  };
}
const ev = (over: Record<string, unknown> = {}) => ({
  actor: "raziel", action: "feed" as const, friction: false, matchedAversion: null,
  quirkTitle: null, quirkResolution: null, nowMs: T0 + H, ...over,
});

describe("grudgeLabel", () => {
  it("lowercases and prefixes", () => {
    expect(grudgeLabel("Being Poked")).toBe("still sore about being poked");
  });
  it("caps at 60 chars with no trailing space", () => {
    const l = grudgeLabel("a ".repeat(60));
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l).toBe(l.trimEnd());
  });
});

describe("stepGrudge", () => {
  it("opens on aversion hit with no open grudge", () => {
    const r: Resolution = { kind: "item", action: "give", n: 1 };
    const s = stepGrudge(null, ev({ friction: true, matchedAversion: quirk, quirkTitle: "Being Poked", quirkResolution: r }));
    expect(s).toEqual({ kind: "open", quirk_id: "q1", label: "still sore about being poked", resolution: r });
  });
  it("defaults to visits n=2 when no resolution", () => {
    const s = stepGrudge(null, ev({ friction: true, matchedAversion: quirk, quirkTitle: "X" }));
    expect(s).toMatchObject({ kind: "open", resolution: { kind: "visits", n: 2 } });
  });
  it("no open, no aversion -> none", () => {
    expect(stepGrudge(null, ev())).toEqual({ kind: "none" });
  });
  it("open + friction from same actor -> none, never a second grudge", () => {
    expect(stepGrudge(open(), ev({ friction: true, matchedAversion: quirk, quirkTitle: "X" }))).toEqual({ kind: "none" });
  });
  it("visits n=2: progress 1 then resolve met", () => {
    expect(stepGrudge(open(), ev())).toEqual({ kind: "progress", progress: 1 });
    expect(stepGrudge(open({ progress: 1 }), ev())).toEqual({ kind: "resolve", how: "met" });
  });
  it("visits by does not widen who counts (other actor still none)", () => {
    const o = open({ resolution: { kind: "visits", n: 1, by: "blue" } });
    expect(stepGrudge(o, ev({ actor: "blue" }))).toEqual({ kind: "none" });
    expect(stepGrudge(o, ev())).toEqual({ kind: "resolve", how: "met" });
  });
  it("different actor never progresses another's grudge", () => {
    expect(stepGrudge(open(), ev({ actor: "blue" }))).toEqual({ kind: "none" });
  });
  it("item counts only the named action", () => {
    const o = open({ resolution: { kind: "item", action: "give", n: 1 } });
    expect(stepGrudge(o, ev({ action: "feed" }))).toEqual({ kind: "none" });
    expect(stepGrudge(o, ev({ action: "give" }))).toEqual({ kind: "resolve", how: "met" });
  });
  it("quiet resolves on a tend after the quiet hours, not before", () => {
    const o = open({ resolution: { kind: "quiet", hours: 24 } });
    expect(stepGrudge(o, ev({ nowMs: T0 + 10 * H }))).toEqual({ kind: "none" });
    expect(stepGrudge(o, ev({ nowMs: T0 + 24 * H }))).toEqual({ kind: "resolve", how: "met" });
  });
  it("time never resolves by a tend", () => {
    const o = open({ resolution: { kind: "time", hours: 48 } });
    expect(stepGrudge(o, ev({ nowMs: T0 + 10 * H }))).toEqual({ kind: "none" });
  });
  it("time resolves by expiry at min(hours, 72)", () => {
    const o = open({ resolution: { kind: "time", hours: 24 } });
    expect(stepGrudge(o, ev({ nowMs: T0 + 24 * H }))).toEqual({ kind: "resolve", how: "time" });
  });
  it("expired at 72h regardless of event, even friction/other actor", () => {
    const o = open();
    expect(expired(o, T0 + GRUDGE_MAX_HOURS * H - 1)).toBe(false);
    expect(expired(o, T0 + GRUDGE_MAX_HOURS * H)).toBe(true);
    expect(stepGrudge(o, ev({ nowMs: T0 + 72 * H, friction: true, matchedAversion: quirk }))).toEqual({ kind: "resolve", how: "time" });
    expect(stepGrudge(o, ev({ nowMs: T0 + 80 * H, actor: "blue" }))).toEqual({ kind: "resolve", how: "time" });
  });
  it("review focus 3: two tends progress once each; the 72h one resolves time first", () => {
    let o = open({ resolution: { kind: "visits", n: 3 } });
    const s1 = stepGrudge(o, ev({ nowMs: T0 + 1 * H }));
    expect(s1).toEqual({ kind: "progress", progress: 1 });
    o = { ...o, progress: 1 };
    const s2 = stepGrudge(o, ev({ nowMs: T0 + 2 * H }));
    expect(s2).toEqual({ kind: "progress", progress: 2 });
    o = { ...o, progress: 2 };
    expect(stepGrudge(o, ev({ nowMs: T0 + 72 * H }))).toEqual({ kind: "resolve", how: "time" });
  });
});

// ── Task 4 additions ─────────────────────────────────────────────────────────
import { sulkLine, makeUpLine, grudgeProgress, SULK_LINES, MAKE_UP_LINES } from "../pets/grudge.js";

describe("expired: fails toward resolving", () => {
  it("a non-finite opened_at reads as expired (never a stuck grudge)", () => {
    expect(expired(open({ opened_at: "not a date" }), T0)).toBe(true);
    expect(expired(open({ opened_at: "" }), T0)).toBe(true);
  });
  it("time.hours below 1 is clamped to 1", () => {
    const o = open({ resolution: { kind: "time", hours: 0 } });
    expect(expired(o, T0 + 1)).toBe(false);
    expect(expired(o, T0 + H)).toBe(true);
    const neg = open({ resolution: { kind: "time", hours: -5 } });
    expect(expired(neg, T0 + 10)).toBe(false);
  });
  it("a D1 'YYYY-MM-DD HH:MM:SS' opened_at is read as UTC", () => {
    const o = open({ opened_at: "2026-11-06 12:00:00" });
    expect(expired(o, T0 + 72 * H - 1)).toBe(false);
    expect(expired(o, T0 + 72 * H)).toBe(true);
  });
});

describe("grudgeProgress", () => {
  it("visits/item: progress of n", () => {
    expect(grudgeProgress(open({ progress: 1 }), T0)).toEqual({ progress: 1, of: 2 });
    expect(grudgeProgress(open({ resolution: { kind: "item", action: "give", n: 3 } }), T0)).toEqual({ progress: 0, of: 3 });
  });
  it("quiet/time: whole hours since opened, capped at hours (and at 72)", () => {
    const q = open({ resolution: { kind: "quiet", hours: 24 } });
    expect(grudgeProgress(q, T0 + 5.5 * H)).toEqual({ progress: 5, of: 24 });
    expect(grudgeProgress(q, T0 + 40 * H)).toEqual({ progress: 24, of: 24 });
    expect(grudgeProgress(q, T0 - 3 * H)).toEqual({ progress: 0, of: 24 });
    const t = open({ resolution: { kind: "time", hours: 500 } });
    expect(grudgeProgress(t, T0 + 2 * H)).toEqual({ progress: 2, of: 72 });
  });
});

describe("sulk + make-up lines", () => {
  const all = [...SULK_LINES.low, ...SULK_LINES.mid, ...SULK_LINES.high, ...MAKE_UP_LINES];
  it("3 per tier group, 2 make-up", () => {
    for (const g of ["low", "mid", "high"] as const) expect(SULK_LINES[g]).toHaveLength(3);
    expect(MAKE_UP_LINES).toHaveLength(2);
  });
  it("every line: italic, {who} slot, no digits, no double quote, <= 220", () => {
    for (const l of all) {
      expect(l.startsWith("*")).toBe(true);
      expect(l.endsWith("*")).toBe(true);
      expect(l).toContain("{who}");
      expect(l).not.toMatch(/\d/);
      expect(l).not.toContain('"');
      expect(l.length).toBeLessThanOrEqual(220);
    }
  });
  it("picks deterministically from the tier group's pool", () => {
    expect(SULK_LINES.mid).toContain(sulkLine("mid", 7));
    expect(sulkLine("mid", 7)).toBe(sulkLine("mid", 7));
    expect(MAKE_UP_LINES).toContain(makeUpLine(3));
  });
});

describe("grudgeUnit (R29)", () => {
  it("names what the count counts", () => {
    expect(grudgeUnit({ kind: "visits", n: 2 })).toBe("visits");
    expect(grudgeUnit({ kind: "item", action: "give", n: 1 })).toBe("gives");
    expect(grudgeUnit({ kind: "item", action: "feed", n: 1 })).toBe("feeds");
    expect(grudgeUnit({ kind: "quiet", hours: 12 })).toBe("hours");
    expect(grudgeUnit({ kind: "time", hours: 24 })).toBe("hours");
  });
});
