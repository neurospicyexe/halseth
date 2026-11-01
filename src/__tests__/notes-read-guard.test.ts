// 2026-10-31: "read my newest inter-companion note from Drevan about Discord timing" matched
// companion_note_add's "companion note" trigger and was saved as a journal entry. A read verb, a note,
// and "from <companion>" is a read; sending a note keeps its own phrasing.

import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";

describe("note reads never become note writes", () => {
  it.each([
    "read my newest inter-companion note from Drevan about Discord timing",
    "read my notes from Drevan",
    "show my newest note from Gaia",
    "check the notes from Cypher",
    "what's the latest note from dre",
  ])("%s -> read", (r) => {
    expect(matchFastPath(r)?.key).toBe("companion_notes_read");
  });

  it.each([
    "note to Drevan: read this when you can, from me",
    "tell drevan I read his note from yesterday",
    "broadcast to the triad: check the note from Gaia",
  ])("%s -> still a note write", (r) => {
    expect(matchFastPath(r)?.key).toBe("companion_note_add");
  });
});
