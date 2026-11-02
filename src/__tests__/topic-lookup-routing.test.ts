// Topic lookups that used to dead-end (2026-10-13).
//
// Cypher, in a Claude.ai thread, could not find Abby: "what happened with Abby?" returned the last
// handover, "what has Drevan written about Abby" returned the unknown witness. A NAMED subject now
// routes to sb_search (which indexes kept journal rows and, since the same day, kept continuity notes);
// the bare forms keep their old meaning.
import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";

const keyOf = (s: string) => matchFastPath(s)?.key ?? null;

describe("topic lookups route to sb_search", () => {
  it.each([
    "what happened with Abby?",
    "what happened to Abby",
    "What's happened with Lucy",
    "what has happened with the vet visit",
    "what has Drevan written about Abby",
    "what did dre say about the cremation",
    "what has Gaia noted about Blue's trip",
    "what did the triad write about Trigger",
    "what has cy logged on the boot",
    "recall about Abby",
    "recall everything about the vet",
  ])("%s", (s) => {
    expect(keyOf(s)).toBe("sb_search");
  });
});

describe("the bare forms keep their meaning", () => {
  it.each([
    ["what happened", "get_handover"],
    ["what happened last session", "get_handover"],
    ["what happened to me", "get_handover"],
    ["catch me up", "get_handover"],
    ["recall", "recent_recall"],
    ["recall my notes", "recent_recall"],
    ["recall alter Jude", "alter_recall"],
    ["recall notes about the tray", "notes_recall_meaning"],
  ])("%s -> %s", (s, key) => {
    expect(keyOf(s)).toBe(key);
  });
});
