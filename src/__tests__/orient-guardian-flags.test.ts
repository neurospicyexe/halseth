// Wave 3 starvation fix (2026-07-21): mindOrient (the raw /mind/orient HTTP path) had NO
// guardian source at all, unlike execSessionOrient/execBotOrient in src/librarian/executors/
// session.ts -- a companion whose only continuity read went through the Halseth HTTP route
// directly (not the Librarian session-orient path) never saw a single guardian flag. This
// mirrors orient-answered-questions.test.ts's makeOrientEnv idiom (same module mocks, same
// makeStmt shape) since both exercise mindOrient's giant Promise.all.

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

function makeStmt(rowsFn: (args: unknown[]) => unknown[]): Stmt {
  let boundArgs: unknown[] = [];
  const stmt: Stmt = {
    bind: (...args: unknown[]) => { boundArgs = args; return stmt; },
    all: async () => ({ results: rowsFn(boundArgs) }),
    first: async () => (rowsFn(boundArgs)[0] ?? null),
    run: async () => ({ meta: { changes: 0 } }),
  };
  return stmt;
}

const openFlagRow = {
  id: "gf-1",
  flag_type: "loop_stuck",
  severity: "notice",
  summary: "cypher: loop open since 2026-06-01 -- «fix the thing». Close it or name why it stays.",
};

function makeOrientEnv(guardianRows: unknown[] = []) {
  const preparedSql: string[] = [];

  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        if (sql.includes("FROM wm_identity_anchor_snapshot")) {
          return makeStmt(() => [{ agent_id: "cypher", anchor_text: "x" }]);
        }
        if (sql.includes("FROM guardian_flags")) {
          return makeStmt(() => guardianRows);
        }
        return makeStmt(() => []);
      },
    },
  };
  return { env: env as never, preparedSql };
}

describe("mindOrient -- guardian_flags (Wave 3 starvation fix)", () => {
  it("includes guardian_flags with a remediation hint when flags exist", async () => {
    const { env } = makeOrientEnv([openFlagRow]);
    const result = await mindOrient(env, "cypher");
    expect(result.guardian_flags).toHaveLength(1);
    expect(result.guardian_flags[0]).toMatchObject({
      id: "gf-1",
      flag_type: "loop_stuck",
      severity: "notice",
    });
    expect(result.guardian_flags[0]!.remediation).toContain("close loop");
  });

  it("defaults to an empty array when there are no open/surfaced flags", async () => {
    const { env } = makeOrientEnv([]);
    const result = await mindOrient(env, "cypher");
    expect(result.guardian_flags).toEqual([]);
  });

  it("queries system-wide-or-own, open-or-surfaced only (read-only: never consumes)", async () => {
    const { env, preparedSql } = makeOrientEnv([]);
    await mindOrient(env, "cypher");
    const sql = preparedSql.find(s => s.includes("FROM guardian_flags"));
    expect(sql).toBeDefined();
    expect(sql).toContain("companion_id = ? OR companion_id IS NULL");
    expect(sql).toContain("status IN ('open','surfaced')");
    // Never issues the open -> surfaced transition -- that stays session-orient's job.
    expect(preparedSql.some(s => s.includes("UPDATE guardian_flags"))).toBe(false);
  });

  it("gives every returned flag a non-empty remediation hint, even an unknown flag_type", async () => {
    const { env } = makeOrientEnv([{ id: "gf-2", flag_type: "some_future_type", severity: "notice", summary: "x" }]);
    const result = await mindOrient(env, "cypher");
    expect(result.guardian_flags[0]!.remediation.length).toBeGreaterThan(0);
  });
});
