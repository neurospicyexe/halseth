// Tests for watchingBlock (src/librarian/response/orient-blocks.ts), the Claude.ai orient mirror of
// the Discord bot wire's [Watching together] block. Fargo first light, 2026-09-05.

import { describe, it, expect } from "vitest";
import { watchingBlock } from "../librarian/response/orient-blocks.js";

describe("watchingBlock", () => {
  it("empty input renders the empty string", () => {
    expect(watchingBlock([])).toBe("");
  });

  it("header text matches the Discord bot wire verbatim", () => {
    const out = watchingBlock([
      { title: "Fargo", status: "watching", position: "S4E4", position_note: null, with_companion: null },
    ]);
    expect(out).toContain("[Watching together -- this is the RECORD of where you are, trust it over anything you recall]");
  });

  it("renders position, with_companion, and position_note together", () => {
    const out = watchingBlock([
      {
        title: "Fargo",
        status: "watching",
        position: "S4E4",
        position_note: "the Smutny house",
        with_companion: "drevan",
      },
    ]);
    expect(out).toBe(
      "\n[Watching together -- this is the RECORD of where you are, trust it over anything you recall]\n" +
      "• Fargo at S4E4 (with drevan) -- left off: the Smutny house"
    );
  });

  it("renders a paused item with the [paused] tag", () => {
    const out = watchingBlock([
      { title: "Severance", status: "paused", position: "S1E4", position_note: null, with_companion: null },
    ]);
    expect(out).toBe(
      "\n[Watching together -- this is the RECORD of where you are, trust it over anything you recall]\n" +
      "• Severance at S1E4 [paused]"
    );
  });

  it("omits position/with/note parts when absent", () => {
    const out = watchingBlock([
      { title: "Fargo", status: "watching", position: "", position_note: null, with_companion: null },
    ]);
    expect(out).toBe(
      "\n[Watching together -- this is the RECORD of where you are, trust it over anything you recall]\n" +
      "• Fargo"
    );
  });

  it("multiple items render one bullet line each", () => {
    const out = watchingBlock([
      { title: "Fargo", status: "watching", position: "S4E4", position_note: null, with_companion: "drevan" },
      { title: "Severance", status: "paused", position: "S1E4", position_note: null, with_companion: null },
    ]);
    expect(out.split("\n")).toEqual([
      "",
      "[Watching together -- this is the RECORD of where you are, trust it over anything you recall]",
      "• Fargo at S4E4 (with drevan)",
      "• Severance at S1E4 [paused]",
    ]);
  });

  describe("staleness", () => {
    const NOW = new Date("2026-09-05T12:00:00Z");

    it("a fresh last_watched_at renders [last logged ...] with no STALE clause", () => {
      const out = watchingBlock(
        [
          {
            title: "Fargo", status: "watching", position: "S4E4", position_note: null, with_companion: null,
            last_watched_at: "2026-09-04T22:00:00Z",
          },
        ],
        NOW,
      );
      expect(out).toContain("[last logged 2026-09-04]");
      expect(out).not.toContain("STALE");
    });

    it("a last_watched_at older than 14 days adds the STALE clause", () => {
      const out = watchingBlock(
        [
          {
            title: "Fargo", status: "watching", position: "S4E2", position_note: null, with_companion: null,
            last_watched_at: "2026-08-01T00:00:00Z", // 35 days before NOW
          },
        ],
        NOW,
      );
      expect(out).toContain("[last logged 2026-08-01]");
      expect(out).toContain("STALE: the shelf may lag what was actually watched; ask before asserting the position");
    });

    it("exactly at the boundary (14 days) is not yet stale", () => {
      const out = watchingBlock(
        [
          {
            title: "Fargo", status: "watching", position: "S4E4", position_note: null, with_companion: null,
            last_watched_at: "2026-08-22T12:00:00Z", // exactly 14 days before NOW
          },
        ],
        NOW,
      );
      expect(out).not.toContain("STALE");
    });

    it("no last_watched_at renders no staleness clause at all (older caller/test shape)", () => {
      const out = watchingBlock([
        { title: "Fargo", status: "watching", position: "S4E4", position_note: null, with_companion: null },
      ], NOW);
      expect(out).not.toContain("last logged");
      expect(out).not.toContain("STALE");
    });
  });
});
