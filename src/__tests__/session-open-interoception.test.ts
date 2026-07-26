// Fix 4 (2026-07-21): companion sessions opened via ask_librarian (both the legacy
// session_open pattern -> execSessionLoad, and the live two-call boot's session_orient ->
// execSessionOrient) never populated sessions.hrv_range / emotional_frequency / depth /
// key_signature -- dead since the 2026-03-22 Librarian cutover moved companions off the raw
// halseth_session_load MCP tool onto ask_librarian. loadSessionData/loadOrientData
// (src/mcp/tools/session_load.ts) already accept + write these columns (see the raw tool's
// zod schema at registerSessionLoadTools); the gap was purely that neither executor ever
// read them out of ctx.req.context. Both executors share the same session.ts
// (parallel-task-owned; only additive edits made here).
//
// Coverage:
//   - sanitizeInteroception (pure): the validation/ignore-on-invalid logic in isolation.
//   - execSessionLoad (integration, real loadSessionData + fake D1): valid fields land in
//     the actual INSERT bind array at the documented column indices; invalid fields bind
//     as null; omitted fields behave exactly as before (unchanged behavior).
//   - execSessionOrient (integration, real sessionOrient/loadOrientData + fake D1): the
//     live two-call boot path writes the same INSERT INTO sessions -- proves the fix
//     reaches the path the project's boot sequence actually uses, not just the legacy one.
//     wmOrient/semanticSearch/sbRead are mocked out (unrelated collaborators -- orient's
//     RAG/continuity fan-out, not the interoception plumbing under test here).

import { describe, it, expect, vi } from "vitest";

vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmOrient: vi.fn(async () => null), wmWriteHandoff: vi.fn(async () => ({})) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { sanitizeInteroception, execSessionLoad, execSessionOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";
import type { PatternEntry } from "../librarian/patterns.js";

// ── sanitizeInteroception: pure validation logic ──────────────────────────────

describe("sanitizeInteroception (fix 4)", () => {
  it("passes through all four valid fields", () => {
    const out = sanitizeInteroception({
      hrv_range: "mid", emotional_frequency: "settled", depth: 2, key_signature: "D minor",
    });
    expect(out).toEqual({ hrv_range: "mid", emotional_frequency: "settled", depth: 2, key_signature: "D minor" });
  });

  it("drops an invalid hrv_range (not low/mid/high)", () => {
    const out = sanitizeInteroception({ hrv_range: "medium" });
    expect(out.hrv_range).toBeUndefined();
  });

  it("drops an out-of-range depth (must be 0-3 integer)", () => {
    expect(sanitizeInteroception({ depth: 7 }).depth).toBeUndefined();
    expect(sanitizeInteroception({ depth: -1 }).depth).toBeUndefined();
    expect(sanitizeInteroception({ depth: 1.5 }).depth).toBeUndefined();
    expect(sanitizeInteroception({ depth: "2" }).depth).toBeUndefined();
  });

  it("accepts depth: 0 (falsy but valid)", () => {
    expect(sanitizeInteroception({ depth: 0 }).depth).toBe(0);
  });

  it("drops non-string / blank emotional_frequency and key_signature", () => {
    const out = sanitizeInteroception({ emotional_frequency: "   ", key_signature: 42 });
    expect(out.emotional_frequency).toBeUndefined();
    expect(out.key_signature).toBeUndefined();
  });

  it("returns an empty object for null context (no fields supplied)", () => {
    expect(sanitizeInteroception(null)).toEqual({});
  });

  it("returns an empty object when no recognized keys are present", () => {
    expect(sanitizeInteroception({})).toEqual({});
  });
});

// ── execSessionLoad: real loadSessionData + fake D1, assert the actual INSERT bind ──

interface Statement {
  bind(...args: unknown[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

function makeStatement(sql: string, bound: unknown[], calls: Array<{ sql: string; bound: unknown[] }>): Statement {
  return {
    bind(...args: unknown[]) { return makeStatement(sql, args, calls); },
    async run() {
      calls.push({ sql, bound });
      return { meta: { changes: 1 } };
    },
    async first<T>() {
      // Verify-insert check inside loadSessionData/loadOrientData: must resolve truthy
      // or the executor throws "session INSERT did not persist".
      if (/SELECT id FROM sessions WHERE id = \?/.test(sql)) return { id: bound[0] } as T;
      return null;
    },
    async all<T>() { return { results: [] as T[] }; },
  };
}

function fakeD1Env(): { env: Env; calls: Array<{ sql: string; bound: unknown[] }> } {
  const calls: Array<{ sql: string; bound: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) { return makeStatement(sql, [], calls); },
      async batch(stmts: Statement[]) { return Promise.all(stmts.map((s) => s.run())); },
    },
  } as unknown as Env;
  return { env, calls };
}

// INSERT INTO sessions (id, created_at, updated_at, session_type, companion_id, front_state,
//   hrv_range, emotional_frequency, key_signature, active_anchor, facet, depth, notes)
const HRV_IDX = 6, FREQ_IDX = 7, KEYSIG_IDX = 8, DEPTH_IDX = 11;

function makeCtx(env: Env, context?: Record<string, unknown>): ExecutorContext {
  return {
    env,
    req: { companion_id: "cypher", request: "open my session", context: context ? JSON.stringify(context) : undefined },
    entry: { triggers: [], tools: ["halseth_session_load"], response_key: "ready_prompt" } as PatternEntry,
    frontState: "cypher-front",
    pluralAvailable: false,
  };
}

describe("execSessionLoad -- interoception reaches the sessions INSERT (fix 4)", () => {
  it("writes all four fields when valid and present", async () => {
    const { env, calls } = fakeD1Env();
    await execSessionLoad(makeCtx(env, {
      hrv_range: "high", emotional_frequency: "bright", depth: 3, key_signature: "A major",
    }));
    const insert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(insert).toBeDefined();
    expect(insert!.bound[HRV_IDX]).toBe("high");
    expect(insert!.bound[FREQ_IDX]).toBe("bright");
    expect(insert!.bound[KEYSIG_IDX]).toBe("A major");
    expect(insert!.bound[DEPTH_IDX]).toBe(3);
  });

  it("writes null for invalid hrv_range/depth, and the session open still succeeds", async () => {
    const { env, calls } = fakeD1Env();
    const result = await execSessionLoad(makeCtx(env, { hrv_range: "extreme", depth: 99 }));
    expect(result.response_key ?? (result as Record<string, unknown>)["response_key"]).toBe("ready_prompt");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(insert!.bound[HRV_IDX]).toBeNull();
    expect(insert!.bound[DEPTH_IDX]).toBeNull();
  });

  it("behaves exactly as before when none of the four fields are supplied", async () => {
    const { env, calls } = fakeD1Env();
    await execSessionLoad(makeCtx(env));
    const insert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(insert!.bound[HRV_IDX]).toBeNull();
    expect(insert!.bound[FREQ_IDX]).toBeNull();
    expect(insert!.bound[KEYSIG_IDX]).toBeNull();
    expect(insert!.bound[DEPTH_IDX]).toBeNull();
  });
});

// ── execSessionOrient: real sessionOrient + fake D1, same INSERT, live boot path ──

describe("execSessionOrient -- interoception reaches the sessions INSERT (fix 4, live boot path)", () => {
  it("writes all four fields when valid and present", async () => {
    const { env, calls } = fakeD1Env();
    await execSessionOrient(makeCtx(env, {
      hrv_range: "low", emotional_frequency: "quiet", depth: 1, key_signature: "C",
    }));
    const insert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(insert).toBeDefined();
    expect(insert!.bound[HRV_IDX]).toBe("low");
    expect(insert!.bound[FREQ_IDX]).toBe("quiet");
    expect(insert!.bound[KEYSIG_IDX]).toBe("C");
    expect(insert!.bound[DEPTH_IDX]).toBe(1);
  });

  it("writes null for invalid hrv_range/depth, and orient still succeeds", async () => {
    const { env, calls } = fakeD1Env();
    const result = await execSessionOrient(makeCtx(env, { hrv_range: "nonsense", depth: -5 })) as Record<string, unknown>;
    expect(result.response_key).toBe("ready_prompt");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(insert!.bound[HRV_IDX]).toBeNull();
    expect(insert!.bound[DEPTH_IDX]).toBeNull();
  });
});
