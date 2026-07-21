// Questions-lifecycle fix (mig 0107): execSessionOrient's ready_prompt includes the
// answers-Raziel-left block. Mocks the backend collaborators (sessionOrient/wmOrient/
// semanticSearch/sbRead) the same way conclusions-novelty-executors.test.ts mocks
// execSessionClose's collaborators -- spreading `...actual` keeps every other export
// working unmocked, isolating this test to execSessionOrient's own assembly logic.

import { describe, it, expect, vi } from "vitest";

vi.mock("../librarian/backends/halseth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/halseth.js")>();
  return {
    ...actual,
    sessionOrient: vi.fn(async () => ({ session_id: "sess-1", state: null })),
  };
});
vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmOrient: vi.fn(async () => null) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execSessionOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

const answeredRow = {
  id: "q-answered-1",
  question: "should we ship the fix?",
  answer: "yes, ship it",
  answered_at: "2026-07-20T00:00:00Z",
  delivered_at: null,
};

function makeCtx(companion_id: "cypher" | "drevan" | "gaia" = "cypher"): { ctx: ExecutorContext; runs: Array<{ sql: string; args: unknown[] }> } {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (...args: unknown[]) => ({
            all: async () => {
              if (sql.includes("FROM companion_questions") && sql.includes("status = 'answered'")) {
                return { results: [answeredRow] };
              }
              return { results: [] };
            },
            first: async () => null,
            run: async () => { runs.push({ sql, args }); return { meta: { changes: 1 } }; },
          }),
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => { runs.push({ sql, args: [] }); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    },
  } as unknown as Env;

  const ctx = {
    env,
    req: { companion_id, request: "orient" },
    entry: {} as never,
    frontState: null,
    pluralAvailable: false,
  } as ExecutorContext;

  return { ctx, runs };
}

describe("execSessionOrient -- answered_questions (questions-lifecycle fix, mig 0107)", () => {
  it("includes the answered-questions block in ready_prompt", async () => {
    const { ctx } = makeCtx();
    const result = await execSessionOrient(ctx);
    expect(result.ready_prompt).toContain("Answers Raziel left for you:");
    expect(result.ready_prompt).toContain("should we ship the fix?");
    expect(result.ready_prompt).toContain("yes, ship it");
  });

  it("carries answered_questions as a structured field and in meta count", async () => {
    const { ctx } = makeCtx();
    const result = await execSessionOrient(ctx);
    expect(result.answered_questions).toEqual([answeredRow]);
    expect((result.meta as Record<string, unknown>).answered_questions).toBe(1);
  });

  it("stamps delivered_at on the surfaced answer id", async () => {
    const { ctx, runs } = makeCtx();
    await execSessionOrient(ctx);
    const deliveredRun = runs.find(r => r.sql.includes("UPDATE companion_questions SET delivered_at"));
    expect(deliveredRun).toBeDefined();
    expect(deliveredRun!.args).toContain("q-answered-1");
  });
});
