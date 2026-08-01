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

/**
 * initialize (returns a session id header) then tools/call (returns `body`).
 *
 * ECHOES THE REQUEST ID, like a real JSON-RPC server. callTool now sends a unique id per call and discards
 * any response whose id does not match (cross-request mixing defence), so a mock that returns a fixed id
 * would have every response rejected and these tests would pass for the wrong reason.
 */
function mockSb(body: Record<string, unknown>) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const payload = typeof init?.body === "string" ? init.body : "";
    if (payload.includes('"initialize"')) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "mcp-session-id": "sess-1" },
      });
    }
    const sentId = (() => { try { return JSON.parse(payload).id as number; } catch { return undefined; } })();
    return new Response(JSON.stringify({ ...body, id: sentId }), {
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
    const legacyReading = { content: [{ type: "text", text: QUOTA_ERROR }], isError: true }.content[0]!.text;
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

  it("DISCARDS a response whose id does not match the request -- cross-request mixing", async () => {
    // The real bug, 2026-08-01: every tools/call sent the hardcoded `id: 2` on a SHARED session, and bot
    // orient fires three Second Brain calls at once. Responses were delivered to the wrong callers, so
    // `sb_read` of a session narrative returned first an embeddings error and then `{"chunks":[...]}` from a
    // concurrent search -- while the vault file was perfectly intact. Confidently WRONG data, no error
    // anywhere, on the substrate holding all the long-term memory.
    vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const payload = typeof init?.body === "string" ? init.body : "";
      if (payload.includes('"initialize"')) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200, headers: { "Content-Type": "application/json", "mcp-session-id": "s" },
        });
      }
      // Somebody ELSE's answer: a search result, tagged with a different request id.
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 999999,
        result: { content: [{ type: "text", text: '{"chunks":[{"vault_path":"someone/else.md"}]}' }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const out = await sbRead(env, "raziel/sessions/mine.md");

    // Must NOT return the other call's chunks as if they were this file's contents.
    expect(out).toBeNull();
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
