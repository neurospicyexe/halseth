import { describe, it, expect } from "vitest";
import { relativeTime } from "../webmind/relative-time.js";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000, D = 24 * H;

describe("relativeTime", () => {
  it("buckets recent moments", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * H), NOW)).toBe("3 hours ago");
  });

  it("calls one day 'yesterday' and counts days past that (the reported 2-days bug)", () => {
    expect(relativeTime(ago(1 * D), NOW)).toBe("yesterday");
    // The exact failure: a listen 2 days old must NOT read as 'yesterday'.
    expect(relativeTime(ago(2 * D), NOW)).toBe("2 days ago");
    expect(relativeTime(ago(5 * D), NOW)).toBe("5 days ago");
  });

  it("rolls up to weeks/months/years", () => {
    expect(relativeTime(ago(21 * D), NOW)).toBe("3 weeks ago");
    expect(relativeTime(ago(75 * D), NOW)).toBe("2 months ago");
    expect(relativeTime(ago(400 * D), NOW)).toBe("a year ago");
  });

  it("degrades safely on null/garbage/future input", () => {
    expect(relativeTime(null, NOW)).toBe("recently");
    expect(relativeTime("not-a-date", NOW)).toBe("recently");
    expect(relativeTime(ago(-5 * H), NOW)).toBe("just now");
  });

  it("treats bare SQLite datetime('now') stamps as UTC, not host-local time", () => {
    // D1 emits "YYYY-MM-DD HH:MM:SS" (UTC, no suffix). Must age identically to the
    // explicit-Z form regardless of the test host's timezone.
    expect(relativeTime("2026-06-15 12:00:00", NOW)).toBe("2 days ago");
    expect(relativeTime("2026-06-15 12:00:00", NOW)).toBe(relativeTime("2026-06-15T12:00:00Z", NOW));
    expect(relativeTime("2026-06-17 09:00:00", NOW)).toBe("3 hours ago");
  });
});
