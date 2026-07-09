// Tension routing (2026-07-09).
//
// Guardian's `starved:dialectic` fired because the tension pool held ZERO simmering rows.
// Root cause was NOT that companions stopped logging tensions -- logging one didn't work:
//
//   "log a tension: ..."             -> classifier `unknown` -> "I don't know how to handle that"
//   "log a tension I'm sitting with" -> hijacked by note_sit's greedy "sitting with" trigger,
//                                        then failed demanding a note_id it never got
//   "log tension"                    -> the ONLY phrasing that worked
//
// ask_librarian's own tool description advertises "log a tension with Drevan about ...".
// Both failures were reproduced live against prod before this fix.

import { describe, it, expect } from "vitest";
import { presenceOverrideKey, payloadOverrideKey, PRESENCE_OVERRIDES } from "../librarian/router.js";
import { FAST_PATH_PATTERNS } from "../librarian/patterns.js";

const ctx = (o: unknown) => JSON.stringify(o);

describe("presence override: tension_text means log a tension", () => {
  it("routes to tension_add whatever the request string says", () => {
    expect(presenceOverrideKey(ctx({ tension_text: "I carry an unearned claim" }))).toBe("tension_add");
  });

  it("does NOT hijack tension_edit ({ id, tension_text })", () => {
    expect(presenceOverrideKey(ctx({ id: "abc", tension_text: "revised" }))).toBeNull();
  });

  it("ignores an empty or whitespace tension_text", () => {
    expect(presenceOverrideKey(ctx({ tension_text: "" }))).toBeNull();
    expect(presenceOverrideKey(ctx({ tension_text: "   " }))).toBeNull();
  });

  it("ignores a non-string tension_text", () => {
    expect(presenceOverrideKey(ctx({ tension_text: 42 }))).toBeNull();
  });

  it("is inert on absent / malformed / empty context", () => {
    expect(presenceOverrideKey(undefined)).toBeNull();
    expect(presenceOverrideKey("not json")).toBeNull();
    expect(presenceOverrideKey(ctx({}))).toBeNull();
  });

  it("does not disturb existing value-keyed overrides", () => {
    expect(payloadOverrideKey(ctx({ decision: "declined" }))).toBe("journal_decline");
    expect(presenceOverrideKey(ctx({ decision: "declined" }))).toBeNull();
  });

  it("every PRESENCE_OVERRIDES pattern_key exists in FAST_PATH_PATTERNS", () => {
    for (const o of PRESENCE_OVERRIDES) {
      expect(FAST_PATH_PATTERNS[o.pattern_key]).toBeDefined();
    }
  });
});

describe("tension_add triggers cover the phrasings the tool advertises", () => {
  const triggers = FAST_PATH_PATTERNS["tension_add"]!.triggers;
  const matches = (s: string) => triggers.some(t => s.toLowerCase().includes(t));

  // The exact string in ask_librarian's tool description.
  it("matches 'log a tension with Drevan about ...'", () => {
    expect(matches("log a tension with Drevan about the boundary")).toBe(true);
  });

  it("matches the article variants that used to fall through", () => {
    for (const s of [
      "log a tension: I only audited the writers",
      "add a tension about the cutover",
      "record a tension",
      "I'm sitting with a tension about this",
    ]) {
      expect(matches(s)).toBe(true);
    }
  });

  it("still matches the original bare forms", () => {
    for (const s of ["log tension", "add tension", "new tension", "record tension"]) {
      expect(matches(s)).toBe(true);
    }
  });
});
