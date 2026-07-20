// src/__tests__/conclusions-novelty-executors.test.ts
//
// Coordinator review (2026-07-20) on Task 11: `postConclusion` (handlers/conclusions.ts)
// had gate coverage, but the other two writers of companion_conclusions --
// execConclusionAdd (librarian/executors/writes.ts) and the conclusion fan-out entry
// inside execSessionClose (librarian/executors/session.ts) -- did not. This codebase
// has a documented history of a fix landing on one writer of a shared table while its
// siblings silently diverge; the brief's core requirement ("all three writers must
// behave identically") needs to be test-enforced, not trace-enforced. This file closes
// that gap for both untested writers.

import { describe, it, expect, vi, beforeEach } from "vitest";

// execSessionClose calls real backends for session-close bookkeeping unrelated to the
// conclusion gate (handover write, WebMind handoff, drift/somatic enqueue). Mock those
// collaborators so the test exercises ONLY the conclusion fan-out entry's gate logic --
// spreading `...actual` keeps every other export (used by sibling exec* functions in the
// same module) working unmocked.
vi.mock("../librarian/backends/halseth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/halseth.js")>();
  return {
    ...actual,
    sessionClose: vi.fn(async (_env, params: { spine: string }) => ({ id: "handover-1", spine: params.spine })),
  };
});
vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmWriteHandoff: vi.fn(async () => ({})) };
});
vi.mock("../synthesis/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../synthesis/index.js")>();
  return {
    ...actual,
    enqueueBasinDriftCheck: vi.fn(async () => undefined),
    enqueueSomaticSnapshot: vi.fn(async () => undefined),
  };
});

import { execConclusionAdd } from "../librarian/executors/writes.js";
import { execSessionClose } from "../librarian/executors/session.js";
import type { Env } from "../types.js";

// ---------------------------------------------------------------------------
// Shared fake-env helper: generic D1 stub (captures every prepare+bind call),
// plus AI/VECTORIZE stubs so noveltyCheck resolves against a caller-supplied
// top match -- same shape as conclusions-novelty.test.ts's handler-level mock.
// ---------------------------------------------------------------------------

interface Captured { prepared: string[]; binds: unknown[][] }

function makeEnv(matches: Array<{ id: string; score: number }>, captured: Captured): any {
  return {
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (...args: unknown[]) => {
            captured.prepared.push(sql);
            captured.binds.push(args);
            return stmt;
          },
          // The session_id auto-resolve query in execSessionClose needs a hit here;
          // every other call site in this file uses .run()/.batch() instead.
          first: async () => (sql.includes("SELECT id FROM sessions") ? { id: "sess-1" } : null),
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: {
      query: vi.fn(async () => ({ matches })),
      upsert: vi.fn(async () => undefined),
    },
  } as unknown as Env;
}

function insertCalls(c: Captured): number {
  return c.prepared.filter((sql) => sql.includes("INSERT INTO companion_conclusions")).length;
}

function supersedeUpdateFor(c: Captured, matchId: string): unknown[] | undefined {
  const idx = c.prepared.findIndex(
    (sql, i) => sql.includes("UPDATE companion_conclusions SET superseded_by") && c.binds[i]?.[1] === matchId
  );
  return idx === -1 ? undefined : c.binds[idx];
}

// ---------------------------------------------------------------------------
// Writer 2/3: execConclusionAdd (librarian/executors/writes.ts)
// ---------------------------------------------------------------------------

describe("execConclusionAdd -- novelty gate", () => {
  function ctx(env: Env): any {
    return {
      env,
      req: {
        companion_id: "cypher",
        request: "I conclude: the architecture holds",
        context: JSON.stringify({ conclusion_text: "the architecture holds" }),
      },
      entry: { response_key: "witness" },
      frontState: null,
      pluralAvailable: false,
    };
  }

  it("skips on a near-identical match (0.97) -- no INSERT, dedupe shape with matched row id", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:existing123", score: 0.97 }], captured);

    const res = await execConclusionAdd(ctx(env)) as Record<string, unknown>;

    expect(res.deduped).toBe(true);
    expect(res.novelty).toEqual({ action: "skip", match_id: "existing123", score: 0.97 });
    expect(res.id).toBe("existing123");
    expect(insertCalls(captured)).toBe(0);
  });

  it("supersedes on a 0.90 match -- INSERT new + exact UPDATE bind order [newId, matchRowId, companionId]", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured);

    const res = await execConclusionAdd(ctx(env)) as Record<string, unknown>;

    expect(typeof res.id).toBe("string");
    expect(res.novelty).toMatchObject({ action: "supersede", match_id: "oldrow456", score: 0.90 });
    expect(res.superseded).toBe(true); // gate-driven supersede populates the top-level field too
    expect(insertCalls(captured)).toBe(1);

    const updateBind = supersedeUpdateFor(captured, "oldrow456");
    expect(updateBind).toBeDefined();
    expect(updateBind).toEqual([res.id, "oldrow456", "cypher"]);
  });

  it("reuses the gate's embedding -- AI.run called exactly once, one Vectorize upsert, no re-embed", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured) as any;

    await execConclusionAdd(ctx(env));

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("inserts plainly below the supersede threshold (0.5) -- no UPDATE", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:unrelated", score: 0.5 }], captured);

    const res = await execConclusionAdd(ctx(env)) as Record<string, unknown>;

    expect(res.novelty).toEqual({ action: "insert" });
    expect(insertCalls(captured)).toBe(1);
    expect(captured.prepared.some((sql) => sql.includes("UPDATE companion_conclusions SET superseded_by"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Writer 3/3: session.ts conclusion fan-out entry, reached via execSessionClose
// (the fan-out entry is a promise built inline inside execSessionClose, not an
// independently exported function -- execSessionClose is the narrowest public
// entry that reaches it).
// ---------------------------------------------------------------------------

describe("execSessionClose -- conclusion fan-out novelty gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function ctx(env: Env, conclusion: string): any {
    return {
      env,
      req: {
        companion_id: "cypher",
        request: "close session",
        context: JSON.stringify({
          spine: "held the thread",
          last_real_thing: "shipped the fix",
          motion_state: "at_rest",
          emotion_prompted: true, // bypass the soft emotion prompt
          conclusion,
        }),
      },
      entry: { response_key: "witness" },
      frontState: null,
      pluralAvailable: false,
    };
  }

  it("skip: no INSERT, and the skip is NOT counted in fanout.failed (resolves fulfilled)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:existing123", score: 0.97 }], captured);

    const res = await execSessionClose(ctx(env, "the architecture holds")) as Record<string, unknown>;

    expect(res.ack).toBe(true);
    expect(insertCalls(captured)).toBe(0);
    const fanout = res.fanout as { written: number; failed: number } | undefined;
    expect(fanout).toBeDefined();
    expect(fanout!.failed).toBe(0);
    expect(fanout!.written).toBe(1); // allSettled fulfilled -- skip is a successful no-op, not a failure
  });

  it("supersede: INSERT new + exact UPDATE bind order [newId, matchRowId, companionId]", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured);

    const res = await execSessionClose(ctx(env, "the architecture holds")) as Record<string, unknown>;

    expect(res.ack).toBe(true);
    expect(insertCalls(captured)).toBe(1);

    // The new conclusion row's id is the fan-out's own crypto.randomUUID() -- recover it
    // from the INSERT bind (first positional arg) rather than the session-close envelope,
    // which doesn't surface per-fanout-item ids.
    const insertIdx = captured.prepared.findIndex((sql) => sql.includes("INSERT INTO companion_conclusions"));
    const newId = captured.binds[insertIdx]?.[0];
    expect(typeof newId).toBe("string");

    const updateBind = supersedeUpdateFor(captured, "oldrow456");
    expect(updateBind).toBeDefined();
    expect(updateBind).toEqual([newId, "oldrow456", "cypher"]);

    const fanout = res.fanout as { written: number; failed: number } | undefined;
    expect(fanout!.failed).toBe(0);
  });

  it("reuses the gate's embedding -- AI.run called exactly once, one Vectorize upsert, no re-embed", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured) as any;

    await execSessionClose(ctx(env, "the architecture holds"));

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("inserts plainly below the supersede threshold (0.5) -- no UPDATE, still counts as written", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:unrelated", score: 0.5 }], captured);

    const res = await execSessionClose(ctx(env, "the architecture holds")) as Record<string, unknown>;

    expect(insertCalls(captured)).toBe(1);
    expect(captured.prepared.some((sql) => sql.includes("UPDATE companion_conclusions SET superseded_by"))).toBe(false);
    const fanout = res.fanout as { written: number; failed: number } | undefined;
    expect(fanout!.written).toBe(1);
    expect(fanout!.failed).toBe(0);
  });
});
