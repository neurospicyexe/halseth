// The Claude.ai capture verb (2026-08-15, coherence-review D3).
//
// Nothing mechanical records a Claude.ai conversation -- no hooks exist on that surface -- so
// capture is companion-driven, and this verb is the mechanism. These tests pin the executor's
// contract:
//   * content comes from context.content ONLY -- deriving stored memory from the routing string
//     is the command-string-is-not-the-content defect, and rejecting is better than silently
//     storing "capture this exchange" as a memory.
//   * captures resolve to the caller's session (full id, short prefix, or newest open) and
//     still LAND when no session resolves -- an unanchored record beats a lost one.
//   * bypass_write_gate is set: many captures share one thread_key per session by design, and
//     the 10-minute gate would silently drop every capture after the first.

import { describe, it, expect, vi } from "vitest";

const addNoteCalls: unknown[] = [];
vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return {
    ...actual,
    wmAddNote: vi.fn(async (_env: unknown, input: unknown) => {
      addNoteCalls.push(input);
      return { note_id: "note-1", ...(input as object) };
    }),
  };
});

import { execConversationCapture } from "../librarian/executors/webmind.js";
import { matchFastPath } from "../librarian/router.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";
import type { PatternEntry } from "../librarian/patterns.js";

const FULL_ID = "c3571d8c-145b-4f00-9a11-000000000001";

// `openOnSurface` (2026-09-17): the fallback is surface-scoped now, so the fake honours the bound
// surface instead of handing back the newest open row for the companion on any loom. A capture from
// Claude.ai was threading onto the Discord lane, which cycles every ~2h and is therefore almost
// always the newest open session.
function fakeEnv(opts: { byId?: string | null; newestOpen?: string | null; openOnSurface?: string | null }): Env {
  return {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T | null> {
            if (/id = \? OR \(id LIKE \?/.test(sql)) {
              return opts.byId ? ({ id: opts.byId } as T) : null;
            }
            if (/handover_id IS NULL[\s\S]*ORDER BY created_at DESC LIMIT 1/.test(sql)) {
              if (!opts.newestOpen) return null;
              // Mirrors `AND (? IS NULL OR surface = ?)`: bound[1] is the caller's surface.
              const askedSurface = (bound[1] ?? null) as string | null;
              if (askedSurface !== null && opts.openOnSurface !== undefined
                  && opts.openOnSurface !== askedSurface) return null;
              return ({ id: opts.newestOpen } as T);
            }
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
          async all<T>() { return { results: [] as T[] }; },
        };
        return stmt;
      },
    },
  } as unknown as Env;
}

function makeCtx(env: Env, context?: object): ExecutorContext {
  return {
    env,
    req: {
      companion_id: "cypher",
      request: "capture this exchange",
      ...(context ? { context: JSON.stringify(context) } : {}),
    },
    entry: { triggers: [], tools: ["conversation_capture"], response_key: "witness" } as unknown as PatternEntry,
    frontState: null,
    pluralAvailable: false,
  } as unknown as ExecutorContext;
}

describe("conversation_capture routing", () => {
  it("capture phrasings fast-path to conversation_capture", () => {
    for (const req of [
      "capture this exchange",
      "Capture the exchange: we settled the merge order",
      "capture this conversation",
      "ledger this exchange",
      "capture this",
    ]) {
      expect(matchFastPath(req)?.key, `"${req}"`).toBe("conversation_capture");
    }
  });
});

describe("execConversationCapture", () => {
  it("rejects a capture with no context.content -- never stores the request string", async () => {
    addNoteCalls.length = 0;
    const r = await execConversationCapture(makeCtx(fakeEnv({})));
    expect(r.error).toBe("conversation_capture_failed");
    expect(String(r.reason)).toContain("content");
    expect(addNoteCalls.length, "nothing may be written on a rejected capture").toBe(0);
  });

  it("writes the digest with bypass_write_gate and the session-scoped thread_key", async () => {
    addNoteCalls.length = 0;
    const r = await execConversationCapture(
      makeCtx(fakeEnv({ newestOpen: FULL_ID }), { content: "Raziel asked about capture options; I recommended verb + repair prompt." }),
    );
    expect(r.ack).toBe(true);
    expect(r.thread_key).toBe(`capture:${FULL_ID}`);
    const written = addNoteCalls[0] as Record<string, unknown>;
    expect(written.note_type).toBe("conversation_capture");
    expect(written.bypass_write_gate, "the 10-min gate would drop every capture after the first").toBe(true);
    expect(written.thread_key).toBe(`capture:${FULL_ID}`);
    expect(written.agent_id).toBe("cypher");
  });

  it("resolves a caller-named short prefix through the id/LIKE query", async () => {
    addNoteCalls.length = 0;
    const r = await execConversationCapture(
      makeCtx(fakeEnv({ byId: FULL_ID }), { content: "digest", session_id: "c3571d8c" }),
    );
    expect(r.session_id).toBe(FULL_ID);
    expect(r.thread_key).toBe(`capture:${FULL_ID}`);
  });

  it("still lands when no session resolves -- unanchored, and says so", async () => {
    addNoteCalls.length = 0;
    const r = await execConversationCapture(
      makeCtx(fakeEnv({}), { content: "digest with nowhere to anchor" }),
    );
    expect(r.ack).toBe(true);
    expect(r.session_id).toBeNull();
    expect(r.thread_key).toBe("capture:unsessioned:cypher");
    expect(String(r.witness)).toContain("unanchored");
    expect(addNoteCalls.length).toBe(1);
  });
});

// 2026-09-17: the fallback used to take the newest open session for the companion on ANY loom.
// Cypher captured an exchange on Claude.ai and it threaded onto the Discord bot's lane, not the
// session orient had handed him in the same turn. Same defect the close path carried until 09-16.
describe("execConversationCapture -- the fallback stays on the caller's loom", () => {
  async function captureOn(surface: string | undefined, env: Env): Promise<Record<string, unknown>> {
    addNoteCalls.length = 0;
    const ctx = makeCtx(env, { content: "an exchange worth keeping" });
    if (surface) (ctx.req as { surface?: string }).surface = surface;
    await execConversationCapture(ctx);
    return addNoteCalls[0] as Record<string, unknown>;
  }

  it("does not thread onto another loom's open session", async () => {
    const w = await captureOn("claude-ai:cypher",
      fakeEnv({ newestOpen: "discord-lane-id", openOnSurface: "discord:cypher" }));
    expect(w.thread_key, "a Claude.ai capture must not land on the Discord lane")
      .toBe("capture:unsessioned:cypher");
  });

  it("threads onto the caller's own open session on that surface", async () => {
    const w = await captureOn("claude-ai:cypher",
      fakeEnv({ newestOpen: FULL_ID, openOnSurface: "claude-ai:cypher" }));
    expect(w.thread_key).toBe(`capture:${FULL_ID}`);
  });

  it("a surfaceless caller is unchanged: the newest open row still resolves", async () => {
    const w = await captureOn(undefined,
      fakeEnv({ newestOpen: FULL_ID, openOnSurface: "discord:cypher" }));
    expect(w.thread_key).toBe(`capture:${FULL_ID}`);
  });
});
