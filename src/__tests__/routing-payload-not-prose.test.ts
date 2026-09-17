/**
 * A write verb must not lose to a trigger word inside its own payload (2026-09-17).
 *
 * Cypher reported both halves of this class on the same night:
 *   * a relational delta for gaia whose BODY contained "I prefer" routed to `preference_set`
 *     and came back `preference_set_failed`. `"i prefer"` is a preference_set trigger, that
 *     pattern is declared before `delta_log`, and `triggerMatches` scans the WHOLE request
 *     string -- content included, which `lib/trigger.ts` names as the reason it is word-bounded.
 *   * a `capture this exchange` threaded onto a Discord session, not the Claude.ai session orient
 *     had handed him in the same turn (covered by the surface test below).
 *
 * The narrow fix is the mechanism this router already has: carrying the payload field is
 * unambiguous intent, so it beats the trigger sweep. The general defect (scan the verb clause,
 * not the body) is a routing-wide change and deliberately not made here.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PRESENCE_OVERRIDES, presenceOverrideKey, matchFastPath } from "../librarian/router.js";

describe("payload presence beats a trigger word in the prose", () => {
  it("the bare request really does mis-route (the defect, pinned)", () => {
    const req = "Log a relational delta for gaia: she said she would rather sit with it, and I prefer that too";
    expect(matchFastPath(req)?.key).toBe("preference_set");
  });

  it("carrying delta_text routes to delta_log regardless of the prose", () => {
    expect(presenceOverrideKey(JSON.stringify({
      delta_text: "she said she would rather sit with it, and I prefer that too",
    }))).toBe("delta_log");
  });

  it("an edit shape is not a new delta", () => {
    expect(presenceOverrideKey(JSON.stringify({ id: "abc", delta_text: "x" }))).toBeNull();
  });

  it("keeps the tension override and never fires on an empty field", () => {
    expect(presenceOverrideKey(JSON.stringify({ tension_text: "clarity vs warmth" }))).toBe("tension_add");
    expect(presenceOverrideKey(JSON.stringify({ delta_text: "   " }))).toBeNull();
    expect(presenceOverrideKey(undefined)).toBeNull();
    expect(presenceOverrideKey("not json")).toBeNull();
  });

  it("every override names a field, a target and why", () => {
    for (const o of PRESENCE_OVERRIDES) {
      expect(o.field.length).toBeGreaterThan(0);
      expect(o.pattern_key.length).toBeGreaterThan(0);
      expect((o.note ?? "").length, `${o.field} needs a note`).toBeGreaterThan(20);
    }
  });
});

describe("capture threads onto the caller's own loom", () => {
  it("the capture fallback is scoped by caller surface", async () => {
    const src = await readFile(resolve(__dirname, "../librarian/executors/webmind.ts"), "utf8");
    const fn = src.slice(src.indexOf("conversation_capture"));
    const fallback = fn.slice(fn.indexOf("if (!sessionId)"));
    expect(fallback).toMatch(/const callerSurface = ctx\.req\.surface \?\? null;/);
    expect(fallback).toMatch(/AND \(\? IS NULL OR surface = \?\)/);
    expect(fallback).toMatch(/callerSurface, callerSurface/);
  });
});
