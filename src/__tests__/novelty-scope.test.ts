// The novelty gate's SCOPE (2026-09-24).
//
// architect_facts was the one write path with no duplicate check, and it showed: 76 held facts
// contained 29 rows describing six subjects. The obvious fix -- reuse the conclusions gate --
// would have been a near no-op for two separate reasons, both measured on prod the same day:
//
//   1. architect_facts was never in Vectorize at all, so there was nothing to match against.
//   2. The gate filters by companion, and 5 of the 9 duplicate clusters spanned MORE THAN ONE
//      companion. The largest (six rows about Rosie and Trigger) was written by all three.
//
// (2) is the one this file pins. A fact is about Raziel; it does not belong to whoever noticed
// it. A conclusion is the opposite and must stay companion-scoped: two companions reaching the
// same belief independently is signal, not duplication.

import { describe, it, expect, vi } from "vitest";
import { noveltyCheck } from "../webmind/novelty.js";

// `liveIds` are the row ids D1 reports as still active. The architect_facts post-filter checks
// this, so a mock that returns nothing makes every match vanish -- which is the filter working,
// but it would let these tests pass for the wrong reason.
function envWith(
  queryImpl: (v: number[], o: { filter?: Record<string, unknown> }) => unknown,
  liveIds: string[] = [],
) {
  const seen: Array<Record<string, unknown> | undefined> = [];
  return {
    seen,
    env: {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      VECTORIZE: {
        query: vi.fn(async (v: number[], o: { filter?: Record<string, unknown> }) => {
          seen.push(o?.filter);
          return queryImpl(v, o);
        }),
      },
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: liveIds.map(id => ({ id })) }) }) }) },
    } as never,
  };
}

describe("noveltyCheck scope", () => {
  it("defaults to COMPANION scope, so every existing caller is unchanged", async () => {
    const { env, seen } = envWith(() => ({ matches: [] }));
    await noveltyCheck(env, "some belief", "companion_conclusions", "drevan");
    expect(seen[0]).toEqual({ table: "companion_conclusions", companion_id: "drevan" });
  });

  it('with scope "table", drops the companion filter', async () => {
    // This is the whole point: Drevan writing about Rosie must dedupe against Gaia's and
    // Cypher's rows about Rosie, because it is the same fact about the same dog.
    const { env, seen } = envWith(() => ({ matches: [] }));
    await noveltyCheck(env, "Rosie is an Australian Shepherd", "architect_facts", "drevan", "table");
    expect(seen[0]).toEqual({ table: "architect_facts" });
    expect(seen[0]).not.toHaveProperty("companion_id");
  });

  it("fails OPEN when the embedder is unavailable -- the gate must never eat a fact", async () => {
    const env = {
      AI: { run: vi.fn(async () => { throw new Error("quota"); }) },
      VECTORIZE: { query: vi.fn() },
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as never;
    const d = await noveltyCheck(env, "anything", "architect_facts", "drevan", "table");
    expect(d.action).toBe("insert");
  });

  it("never auto-supersedes a FACT, even in the supersede band", async () => {
    // Retiring a fact is irreversible by design, and rows that look like restatements are
    // usually PARTIAL RECORDS of one subject -- a naive merge of the Rosie cluster would have
    // deleted Lucy, Abby and the entire flock. Near-identical (>=0.95) is safe to skip; anything
    // less is a consolidation question for Raziel, not a machine's call.
    const { env } = envWith(() => ({ matches: [{ id: "architect_facts:abc", score: 0.9 }] }), ["abc"]);
    const d = await noveltyCheck(env, "Rosie is a retired service dog", "architect_facts", "drevan", "table");
    expect(d.action).toBe("insert");
  });

  it("DOES skip a near-identical fact", async () => {
    const { env } = envWith(() => ({ matches: [{ id: "architect_facts:abc", score: 0.97 }] }), ["abc"]);
    const d = await noveltyCheck(env, "Rosie is a retired service dog", "architect_facts", "drevan", "table");
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.matchRowId).toBe("abc");
  });
});

describe("noveltyCheck -- retired facts", () => {
  it("ignores a RETIRED fact's surviving vector", async () => {
    // The supersede path only best-effort deletes vectors, so a dead row's vector can outlive it.
    // Matching one would hand back "I already know that" about a fact nothing renders any more --
    // the system claiming a memory it has actually forgotten.
    const { env } = envWith(() => ({ matches: [{ id: "architect_facts:dead", score: 0.99 }] }), []);
    const d = await noveltyCheck(env, "something", "architect_facts", "drevan", "table");
    expect(d.action).toBe("insert");
  });
});
