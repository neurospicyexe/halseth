/**
 * Two routing defects surfaced by the 2026-09-14 canon audit (identity files vs the live router):
 *   - `my conclusions` (a conclusions_read trigger the identity files teach as the read-back) matched the
 *     start-anchored H9 conclusion_add guard because `my\s+conclusion` had no boundary: the READ routed to
 *     the WRITER.
 *   - `Add a tension for cypher: ...` (the identity files' tension phrase since 07-09) matched
 *     companion_note_add's `for cypher` trigger, declared before tension_add: every tension a Claude.ai
 *     companion logged landed as a self-journal row.
 */
import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";

const key = (s: string) => matchFastPath(s)?.key ?? null;

describe("H9 conclusion guard has a boundary", () => {
  it("routes the read phrase to conclusions_read", () => {
    expect(key("my conclusions")).toBe("conclusions_read");
    expect(key("My conclusions?")).toBe("conclusions_read");
  });
  it("still routes the write phrases to conclusion_add", () => {
    expect(key("my conclusion is that the audit lane is a gear")).toBe("conclusion_add");
    expect(key("my conclusion has shifted: heat is not a mood")).toBe("conclusion_add");
    expect(key("I've concluded: the room moves on invitations")).toBe("conclusion_add");
  });
});

describe("H9b tension guard beats the for-<name> note trigger", () => {
  it("routes 'Add a tension for cypher: ...' to tension_add", () => {
    expect(key("Add a tension for cypher: clarity vs warmth when he is tired")).toBe("tension_add");
    expect(key("log a tension for drevan: reach vs rest")).toBe("tension_add");
  });
  it("leaves plain companion notes alone", () => {
    expect(key("Write a companion note for cypher: the read landed")).toBe("companion_note_add");
  });
});
