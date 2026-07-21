// Questions-lifecycle fix (mig 0107): fetchRecentAnswers + markAnswersDelivered, the shared
// helper used by all three orient paths (mindOrient, execSessionOrient, execBotOrient).

import { describe, it, expect } from "vitest";
import { fetchRecentAnswers, markAnswersDelivered } from "../webmind/questions.js";

type Stmt = {
  bind: (...args: unknown[]) => Stmt;
  all: () => Promise<{ results: unknown[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function makeEnv(rows: unknown[], runsSink: Array<{ sql: string; args: unknown[] }>) {
  let lastSql = "";
  const stmts: Record<string, string> = {};
  const env = {
    DB: {
      prepare: (sql: string) => {
        lastSql = sql;
        let boundArgs: unknown[] = [];
        const stmt: Stmt = {
          bind: (...args: unknown[]) => { boundArgs = args; return stmt; },
          all: async () => { stmts["last"] = sql; return { results: rows }; },
          run: async () => { runsSink.push({ sql, args: boundArgs }); return { meta: { changes: boundArgs.length } }; },
        };
        return stmt;
      },
    },
  };
  return { env: env as never, getLastSql: () => lastSql };
}

describe("fetchRecentAnswers", () => {
  it("selects status = 'answered', answer IS NOT NULL, and the 7-day window", async () => {
    const { env, getLastSql } = makeEnv([], []);
    await fetchRecentAnswers(env, "cypher", 3);
    const sql = getLastSql();
    expect(sql).toContain("status = 'answered'");
    expect(sql).toContain("answer IS NOT NULL");
    expect(sql).toContain("answered_at >= datetime('now', '-7 days')");
    // delivered_at is SELECTed (carried through) but never gates the WHERE clause --
    // the 7-day window is the only filter. An early orient must not be able to eat the
    // answer before a later surface sees it.
    expect(sql).not.toMatch(/WHERE[\s\S]*delivered_at/);
  });

  it("returns rows from the query, capped by the limit param", async () => {
    const rows = [
      { id: "q-1", question: "q1", answer: "a1", answered_at: "2026-07-20T00:00:00Z", delivered_at: null },
      { id: "q-2", question: "q2", answer: "a2", answered_at: "2026-07-19T00:00:00Z", delivered_at: null },
    ];
    const { env } = makeEnv(rows, []);
    const out = await fetchRecentAnswers(env, "cypher", 3);
    expect(out).toEqual(rows);
  });

  it("defaults to limit 3 when not passed", async () => {
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const captured: unknown[][] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          let boundArgs: unknown[] = [];
          return {
            bind: (...args: unknown[]) => { boundArgs = args; captured.push(args); return { all: async () => ({ results: [] }) }; },
          };
        },
      },
    };
    await fetchRecentAnswers(env as never, "cypher");
    expect(captured[0]).toEqual(["cypher", 3]);
  });
});

describe("markAnswersDelivered", () => {
  it("no-ops on an empty id list -- never issues UPDATE ... IN ()", async () => {
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const { env } = makeEnv([], runs);
    await markAnswersDelivered(env, []);
    expect(runs).toHaveLength(0);
  });

  it("issues UPDATE ... WHERE id IN (...) AND delivered_at IS NULL, binding timestamp then ids", async () => {
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const { env } = makeEnv([], runs);
    await markAnswersDelivered(env, ["q-1", "q-2"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain("UPDATE companion_questions SET delivered_at = ?");
    expect(runs[0]!.sql).toContain("WHERE id IN (?, ?)");
    expect(runs[0]!.sql).toContain("AND delivered_at IS NULL");
    // First bound arg is the ISO timestamp, followed by the ids in order.
    expect(runs[0]!.args.slice(1)).toEqual(["q-1", "q-2"]);
    expect(typeof runs[0]!.args[0]).toBe("string");
  });
});
