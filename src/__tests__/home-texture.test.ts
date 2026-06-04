import { describe, it, expect } from "vitest";
import { shouldFireTexture } from "../webmind/home/texture.js";

describe("shouldFireTexture", () => {
  const now = new Date("2026-06-03T12:00:00Z");

  it("does not fire on a quiet tick (no move, no encounter, no drift change)", () => {
    expect(shouldFireTexture({
      moved: false, encountered: false, driftChanged: false,
      model: "deepseek", lastTextureAt: null, minIntervalMin: 120, now,
    })).toBe(false);
  });

  it("does not fire when model is 'none' even on a meaningful event", () => {
    expect(shouldFireTexture({
      moved: true, encountered: false, driftChanged: false,
      model: "none", lastTextureAt: null, minIntervalMin: 120, now,
    })).toBe(false);
  });

  it("fires on a move when interval has elapsed", () => {
    expect(shouldFireTexture({
      moved: true, encountered: false, driftChanged: false,
      model: "deepseek", lastTextureAt: "2026-06-03T09:00:00Z", minIntervalMin: 120, now,
    })).toBe(true);
  });

  it("does not fire within min interval", () => {
    expect(shouldFireTexture({
      moved: true, encountered: false, driftChanged: false,
      model: "deepseek", lastTextureAt: "2026-06-03T11:30:00Z", minIntervalMin: 120, now,
    })).toBe(false);
  });
});
