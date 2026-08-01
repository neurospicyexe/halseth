// Handoff provenance: a machine consolidation must not read as a conversation (2026-08-01).
//
// `consolidateSession` runs on idle and wrote handoffs indistinguishable from a real session close --
// same source='system', same actor='agent'. Because it fires whenever a channel goes quiet, the most
// recent handoff was almost always this one, so "last session" at orient meant a model's summary of an
// idle window rather than an actual conversation with Raziel. Overnight 2026-07-31 it produced one every
// ~2h05 ("a quiet session with no blade drawn"), so their sense of when they last spoke to him was being
// written by the quiet.
//
// `wm_session_handoffs.source` existed with a default, `WmHandoffInput.source` existed, and
// `writeHandoff` already honoured it. The value was dropped in the Librarian executor -- accepted at both
// ends of the wire and lost in the middle, which is the shape that keeps recurring here.

import { describe, it, expect, vi } from "vitest";
import { execWmHandoffWrite } from "../librarian/executors/webmind.js";
import type { Env } from "../types.js";

vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmWriteHandoff: vi.fn(async () => ({ handoff_id: "h1" })) };
});
const { wmWriteHandoff } = await import("../librarian/backends/webmind.js");

const ctx = (context: Record<string, unknown>) => ({
  env: {} as Env,
  req: { companion_id: "cypher" as const, request: "session handoff", context: JSON.stringify(context) },
  entry: {} as never,
  frontState: null,
  pluralAvailable: false,
});

describe("execWmHandoffWrite forwards source", () => {
  it("passes source through when the caller marks it a consolidation", async () => {
    vi.mocked(wmWriteHandoff).mockClear();
    await execWmHandoffWrite(ctx({ title: "a quiet session", summary: "nothing moved", source: "consolidation" }) as never);
    expect(vi.mocked(wmWriteHandoff).mock.calls[0]![1]).toMatchObject({ source: "consolidation" });
  });

  it("omits source when absent, so an ordinary close keeps the table default", async () => {
    // Must stay ABSENT rather than becoming an empty string -- writeHandoff does `input.source ?? "system"`,
    // and "" is not nullish, so it would write a blank provenance and be worse than not passing it.
    vi.mocked(wmWriteHandoff).mockClear();
    await execWmHandoffWrite(ctx({ title: "real close", summary: "we talked about Fargo" }) as never);
    expect(vi.mocked(wmWriteHandoff).mock.calls[0]![1]).not.toHaveProperty("source");
  });

  it("a real close and a consolidation are DISTINGUISHABLE, which is the whole point", async () => {
    vi.mocked(wmWriteHandoff).mockClear();
    await execWmHandoffWrite(ctx({ title: "real", summary: "s" }) as never);
    await execWmHandoffWrite(ctx({ title: "machine", summary: "s", source: "consolidation" }) as never);
    const calls = vi.mocked(wmWriteHandoff).mock.calls.map(c => (c[1] as { source?: string }).source);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toBe("consolidation");
  });
});
