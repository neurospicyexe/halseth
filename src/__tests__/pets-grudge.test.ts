import { describe, it, expect } from "vitest";
import {
  stepGrudge, expired, grudgeLabel, GRUDGE_MAX_HOURS,
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
