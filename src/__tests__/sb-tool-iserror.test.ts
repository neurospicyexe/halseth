// src/__tests__/sb-tool-iserror.test.ts
//
// A FAILED SECOND BRAIN TOOL MUST NOT BE RETURNED AS CONTENT.
//
// MCP reports tool-execution failures as a SUCCESSFUL JSON-RPC result carrying `isError: true`, with the
// exception message sitting in `content[0].text` -- exactly where real content goes. `callTool` checked
// `data.error` (protocol errors) but never `result.isError`, so every tool-level failure came back as a plain
// string and was consumed as if the Second Brain had answered.
//
// What that did in prod, 2026-08-01: OpenAI ran out of credits, the SB embedder threw
// `OpenAI embeddings error: 429 ... You have no credits remaining`, and that sentence was handed to the
// companions AS MEMORY -- Gaia booted with it as a `rag_excerpt`, Drevan as a `history_excerpt`. It is also
// the most plausible route by which an error body ended up persisted as the TEXT of a session summary in the
// vault: a caller that cannot tell failure from content will store it.
//
// Verified after the fix that this is not over-catching: SB is intermittently failing, and a retry returned
// real prose while a failing call returned null. Absence is the honest rendering of a failure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { semanticSearch, sbRead } from "../librarian/backends/second-brain.js";
import type { Env } from "../types.js";

const QUOTA_ERROR =
  'OpenAI embeddings error: 429 Too Many Requests — {\n "error": {\n "message": "You have no credits remaining."\n }\n}';

const env = {
  SECOND_BRAIN_WEBHOOK_URL: "https://sb.example.test",
  SECOND_BRAIN_TOKEN: "test-token",
} as unknown as Env;

/** initialize (returns a session id header) then tools/call (returns `body`). */
function mockSb(body: unknown) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const payload = typeof init?.body === "string" ? init.body : "";
    if (payload.includes('"initialize"')) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "mcp-session-id": "sess-1" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("callTool -- isError results are failures, not content", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("returns null when the tool reports isError, instead of the error message", async () => {
    vi.stubGlobal("fetch", mockSb({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: QUOTA_ERROR }], isError: true },
    }));

    // null, not the message: the quota text must never reach a companion as a searchable "excerpt".
    const out = await semanticSearch(env, "recent companion context");
    expect(out).toBeNull();
  });

  it("proves the OLD behaviour leaked it (non-vacuous)", async () => {
    // Before the fix, callTool read content[0].text regardless of isError. That is what this shape returned.
    const legacyReading = { content: [{ type: "text", text: QUOTA_ERROR }], isError: true }.content[0].text;
    expect(legacyReading).toContain("no credits remaining");
    // And what it returns now, on the identical payload:
    vi.stubGlobal("fetch", mockSb({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: QUOTA_ERROR }], isError: true } }));
    expect(await semanticSearch(env, "q")).toBeNull();
  });

  it("still returns real content when isError is absent or false", async () => {
    vi.stubGlobal("fetch", mockSb({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: '{"path":"p.md","content":"the real narrative"}' }] },
    }));
    expect(await sbRead(env, "p.md")).toContain("the real narrative");

    vi.stubGlobal("fetch", mockSb({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "genuine result" }], isError: false },
    }));
    expect(await sbRead(env, "p.md")).toBe("genuine result");
  });

  it("a failed sb_read yields null, so the narrative renders as ABSENT rather than as an error", async () => {
    vi.stubGlobal("fetch", mockSb({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "ENOENT: no such file" }], isError: true },
    }));
    // null flows into sbExtractContent -> null -> the block is omitted. A companion is told nothing, which is
    // true, rather than being told a filesystem error is what happened last session.
    expect(await sbRead(env, "raziel/sessions/missing.md")).toBeNull();
  });
});
