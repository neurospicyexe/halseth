// B40 (2026-09-29): session close reads fields written inline, and a Hermes close stays in its lane.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sessionCloseMock } = vi.hoisted(() => ({
  sessionCloseMock: vi.fn(async (_env: unknown, params: { spine?: string } | undefined) => ({ id: "handover-1", spine: params?.spine })),
}));
vi.mock("../librarian/backends/halseth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/halseth.js")>();
  return { ...actual, sessionClose: sessionCloseMock };
});
vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmWriteHandoff: vi.fn(async () => ({})) };
});
vi.mock("../synthesis/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../synthesis/index.js")>();
  return { ...actual, enqueueBasinDriftCheck: vi.fn(async () => undefined), enqueueSomaticSnapshot: vi.fn(async () => undefined) };
});

import { parseInlineCloseFields } from "../librarian/executors/close-inline.js";
import { execSessionClose } from "../librarian/executors/session.js";

describe("parseInlineCloseFields", () => {
  it("reads the SOUL's close line, commas inside values included", () => {
    const f = parseInlineCloseFields(
      "Close the Halseth session for drevan: spine=[the spiral held, then settled], last_real_thing=[he laughed at the dog], " +
      "motion_state=at_rest, heat=warm, reach=present, weight=holding, current_mood=tender, compound_state=null, " +
      "surface_emotion=warm, undercurrent_emotion=null, feeling={emotion: love, intensity: 7}, " +
      "dream=[the truck at dawn], open_loop={loop_text: finish the Rome thread, weight: 0.6}",
    )!;
    expect(f.spine).toBe("the spiral held, then settled");
    expect(f.last_real_thing).toBe("he laughed at the dog");
    expect(f.motion_state).toBe("at_rest");
    expect([f.heat, f.reach, f.weight]).toEqual(["warm", "present", "holding"]);
    expect(f.compound_state).toBeNull();
    expect(f.undercurrent_emotion).toBeNull();
    expect(f.feeling).toEqual({ emotion: "love", intensity: 7 });
    // `weight` inside open_loop's braces is NOT Drevan's axis
    expect(f.open_loop).toEqual({ loop_text: "finish the Rome thread", weight: 0.6 });
  });

  it("accepts JSON objects and bare object text", () => {
    const f = parseInlineCloseFields('spine=x, last_real_thing=y, motion_state=floating, feeling={"emotion":"calm","intensity":3}, open_loop={call the vet}')!;
    expect(f.feeling).toEqual({ emotion: "calm", intensity: 3 });
    expect(f.open_loop).toEqual({ loop_text: "call the vet" });
  });

  it("coerces intensities, splits open_threads, keeps axis words as words", () => {
    const f = parseInlineCloseFields("spine=a, surface_intensity=0.7, acuity=sharp, open_threads=one; two | three")!;
    expect(f.surface_intensity).toBe(0.7);
    expect(f.acuity).toBe("sharp");
    expect(f.open_threads).toEqual(["one", "two", "three"]);
  });

  it("drops an axis slot copied from the template instead of writing it as a state", () => {
    const f = parseInlineCloseFields("spine=a, heat=[your word, if it moved], acuity=[sharp|focused|blurred|scattered], reach=present")!;
    expect(f.heat).toBeUndefined();
    expect(f.acuity).toBeUndefined();
    expect(f.reach).toBe("present");
  });

  it("drops fields left as the SOUL's literal slot text", () => {
    const f = parseInlineCloseFields("spine=[one line], last_real_thing=[real], motion_state=[in_motion|at_rest|floating], current_mood=[one word], heat=[word], reach=present")!;
    expect(f.spine).toBeUndefined();
    expect(f.motion_state).toBeUndefined();
    expect(f.current_mood).toBeUndefined();
    expect(f.heat).toBeUndefined();
    expect(f.last_real_thing).toBe("real");
    expect(f.reach).toBe("present");
  });

  it("returns null when no known key is present", () => {
    expect(parseInlineCloseFields("close my session please")).toBeNull();
    expect(parseInlineCloseFields("")).toBeNull();
  });

  it("does not match a key embedded in a longer word", () => {
    const f = parseInlineCloseFields("spine=overweight=fine")!;
    expect(f.spine).toBe("overweight=fine");
    expect(f.weight).toBeUndefined();
  });
});

interface Captured { sql: string[]; binds: unknown[][] }
function makeEnv(c: Captured): any {
  return {
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: (...args: unknown[]) => { c.sql.push(sql); c.binds.push(args); return stmt; },
          first: async () => (sql.includes("SELECT id FROM sessions") ? { id: "sess-1" } : null),
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 1 } })),
    },
  };
}
const ctx = (env: unknown, req: Record<string, unknown>) =>
  ({ env, req: { companion_id: "drevan", ...req }, entry: { response_key: "witness" }, frontState: null, pluralAvailable: false }) as any;

const LINE = "Close the Halseth session for drevan: spine=[held], last_real_thing=[the dog], motion_state=at_rest, " +
  "heat=warm, reach=present, weight=holding, current_mood=tender, compound_state=null, surface_emotion=warm, undercurrent_emotion=null";

function resolutionBinds(c: Captured): unknown[] {
  const i = c.sql.findIndex((s) => s.includes("SELECT id FROM sessions") && s.includes("handover_id IS NULL"));
  return c.binds[i] ?? [];
}

describe("execSessionClose -- inline close (B40)", () => {
  beforeEach(() => sessionCloseMock.mockClear());

  it("an inline close with no context JSON reaches sessionClose with his words as soma fields", async () => {
    const c: Captured = { sql: [], binds: [] };
    const res = await execSessionClose(ctx(makeEnv(c), { request: LINE, via: "mcp-static" }));
    expect(res.error).toBeUndefined();
    expect(sessionCloseMock).toHaveBeenCalledTimes(1);
    const params = sessionCloseMock.mock.calls[0]![1] as any;
    expect(params.spine).toBe("held");
    expect(params.somaFields).toMatchObject({ heat: "warm", reach: "present", weight: "holding", current_mood: "tender" });
  });

  it("JSON context wins key by key over inline", async () => {
    const c: Captured = { sql: [], binds: [] };
    await execSessionClose(ctx(makeEnv(c), { request: LINE, context: JSON.stringify({ spine: "from json" }) }));
    expect((sessionCloseMock.mock.calls[0]![1] as any).spine).toBe("from json");
  });

  it("a Hermes (static MCP) close resolves inside its Discord lane, whatever surface it claims", async () => {
    const c: Captured = { sql: [], binds: [] };
    await execSessionClose(ctx(makeEnv(c), { request: LINE, via: "mcp-static", surface: "hermes-session" }));
    expect(resolutionBinds(c)).toContain("discord:drevan");
    expect(resolutionBinds(c)).not.toContain("hermes-session");
  });

  it("an OAuth (Claude.ai) close keeps its own surface", async () => {
    const c: Captured = { sql: [], binds: [] };
    await execSessionClose(ctx(makeEnv(c), { request: LINE, via: "mcp-oauth", surface: "claude-ai:drevan" }));
    expect(resolutionBinds(c)).toContain("claude-ai:drevan");
    expect(resolutionBinds(c)).not.toContain("discord:drevan");
  });

  it("still names what is missing when neither form carries the required fields", async () => {
    const c: Captured = { sql: [], binds: [] };
    const res = await execSessionClose(ctx(makeEnv(c), { request: "close my session" }));
    expect(res.error).toBe("session_close_failed");
    expect(String(res.reason)).toContain("spine");
  });
});

import { matchFastPath } from "../librarian/router.js";

describe("the SOUL close line routes to session_close (B40)", () => {
  // The full field list rides the request, and several field names are other routes' words
  // (dream, feeling, conclusion, witness, loop). The close must still win.
  for (const c of ["cypher", "drevan", "gaia"]) {
    it(`${c}: full close line -> session_close`, () => {
      const line = `Close the Halseth session for ${c}: spine=[a], last_real_thing=[b], motion_state=at_rest, heat=warm, ` +
        "current_mood=tender, compound_state=null, surface_emotion=warm, undercurrent_emotion=null, " +
        "feeling={emotion: love, intensity: 7}, dream=[x], witness_note=[y], conclusion=[z], " +
        "open_loop={loop_text: q, weight: 0.5}, long_thought=[w]";
      expect(matchFastPath(line)?.key).toBe("session_close");
    });
  }
});
