// B43 (2026-09-30): SimplyPlural retired. Front state has one source (src/front/source.ts) and,
// until the new plural app has an API, that source answers UNKNOWN. These pin the two ways the
// retired binding lied -- "No one is currently fronting." and an empty history -- and the three
// SimplyPlural writes that must now say nothing was written instead of failing somewhere else.

import { describe, it, expect } from "vitest";
import { readFront, readFrontHistory, NO_FRONT_SOURCE_REASON } from "../front/source.js";
import {
  execPluralGetCurrentFront, execPluralGetFrontHistory,
  execPluralUpdateMemberDescription, execPluralLogFrontChange, execPluralAddMemberNote,
} from "../librarian/executors/plural.js";
import { matchFastPath } from "../librarian/router.js";

const env: any = {};
const ctx = (request: string, pattern = "x", context?: unknown): any => ({
  env, req: { companion_id: "cypher", request, ...(context ? { context: JSON.stringify(context) } : {}) },
  entry: { pattern, response_key: "summary", triggers: [] }, frontState: null, pluralAvailable: false,
});

describe("the front source", () => {
  it("answers unknown with its reason, never a name", async () => {
    expect(await readFront(env)).toEqual({ status: "unknown", reason: NO_FRONT_SOURCE_REASON });
    expect(await readFrontHistory(env)).toEqual({ status: "unknown", reason: NO_FRONT_SOURCE_REASON });
  });
});

describe("who is fronting", () => {
  it("routes to the front read", () => {
    expect(matchFastPath("who is fronting")?.entry.tools).toEqual(["plural_get_current_front"]);
  });

  it("says unknown and why; never 'no one is fronting'", async () => {
    const r: any = await execPluralGetCurrentFront(ctx("who is fronting"));
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/no one is (currently )?fronting/i);
    expect(text).toContain("Front state unknown");
    expect(text).toContain("SimplyPlural was retired");
  });

  it("front history is an unknown witness, not an empty array", async () => {
    const r: any = await execPluralGetFrontHistory(ctx("front history"));
    expect(Array.isArray(r.data)).toBe(false);
    expect(r.status).toBe("unknown");
    expect(r.witness).toContain("unknown");
  });
});

describe("the retired SimplyPlural writes", () => {
  it.each([
    ["description", () => execPluralUpdateMemberDescription(ctx("update Ash's description to quiet and bright"))],
    ["front change", () => execPluralLogFrontChange(ctx("log front change", "x", { member_id: "m1", status: "fronting" }))],
    ["member note", () => execPluralAddMemberNote(ctx("add member note", "x", { member_id: "m1", note: "hi" }))],
  ])("%s: nothing written, and says so", async (_label, run) => {
    const r: any = await run();
    expect(r.ack).toBe(false);
    expect(r.witness).toMatch(/^nothing written/);
    expect(r.witness).toContain("log alter note");
  });
});
