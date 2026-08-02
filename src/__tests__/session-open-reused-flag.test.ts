// Phase 2 boot layer (2026-08-02): the `reused` flag on session open.
//
// WHY THIS EXISTS. Both session-open loaders carry a 24h idempotency guard --
// "if this companion already has a session with handover_id IS NULL, hand that one
// back instead of inserting". The guard does NOT filter by session_type, so a
// Claude Code SessionStart hook asking for a work session can be handed the session
// id of a live Claude.ai companion conversation.
//
// Before this flag, the response for "I opened a new session" and "you are borrowing
// someone else's open session" was byte-identical. The boot hook would then close the
// borrowed session at terminal exit and write a machine-derived, git-diff-shaped spine
// into a companion conversation's handover packet -- and the continuity read does not
// filter by session_type, so that spine becomes the boot narrative on every surface.
//
// So the flag is the guard, and these tests pin the branch that only fires on a
// machine that already has an open session -- i.e. the branch that ships invisible.
//
// Covered on BOTH loaders, because they are siblings with the same guard copied into
// each (loadSessionData -> execSessionLoad -> buildResponse, and loadOrientData ->
// execSessionOrient's own response object). A fix landing on one writer while its
// sibling silently diverges is the documented failure mode of this codebase.

import { describe, it, expect, vi } from "vitest";

vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmOrient: vi.fn(async () => null), wmWriteHandoff: vi.fn(async () => ({})) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execSessionLoad, execSessionOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";
import type { PatternEntry } from "../librarian/patterns.js";

interface Statement {
  bind(...args: unknown[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

// The guard query, verbatim in shape from both loaders. Matching on the distinctive
// `handover_id IS NULL` clause rather than the whole string keeps the two loaders'
// slightly different SELECT lists (one also reads emotional_frequency) both covered.
const OPEN_SESSION_GUARD = /SELECT id(, emotional_frequency)? FROM sessions WHERE companion_id = \? AND handover_id IS NULL/;

function makeStatement(
  sql: string,
  bound: unknown[],
  calls: Array<{ sql: string; bound: unknown[] }>,
  existingOpenSessionId: string | null,
): Statement {
  return {
    bind(...args: unknown[]) { return makeStatement(sql, args, calls, existingOpenSessionId); },
    async run() {
      calls.push({ sql, bound });
      return { meta: { changes: 1 } };
    },
    async first<T>() {
      if (OPEN_SESSION_GUARD.test(sql)) {
        return existingOpenSessionId
          ? ({ id: existingOpenSessionId, emotional_frequency: null } as T)
          : null;
      }
      // Post-INSERT persistence check inside both loaders.
      if (/SELECT id FROM sessions WHERE id = \?/.test(sql)) return { id: bound[0] } as T;
      return null;
    },
    async all<T>() { return { results: [] as T[] }; },
  };
}

function fakeD1Env(existingOpenSessionId: string | null): { env: Env; calls: Array<{ sql: string; bound: unknown[] }> } {
  const calls: Array<{ sql: string; bound: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) { return makeStatement(sql, [], calls, existingOpenSessionId); },
      async batch(stmts: Statement[]) { return Promise.all(stmts.map((s) => s.run())); },
    },
  } as unknown as Env;
  return { env, calls };
}

function makeCtx(env: Env): ExecutorContext {
  return {
    env,
    req: { companion_id: "cypher", request: "open my session" },
    entry: { triggers: [], tools: ["halseth_session_load"], response_key: "ready_prompt" } as PatternEntry,
    frontState: "cypher-front",
    pluralAvailable: false,
  };
}

function insertOf(calls: Array<{ sql: string; bound: unknown[] }>) {
  return calls.find((c) => c.sql.includes("INSERT INTO sessions"));
}

describe("session open -- `reused` flag (Phase 2 boot layer)", () => {
  describe("execSessionLoad (session_open fast path, the one the boot hook calls)", () => {
    it("reports reused:false and DOES insert when no open session exists", async () => {
      const { env, calls } = fakeD1Env(null);
      const r = await execSessionLoad(makeCtx(env)) as Record<string, unknown>;
      expect(r.reused).toBe(false);
      expect(insertOf(calls)).toBeDefined();
      expect(r.session_id).toBeTruthy();
    });

    it("reports reused:true and does NOT insert when an open session already exists", async () => {
      const { env, calls } = fakeD1Env("sess-owned-by-claude-ai");
      const r = await execSessionLoad(makeCtx(env)) as Record<string, unknown>;
      expect(r.reused).toBe(true);
      expect(insertOf(calls)).toBeUndefined();
      // The borrowed id is handed back -- which is exactly why the flag must ride
      // alongside it. The id alone cannot tell the caller whose session it is.
      expect(r.session_id).toBe("sess-owned-by-claude-ai");
    });
  });

  describe("execSessionOrient (Claude.ai two-call boot path -- sibling, same guard)", () => {
    it("reports reused:false and DOES insert when no open session exists", async () => {
      const { env, calls } = fakeD1Env(null);
      const r = await execSessionOrient(makeCtx(env)) as Record<string, unknown>;
      expect(r.reused).toBe(false);
      expect(insertOf(calls)).toBeDefined();
    });

    it("reports reused:true and does NOT insert when an open session already exists", async () => {
      const { env, calls } = fakeD1Env("sess-already-open");
      const r = await execSessionOrient(makeCtx(env)) as Record<string, unknown>;
      expect(r.reused).toBe(true);
      expect(insertOf(calls)).toBeUndefined();
      expect(r.session_id).toBe("sess-already-open");
    });
  });

  // Guard against the flag quietly becoming undefined on some path. The boot hook
  // treats a non-boolean as "decline to close" (fail safe), but a response that
  // stopped carrying the field at all would silently disable automatic close --
  // which looks identical to "nothing to close".
  it("the flag is always a boolean, never undefined, on both paths and both branches", async () => {
    for (const existing of [null, "sess-x"]) {
      for (const exec of [execSessionLoad, execSessionOrient]) {
        const { env } = fakeD1Env(existing);
        const r = await exec(makeCtx(env)) as Record<string, unknown>;
        expect(typeof r.reused).toBe("boolean");
      }
    }
  });
});
