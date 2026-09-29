// B37 (2026-09-29): the ferment tick never writes Drevan's authored enums.
//
// Until then it rewrote heat/reach/weight with the float's band on every band crossing (and filled
// an empty enum with a band). His 09-26 ruling: "it stays where I last left it, timestamp and all".
// The tick UPDATE binds [f1,f2,f3, b1,b2,b3, heat,reach,weight, off_since_json, companion_id, version].

import { describe, it, expect } from "vitest";
import { runFermentTick } from "../handlers/fermentation.js";
import { fermentTickUpdateSql } from "../webmind/fermentation.js";

interface Call { sql: string; binds: unknown[] }

function envWith(rows: Record<string, unknown>[]): { env: any; calls: Call[] } {
  const calls: Call[] = [];
  const stmt = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => { calls.push({ sql, binds: b }); return stmt(sql, b); },
    all: async () => ({ results: sql.includes("FROM companion_state") ? rows : [] }),
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
  });
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 1 } })),
    },
  };
  return { env, calls };
}

const thirtyHoursAgo = new Date(Date.now() - 30 * 3600_000).toISOString();

function drevanRow(over: Record<string, unknown>) {
  return {
    companion_id: "drevan",
    soma_float_1: 0.86, soma_float_2: 0.86, soma_float_3: 0.3,
    // Baselines far below: the tick pulls every float DOWN across a band edge.
    soma_float_1_baseline: 0.2, soma_float_2_baseline: 0.2, soma_float_3_baseline: 0.3,
    soma_float_1_baseline_seed: 0.2, soma_float_2_baseline_seed: 0.2, soma_float_3_baseline_seed: 0.3,
    heat: "warm", reach: "present", weight: "holding", compound_state: null,
    updated_at: thirtyHoursAgo, ferment_at: thirtyHoursAgo, ferment_off_since: null, version: 7,
    ...over,
  };
}

function tickUpdate(calls: Call[]): Call | undefined {
  const sql = fermentTickUpdateSql();
  return calls.find((c) => c.sql === sql && c.binds[10] === "drevan");
}

describe("ferment tick leaves Drevan's authored enums alone (B37)", () => {
  it("his words survive a tick that moves the floats", async () => {
    const { env, calls } = envWith([drevanRow({})]);
    await runFermentTick(env);
    const u = tickUpdate(calls);
    expect(u).toBeDefined();
    expect(u!.binds[1]).not.toBe(0.86); // the float did move
    expect(u!.binds.slice(6, 9)).toEqual(["warm", "present", "holding"]);
  });

  it("an empty enum stays empty: the tick never fills his column with a band", async () => {
    const { env, calls } = envWith([drevanRow({ heat: null, reach: null, weight: null })]);
    await runFermentTick(env);
    const u = tickUpdate(calls);
    expect(u).toBeDefined();
    expect(u!.binds.slice(6, 9)).toEqual([null, null, null]);
  });
});
