// Questions-lifecycle fix (mig 0107): mindOrient surfaces answered_questions and stamps
// delivered_at on the surfaced rows. Mirrors earned-salience.test.ts's makeOrientEnv idiom
// (same module mocks, same makeStmt shape) since both exercise mindOrient's giant Promise.all.

import { describe, it, expect, vi } from "vitest";

vi.mock("../webmind/relational.js", () => ({
  readRelationalSnapshot: vi.fn(async () => null),
}));
vi.mock("../webmind/limbic.js", () => ({
  getCurrentLimbicState: vi.fn(async () => null),
  writeLimbicState: vi.fn(async () => undefined),
}));
vi.mock("../webmind/spiral.js", () => ({
  readRecentSpiralTurn: vi.fn(async () => null),
}));
vi.mock("../webmind/home/store.js", () => ({
  takeUnsurfacedEvents: vi.fn(async () => []),
}));

import { mindOrient } from "../webmind/orient.js";

type Stmt = {
  bind: (...args: unknown[]) => Stmt;
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function makeStmt(sql: string, rowsFn: (args: unknown[]) => unknown[], runsSink: Array<{ sql: string; args: unknown[] }>): Stmt {
  let boundArgs: unknown[] = [];
  const stmt: Stmt = {
    bind: (...args: unknown[]) => { boundArgs = args; return stmt; },
    all: async () => ({ results: rowsFn(boundArgs) }),
    first: async () => (rowsFn(boundArgs)[0] ?? null),
    run: async () => { runsSink.push({ sql, args: boundArgs }); return { meta: { changes: boundArgs.length } }; },
  };
  return stmt;
}

const answeredRow = {
  id: "q-answered-1",
  question: "should we ship the fix?",
  answer: "yes, ship it",
  answered_at: "2026-07-20T00:00:00Z",
  delivered_at: null,
};

function makeOrientEnv(answeredRows: unknown[] = []) {
  const preparedSql: string[] = [];
  const runs: Array<{ sql: string; args: unknown[] }> = [];

  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);

        if (sql.includes("FROM wm_identity_anchor_snapshot")) {
          return makeStmt(sql, () => [{ agent_id: "cypher", anchor_text: "x" }], runs);
        }
        if (sql.includes("FROM companion_questions") && sql.includes("status = 'answered'")) {
          return makeStmt(sql, () => answeredRows, runs);
        }
        return makeStmt(sql, () => [], runs);
      },
    },
  };
  return { env: env as never, preparedSql, runs };
}

describe("mindOrient -- answered_questions (questions-lifecycle fix, mig 0107)", () => {
  it("includes answered_questions in the response when rows exist", async () => {
    const { env } = makeOrientEnv([answeredRow]);
    const result = await mindOrient(env, "cypher");
    expect(result.answered_questions).toEqual([answeredRow]);
  });

  it("defaults to an empty array when no answered questions exist", async () => {
    const { env } = makeOrientEnv([]);
    const result = await mindOrient(env, "cypher");
    expect(result.answered_questions).toEqual([]);
  });

  it("queries with the 7-day window and status = 'answered', answer IS NOT NULL", async () => {
    const { env, preparedSql } = makeOrientEnv([]);
    await mindOrient(env, "cypher");
    const sql = preparedSql.find(s => s.includes("FROM companion_questions") && s.includes("status = 'answered'"));
    expect(sql).toBeDefined();
    expect(sql).toContain("answer IS NOT NULL");
    expect(sql).toContain("datetime('now', '-7 days')");
  });

  it("stamps delivered_at on every surfaced answered question id", async () => {
    const { env, runs } = makeOrientEnv([answeredRow, { ...answeredRow, id: "q-answered-2" }]);
    await mindOrient(env, "cypher");
    const deliveredRuns = runs.filter(r => r.sql.includes("UPDATE companion_questions SET delivered_at"));
    expect(deliveredRuns).toHaveLength(1);
    expect(new Set(deliveredRuns[0]!.args.slice(1))).toEqual(new Set(["q-answered-1", "q-answered-2"]));
  });

  it("never issues the delivered_at UPDATE when nothing is surfaced", async () => {
    const { env, runs } = makeOrientEnv([]);
    await mindOrient(env, "cypher");
    expect(runs.some(r => r.sql.includes("UPDATE companion_questions SET delivered_at"))).toBe(false);
  });
});
