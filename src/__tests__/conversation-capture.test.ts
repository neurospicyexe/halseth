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

function fakeEnv(opts: { byId?: string | null; newestOpen?: string | null }): Env {
  return {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind(..._args: unknown[]) { return stmt; },
          async first<T>(): Promise<T | null> {
            if (/id = \? OR \(id LIKE \?/.test(sql)) {
              return opts.byId ? ({ id: opts.byId } as T) : null;
            }
            if (/handover_id IS NULL ORDER BY created_at DESC LIMIT 1/.test(sql)) {
              return opts.newestOpen ? ({ id: opts.newestOpen } as T) : null;
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
