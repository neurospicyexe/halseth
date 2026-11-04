// src/__tests__/note-route-anchor.test.ts
// H7b (2026-11-04): an addressed note is routed by its head. Before the guard, the substring sweep ran
// first-match in insertion order and a note body naming "Sol's hoard" became a nest read; the note was
// never sent and nothing said so.
import { describe, test, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";

const NOTE = "companion" + "_note_add";

describe("addressed notes route by their head", () => {
  test.each([
    "note to Drevan: Iris feeds the crow; Sol's hoard keeps the make",
    "note for gaia: check the nest when you can",
    "tell cypher: what's in the nest is fine",
    "please note to drevan: my ledger has three lines",
    "leave a note for Drevan: sols hoard grew",
    "write to gaia: the book note landed",
  ])("%s", (req) => {
    expect(matchFastPath(req)?.key).toBe(NOTE);
  });

  test("a nest read with no note head is still a nest read", () => {
    expect(matchFastPath("what's in the nest")?.key).toBe("nest_view");
    expect(matchFastPath("show me sol's hoard")?.key).toBe("nest_view");
  });

  test("a name later in the line does not make a note (the head decides)", () => {
    expect(matchFastPath("check the nest for drevan")?.key).toBe("nest_view");
  });
});
