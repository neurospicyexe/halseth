// Task 20 (thinking-quality fix, mig 0105): the salience-prune tick.
// runSaliencePrune archives (archived=1, never deletes) machine-source
// companion_journal rows that are BOTH old (PRUNE_MIN_AGE_DAYS+) AND cold
// (effective heat < PRUNE_HEAT_FLOOR). Human-source and unknown/NULL-source
// rows must never be archived.
//
// Two layers of proof, mirroring earned-salience.test.ts's convention:
//  (1) Behavioral -- a canned-row mock controls exactly what the SELECT
//      returns; assert the archive/warm/vector-delete/idempotent behavior
//      given those rows.
//  (2) Structural -- capture the REAL generated SQL text and bound args and
//      assert the WHERE clause actually encodes archived=0, the age floor,
//      the heat floor (via the real effectiveHeatSql()), and -- the load-
//      bearing proof of "human/NULL/legacy sources never archived" -- that
//      the source IN (...) list is bound to EXACTLY the MACHINE_SOURCES set,
//      structurally excluding every other source by construction.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runSaliencePrune,
  postSaliencePrune,
  PRUNE_MIN_AGE_DAYS,
  PRUNE_HEAT_FLOOR,
  PRUNE_BATCH,
} from "../webmind/salience-prune.js";
import { MACHINE_SOURCES } from "../webmind/notes.js";
import { effectiveHeatSql } from "../webmind/heat.js";
import { vectorId } from "../mcp/embed.js";
import type { Env } from "../types.js";

beforeEach(() => vi.clearAllMocks());

// --- (1) Behavioral: canned SELECT results drive archive/warm/delete -------------

function makeEnv(selectResults: { id: string }[][]) {
  // Each call to the candidate SELECT pops the next canned result set (so a
  // test can simulate "first call finds a row, second call finds nothing").
  const queue = [...selectResults];
  const updateCalls: unknown[][] = [];
  const preparedSql: string[] = [];
  const deleteByIds = vi.fn(async (_ids: string[]) => {});

  const env = {
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return {
          bind: (...args: unknown[]) => ({
            all: async () => {
              if (sql.includes("SELECT id FROM companion_journal")) {
                return { results: queue.shift() ?? [] };
              }
              return { results: [] };
            },
            run: async () => {
              if (sql.includes("UPDATE companion_journal SET archived = 1")) {
                updateCalls.push(args);
              }
              return { meta: { changes: args.length } };
            },
          }),
        };
      },
    },
    VECTORIZE: { deleteByIds },
  };
  return { env: env as unknown as Env, updateCalls, deleteByIds, preparedSql };
}

describe("runSaliencePrune -- behavioral (canned SELECT results)", () => {
  it("archives exactly the ids the candidate SELECT returns, and best-effort deletes their vectors", async () => {
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }, { id: "m2" }]]);

    const result = await runSaliencePrune(env);

    expect(result).toEqual({ archived: 2 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual(["m1", "m2"]);
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds).toHaveBeenCalledWith([
      vectorId("companion_journal", "m1"),
      vectorId("companion_journal", "m2"),
    ]);
  });

  it("is a no-op when the candidate SELECT returns nothing -- no UPDATE, no vector delete", async () => {
    const { env, updateCalls, deleteByIds } = makeEnv([[]]);

    const result = await runSaliencePrune(env);

    expect(result).toEqual({ archived: 0 });
    expect(updateCalls).toHaveLength(0);
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("is idempotent -- once a row is archived it drops out of the next SELECT, and a re-run no-ops", async () => {
    // First call: the SELECT (archived = 0 in its WHERE clause) finds the row.
    // Second call: the row is now archived=1 in the real DB, so a real re-run
    // of the same SELECT would exclude it -- simulated here by an empty queue entry.
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }], []]);

    const first = await runSaliencePrune(env);
    expect(first).toEqual({ archived: 1 });

    const second = await runSaliencePrune(env);
    expect(second).toEqual({ archived: 0 });
    expect(updateCalls).toHaveLength(1); // still just the first run's UPDATE
    expect(deleteByIds).toHaveBeenCalledTimes(1); // still just the first run's delete
  });

  it("still archives (D1 write already committed) when vector deletion throws -- best-effort", async () => {
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }]]);
    deleteByIds.mockRejectedValueOnce(new Error("vectorize unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runSaliencePrune(env);

    expect(result).toEqual({ archived: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("never issues a DELETE against companion_journal -- archive only, D1 row kept", async () => {
    const { env, preparedSql } = makeEnv([[{ id: "m1" }]]);
    await runSaliencePrune(env);

    expect(preparedSql.some((sql) => /DELETE\s+FROM\s+companion_journal/i.test(sql))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("UPDATE companion_journal SET archived = 1"))).toBe(true);
  });
});

// --- (2) Structural: the real generated SQL encodes the right WHERE clause -------

function captureCandidateSql(): { env: Env; getSql: () => string; getBoundSources: () => unknown[] } {
  let candidateSql = "";
  let boundSources: unknown[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => {
            if (sql.includes("SELECT id FROM companion_journal")) {
              candidateSql = sql;
              boundSources = args;
            }
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    },
    VECTORIZE: { deleteByIds: vi.fn() },
  } as unknown as Env;
  return { env, getSql: () => candidateSql, getBoundSources: () => boundSources };
}

describe("runSaliencePrune -- structural SQL proof", () => {
  it("scopes the candidate SELECT to archived = 0", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env);
    expect(getSql()).toContain("archived = 0");
  });

  it("binds the source IN (...) list to EXACTLY the MACHINE_SOURCES set -- the structural proof that " +
     "human/NULL/legacy/unclassified sources can never match and are therefore never archived", async () => {
    const { env, getSql, getBoundSources } = captureCandidateSql();
    await runSaliencePrune(env);

    expect(getSql()).toMatch(/source IN \((\?,\s*)*\?\)/);
    expect(new Set(getBoundSources())).toEqual(MACHINE_SOURCES);
    expect(getBoundSources()).toHaveLength(MACHINE_SOURCES.size);
  });

  it("requires the row to be older than PRUNE_MIN_AGE_DAYS", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env);
    expect(getSql()).toContain(`datetime('now', '-${PRUNE_MIN_AGE_DAYS} days')`);
    expect(getSql()).toContain("created_at <");
  });

  it("requires effective heat (via the real effectiveHeatSql()) below PRUNE_HEAT_FLOOR", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env);
    expect(getSql()).toContain(effectiveHeatSql());
    expect(getSql()).toContain(`${effectiveHeatSql()} < ${PRUNE_HEAT_FLOOR}`);
  });

  it("bounds the batch to PRUNE_BATCH rows", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env);
    expect(getSql()).toContain(`LIMIT ${PRUNE_BATCH}`);
  });
});

// --- POST /mind/salience/prune -- manual/testing trigger, admin-auth gated --------

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("https://test.local/mind/salience/prune", { method: "POST", headers });
}

describe("postSaliencePrune", () => {
  it("denies (401) without a valid admin/companion token", async () => {
    const env = { ADMIN_SECRET: "admin-secret" } as unknown as Env;
    const res = await postSaliencePrune(makeRequest(), env);
    expect(res.status).toBe(401);
  });

  it("denies (401) when ADMIN_SECRET is unset (fail closed)", async () => {
    const env = { ADMIN_SECRET: undefined } as unknown as Env;
    const res = await postSaliencePrune(makeRequest("Bearer whatever"), env);
    expect(res.status).toBe(401);
  });

  it("runs the prune and returns { ok: true, archived } on valid admin auth", async () => {
    const { env, updateCalls } = makeEnv([[{ id: "m1" }]]);
    (env as unknown as Record<string, unknown>).ADMIN_SECRET = "admin-secret";

    const res = await postSaliencePrune(makeRequest("Bearer admin-secret"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; archived: number };
    expect(body).toEqual({ ok: true, archived: 1 });
    expect(updateCalls).toHaveLength(1);
  });
});
