// Tests for the [Commons] orient block builder (write layer, 0092). The framing is
// load-bearing: posts must read as AMBIENT drops, never directives/questions.

import { describe, it, expect } from "vitest";
import { buildCommonsBlock } from "../webmind/commons-block.js";

describe("buildCommonsBlock", () => {
  it("returns empty string for no posts (caller concatenates unconditionally)", () => {
    expect(buildCommonsBlock([])).toBe("");
  });

  it("frames posts as ambient, not as a reply-demanding question", () => {
    const block = buildCommonsBlock([
      { id: "1", context: "global", body: "the dialectic finally has tensions", created_at: "2026-06-26 10:00:00" },
    ]);
    expect(block).toContain("[Commons]");
    expect(block).toContain("ambient");
    expect(block).toContain("NOT a question demanding a reply");
    expect(block).toContain("the dialectic finally has tensions");
  });

  it("labels club/shelf context so the companion knows where a note lives", () => {
    const block = buildCommonsBlock([
      { id: "1", context: "club:r1", body: "loved the pick", created_at: "2026-06-26 10:00:00" },
      { id: "2", context: "shelf:s1", body: "rewatching it", created_at: "2026-06-26 11:00:00" },
      { id: "3", context: "global", body: "stray thought", created_at: "2026-06-26 12:00:00" },
    ]);
    expect(block).toContain("club round");
    expect(block).toContain("currently into");
    // a global note carries no context suffix
    expect(block).toMatch(/«stray thought»\s*$/m);
  });

  it("pluralizes the count", () => {
    const one = buildCommonsBlock([{ id: "1", context: "global", body: "a", created_at: "t" }]);
    expect(one).toContain("a note");
    const two = buildCommonsBlock([
      { id: "1", context: "global", body: "a", created_at: "t1" },
      { id: "2", context: "global", body: "b", created_at: "t2" },
    ]);
    expect(two).toContain("2 notes");
  });
});
