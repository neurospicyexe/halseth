// Task 20 (thinking-quality fix, mig 0105): the salience-prune tick.
// runSaliencePrune archives (archived=1, never deletes) machine-source
// companion_journal rows that are BOTH old (PRUNE_MIN_AGE_DAYS+) AND cold
// (effective heat < PRUNE_HEAT_FLOOR). Human-source and unknown/NULL-source
// rows must never be archived.
//
// Live-verification follow-up (post-Task-20): the cron this rides fires every
// MINUTE (`*/1 * * * *`), not daily -- the candidate SELECT (a full companion_journal
// scan evaluating effectiveHeatSql per row) was firing 1440x/day. Fixed with a 24h
// self-gate inside runSaliencePrune, stamped in companion_settings under a sentinel
// companion_id + a key no other job reads (see PRUNE_GATE_COMPANION_ID/PRUNE_GATE_KEY).
//
// Three layers of proof:
//  (1) Behavioral -- a canned-row mock controls exactly what the SELECT
//      returns; assert the archive/vector-delete/idempotent behavior given
//      those rows. Forced (bypasses the gate) so these test archive logic in
//      isolation from gate state.
//  (2) Structural -- capture the REAL generated SQL text and bound args and
//      assert the WHERE clause actually encodes archived=0, the age floor,
//      the heat floor (via the real effectiveHeatSql()), and -- the load-
//      bearing proof of "human/NULL/legacy sources never archived" -- that
//      the source IN (...) list is bound to EXACTLY the MACHINE_SOURCES set,
//      structurally excluding every other source by construction.
//  (3) Gate -- the 24h self-gate: blocks an unforced second run within the
//      window, force bypasses it, and the stamp is provably the prune's own
//      (a distinct table/key from anything fermentation or any other job reads).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runSaliencePrune,
  postSaliencePrune,
  PRUNE_MIN_AGE_DAYS,
  PRUNE_HEAT_FLOOR,
  PRUNE_BATCH,
  PRUNE_GATE_HOURS,
  PRUNE_GATE_COMPANION_ID,
  PRUNE_GATE_KEY,
} from "../webmind/salience-prune.js";
import { MACHINE_SOURCES } from "../webmind/notes.js";
import { COMPANION_IDS } from "../companions.js";
import { effectiveHeatSql } from "../webmind/heat.js";
import { vectorId } from "../mcp/embed.js";
import type { Env } from "../types.js";

beforeEach(() => vi.clearAllMocks());

// --- shared fake D1: candidate SELECT (canned queue) + gate check/stamp ----------

function makeEnv(selectResults: { id: string }[][], opts: { gateLastRunIso?: string | null } = {}) {
  // Each call to the candidate SELECT pops the next canned result set (so a
  // test can simulate "first call finds a row, second call finds nothing").
  const queue = [...selectResults];
  const updateCalls: unknown[][] = [];
  const preparedSql: string[] = [];
  const gateStampCalls: unknown[][] = [];
  const deleteByIds = vi.fn(async (_ids: string[]) => {});
  let gateValue: string | null = opts.gateLastRunIso ?? null;

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
            first: async () => {
              if (sql.includes("FROM companion_settings")) {
                return gateValue !== null ? { value: gateValue } : null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes("UPDATE companion_journal SET archived = 1")) {
                updateCalls.push(args);
              }
              if (sql.includes("INSERT INTO companion_settings")) {
                gateStampCalls.push(args);
                gateValue = args[2] as string;
              }
              return { meta: { changes: args.length } };
            },
          }),
        };
      },
    },
    VECTORIZE: { deleteByIds },
  };
  return { env: env as unknown as Env, updateCalls, deleteByIds, preparedSql, gateStampCalls };
}

function candidateSelectCount(preparedSql: string[]): number {
  return preparedSql.filter((sql) => sql.includes("SELECT id FROM companion_journal")).length;
}

// --- (1) Behavioral: canned SELECT results drive archive/delete (forced, gate-agnostic) --

describe("runSaliencePrune -- behavioral (canned SELECT results, forced)", () => {
  it("archives exactly the ids the candidate SELECT returns, and best-effort deletes their vectors", async () => {
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }, { id: "m2" }]]);

    const result = await runSaliencePrune(env, { force: true });

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

    const result = await runSaliencePrune(env, { force: true });

    expect(result).toEqual({ archived: 0 });
    expect(updateCalls).toHaveLength(0);
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("is idempotent at the D1 level -- once a row is archived it drops out of the next SELECT", async () => {
    // First call: the SELECT (archived = 0 in its WHERE clause) finds the row.
    // Second call: the row is now archived=1 in the real DB, so a real re-run
    // of the same SELECT would exclude it -- simulated here by an empty queue entry.
    // Both calls force past the gate so this isolates D1-row idempotency from
    // the (separately tested) 24h gate idempotency.
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }], []]);

    const first = await runSaliencePrune(env, { force: true });
    expect(first).toEqual({ archived: 1 });

    const second = await runSaliencePrune(env, { force: true });
    expect(second).toEqual({ archived: 0 });
    expect(updateCalls).toHaveLength(1); // still just the first run's UPDATE
    expect(deleteByIds).toHaveBeenCalledTimes(1); // still just the first run's delete
  });

  it("still archives (D1 write already committed) when vector deletion throws -- best-effort", async () => {
    const { env, updateCalls, deleteByIds } = makeEnv([[{ id: "m1" }]]);
    deleteByIds.mockRejectedValueOnce(new Error("vectorize unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runSaliencePrune(env, { force: true });

    expect(result).toEqual({ archived: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("never issues a DELETE against companion_journal -- archive only, D1 row kept", async () => {
    const { env, preparedSql } = makeEnv([[{ id: "m1" }]]);
    await runSaliencePrune(env, { force: true });

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
          first: async () => null,
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
    await runSaliencePrune(env, { force: true });
    expect(getSql()).toContain("archived = 0");
  });

  it("binds the source IN (...) list to EXACTLY the MACHINE_SOURCES set -- the structural proof that " +
     "human/NULL/legacy/unclassified sources can never match and are therefore never archived", async () => {
    const { env, getSql, getBoundSources } = captureCandidateSql();
    await runSaliencePrune(env, { force: true });

    expect(getSql()).toMatch(/source IN \((\?,\s*)*\?\)/);
    expect(new Set(getBoundSources())).toEqual(MACHINE_SOURCES);
    expect(getBoundSources()).toHaveLength(MACHINE_SOURCES.size);
  });

  it("requires the row to be older than PRUNE_MIN_AGE_DAYS", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env, { force: true });
    expect(getSql()).toContain(`datetime('now', '-${PRUNE_MIN_AGE_DAYS} days')`);
    expect(getSql()).toContain("created_at <");
  });

  it("requires effective heat (via the real effectiveHeatSql()) below PRUNE_HEAT_FLOOR", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env, { force: true });
    expect(getSql()).toContain(effectiveHeatSql());
    expect(getSql()).toContain(`${effectiveHeatSql()} < ${PRUNE_HEAT_FLOOR}`);
  });

  it("bounds the batch to PRUNE_BATCH rows", async () => {
    const { env, getSql } = captureCandidateSql();
    await runSaliencePrune(env, { force: true });
    expect(getSql()).toContain(`LIMIT ${PRUNE_BATCH}`);
  });
});

// --- (3) Gate: 24h self-gate, force bypass, prune-own stamp ----------------------

describe("runSaliencePrune -- 24h self-gate (the cron fires every minute, not daily)", () => {
  it("blocks an unforced second run within the 24h window -- the candidate SELECT never re-fires", async () => {
    const { env, updateCalls, preparedSql } = makeEnv([[{ id: "m1" }], [{ id: "m2" }]]);

    const first = await runSaliencePrune(env); // unforced: no prior stamp, gate passes
    expect(first).toEqual({ archived: 1 });
    expect(candidateSelectCount(preparedSql)).toBe(1);

    const second = await runSaliencePrune(env); // unforced: stamp is <24h old, gate blocks
    expect(second).toEqual({ archived: 0 });
    expect(candidateSelectCount(preparedSql)).toBe(1); // no second candidate SELECT at all
    expect(updateCalls).toHaveLength(1); // no second archive
  });

  it("does not block when the prior stamp is already 24h+ old", async () => {
    const staleIso = new Date(Date.now() - (PRUNE_GATE_HOURS + 1) * 60 * 60 * 1000).toISOString();
    const { env, preparedSql } = makeEnv([[{ id: "m1" }]], { gateLastRunIso: staleIso });

    const result = await runSaliencePrune(env); // unforced, but stamp is stale -- gate passes
    expect(result).toEqual({ archived: 1 });
    expect(candidateSelectCount(preparedSql)).toBe(1);
  });

  it("force bypasses the gate even immediately after a run", async () => {
    const { env, updateCalls, preparedSql } = makeEnv([[{ id: "m1" }], [{ id: "m2" }]]);

    const first = await runSaliencePrune(env); // establishes a fresh stamp
    expect(first).toEqual({ archived: 1 });

    const forced = await runSaliencePrune(env, { force: true }); // bypasses the fresh stamp
    expect(forced).toEqual({ archived: 1 }); // second queued row
    expect(candidateSelectCount(preparedSql)).toBe(2);
    expect(updateCalls).toHaveLength(2);
  });

  it("does not stamp (and does not scan) when gated out -- a blocked call performs no work at all", async () => {
    const { env, preparedSql, gateStampCalls } = makeEnv([[{ id: "m1" }], [{ id: "should-not-be-reached" }]]);

    await runSaliencePrune(env);
    expect(gateStampCalls).toHaveLength(1); // the first, real run stamped once

    await runSaliencePrune(env); // gated -- must not scan, must not re-stamp
    expect(candidateSelectCount(preparedSql)).toBe(1);
    expect(gateStampCalls).toHaveLength(1);
  });

  it("still stamps a completed run that found nothing to archive -- re-arms the 24h window", async () => {
    const { env, gateStampCalls } = makeEnv([[]]);
    const result = await runSaliencePrune(env);
    expect(result).toEqual({ archived: 0 });
    expect(gateStampCalls).toHaveLength(1); // ran (found nothing), still a completed run
  });

  it("the gate stamp is the prune's OWN key -- not a companion id, not any other job's settings key, " +
     "not fermentation's storage at all (a different table entirely)", async () => {
    // Structural identity checks, not behavior: PRUNE_GATE_COMPANION_ID must not collide
    // with a real companion (drevan/cypher/gaia -- what fermentation's per-companion
    // ferment_at column is keyed on), and PRUNE_GATE_KEY must not collide with any other
    // known companion_settings key already in use (active_model, tools_enabled,
    // imps_enabled, hex_enabled) -- a simple key-name assertion per the fix brief.
    expect((COMPANION_IDS as readonly string[])).not.toContain(PRUNE_GATE_COMPANION_ID);

    const otherKnownSettingsKeys = ["active_model", "tools_enabled", "imps_enabled", "hex_enabled"];
    expect(otherKnownSettingsKeys).not.toContain(PRUNE_GATE_KEY);

    // And the actual write: capture the real INSERT and assert it binds exactly this
    // sentinel id + key, into companion_settings -- never companion_ferment_state,
    // never a `ferment_at` column (fermentation's stamp lives in a wholly different
    // table this job never touches).
    const { env, gateStampCalls, preparedSql } = makeEnv([[]]);
    await runSaliencePrune(env);

    expect(gateStampCalls).toHaveLength(1);
    expect(gateStampCalls[0]![0]).toBe(PRUNE_GATE_COMPANION_ID);
    expect(gateStampCalls[0]![1]).toBe(PRUNE_GATE_KEY);
    expect(preparedSql.some((sql) => sql.includes("companion_ferment_state") || sql.includes("ferment_at"))).toBe(false);
  });

  it("a thrown error before the stamp leaves the gate unwritten -- a failed run is retried next tick, never falsely gated", async () => {
    const stampCalls: unknown[][] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => null, // never run before -- gate passes
            all: async () => {
              if (sql.includes("SELECT id FROM companion_journal")) throw new Error("D1 unavailable");
              return { results: [] };
            },
            run: async () => {
              if (sql.includes("INSERT INTO companion_settings")) stampCalls.push(args);
              return { meta: { changes: 0 } };
            },
          }),
        }),
      },
      VECTORIZE: { deleteByIds: vi.fn() },
    } as unknown as Env;

    await expect(runSaliencePrune(env)).rejects.toThrow("D1 unavailable");
    // The actual claim this test makes: the scan's throw propagates BEFORE
    // stampPruneGate ever runs, so a failed attempt is never falsely gated for
    // 24h. Assert the stamp write count directly -- not just that it rejected --
    // so a future refactor that wraps the scan in a try/catch (silently falling
    // through to the stamp on failure) fails this test instead of passing it.
    expect(stampCalls).toHaveLength(0);
  });
});

// --- POST /mind/salience/prune -- manual/testing trigger, admin-auth gated, forced --

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

  it("bypasses the gate -- the manual trigger runs even immediately after a cron run stamped it", async () => {
    const { env, updateCalls } = makeEnv([[{ id: "m1" }], [{ id: "m2" }]]);
    (env as unknown as Record<string, unknown>).ADMIN_SECRET = "admin-secret";

    await runSaliencePrune(env); // simulates the cron's unforced run, stamps the gate
    expect(updateCalls).toHaveLength(1);

    const res = await postSaliencePrune(makeRequest("Bearer admin-secret"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; archived: number };
    expect(body).toEqual({ ok: true, archived: 1 }); // second queued row, not gated out
    expect(updateCalls).toHaveLength(2);
  });
});
