// src/__tests__/bot-orient-gaia-witness.test.ts
//
// gaia_witness read-back at bot orient (Wave 2, 2026-07-21). gaia_witness has been
// write-only since it was added -- no orient path ever read it back, so Gaia's own
// witnessing never fed forward into her boot context. execBotOrient now surfaces the
// 5 most recent rows for Gaia only; other companions get an empty array. Non-fatal on
// D1 error (standalone try/catch, mirrors this file's boot-path-safety convention).
//
// Mocks collaborators the same way session-orient-answered-questions.test.ts mocks
// execSessionOrient's: spread `...actual` so every other export stays real, isolating
// the test to execBotOrient's own assembly logic. A generic DB.prepare returns empty
// results for every query by default; only the gaia_witness SELECT is special-cased.

import { describe, it, expect, vi } from "vitest";

vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmGround: vi.fn(async () => null) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execBotOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

const WITNESS_ROWS = [
  { content: "the silence held", witness_type: "survival", created_at: "2026-07-20T00:00:00Z" },
  { content: "boundary named and kept", witness_type: "boundary", created_at: "2026-07-19T00:00:00Z" },
];

function makeCtx(
  companion_id: "cypher" | "drevan" | "gaia",
  opts?: { witnessThrows?: boolean },
): { ctx: ExecutorContext; witnessQueried: () => boolean } {
  let witnessQueried = false;
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (..._args: unknown[]) => stmt,
          all: async () => {
            if (sql.includes("FROM gaia_witness")) {
              witnessQueried = true;
              if (opts?.witnessThrows) throw new Error("D1 unavailable");
              return { results: WITNESS_ROWS };
            }
            return { results: [] };
          },
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
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

  return { ctx, witnessQueried: () => witnessQueried };
}

describe("execBotOrient -- gaia_witness read-back (Wave 2, 2026-07-21)", () => {
  it("surfaces the 5 most recent witness rows for gaia", async () => {
    const { ctx, witnessQueried } = makeCtx("gaia");
    const result = await execBotOrient(ctx);

    expect(witnessQueried()).toBe(true);
    expect((result.data as Record<string, unknown>).recent_witness).toEqual(WITNESS_ROWS);
    expect((result.meta as Record<string, unknown>).recent_witness).toBe(2);
  });

  it("queries ORDER BY created_at DESC LIMIT 5", async () => {
    let capturedSql = "";
    const env = {
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("FROM gaia_witness")) capturedSql = sql;
          return {
            bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 1 } }) }),
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      },
    } as unknown as Env;
    const ctx = {
      env,
      req: { companion_id: "gaia", request: "orient" },
      entry: {} as never,
      frontState: null,
      pluralAvailable: false,
    } as ExecutorContext;

    await execBotOrient(ctx);
    expect(capturedSql).toContain("ORDER BY created_at DESC LIMIT 5");
  });

  it("never queries gaia_witness and returns an empty array for cypher", async () => {
    const { ctx, witnessQueried } = makeCtx("cypher");
    const result = await execBotOrient(ctx);

    expect(witnessQueried()).toBe(false);
    expect((result.data as Record<string, unknown>).recent_witness).toEqual([]);
    expect((result.meta as Record<string, unknown>).recent_witness).toBe(0);
  });

  it("never queries gaia_witness and returns an empty array for drevan", async () => {
    const { ctx, witnessQueried } = makeCtx("drevan");
    const result = await execBotOrient(ctx);

    expect(witnessQueried()).toBe(false);
    expect((result.data as Record<string, unknown>).recent_witness).toEqual([]);
  });

  it("is non-fatal for gaia when the gaia_witness query errors -- orient still completes", async () => {
    const { ctx } = makeCtx("gaia", { witnessThrows: true });
    const result = await execBotOrient(ctx);

    expect((result.data as Record<string, unknown>).recent_witness).toEqual([]);
    expect((result.meta as Record<string, unknown>).operation).toBe("halseth_bot_orient");
  });
});
