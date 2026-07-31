// src/__tests__/conclusions-novelty.test.ts
//
// Novelty gate wired into postConclusion (handlers/conclusions.ts). Mirrors the
// mock style of conclusions-worldview.test.ts, extended with AI/VECTORIZE stubs
// so noveltyCheck (src/webmind/novelty.ts) runs for real against a fake top match.

import { describe, it, expect, vi } from "vitest";
import { postConclusion } from "../handlers/conclusions.js";
import { vectorId } from "../mcp/embed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("https://test.local/companion-conclusions", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface Captured {
  prepared: string[];
  binds: unknown[][];
}

/** Minimal env: D1 stub that records every prepare()+bind() call, plus AI/VECTORIZE
 *  stubs so noveltyCheck resolves against a caller-supplied top match. */
function makeEnv(matches: Array<{ id: string; score: number }>, captured: Captured): any {
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (...args: unknown[]) => {
            captured.prepared.push(sql);
            captured.binds.push(args);
            return {
              ...stmt,
              // noveltyCheck's dead-vector post-filter (2026-07-20 review): echo back every
              // bound id as "active" -- these tests assert the gate matches a live row, not
              // a superseded one, so the post-filter must be a no-op by default here.
              all: async () => (
                sql.includes("SELECT id FROM companion_conclusions") && sql.includes("superseded_by IS NULL")
                  ? { results: args.map((id) => ({ id })) }
                  : { results: [] }
              ),
            };
          },
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
      deleteByIds: vi.fn(async () => undefined),
    },
  };
}

const BASE_BODY = {
  companion_id: "cypher",
  conclusion_text: "the architecture holds",
};

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
// Novelty gate
// ---------------------------------------------------------------------------

describe("postConclusion -- novelty gate", () => {
  it("skips on a near-identical match (score 0.97) -- 200, deduped, NO INSERT", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:existing123", score: 0.97 }], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deduped).toBe(true);
    expect(body.id).toBe("existing123");
    expect(body.novelty).toEqual({ action: "skip", match_id: "existing123", score: 0.97 });
    expect(insertCalls(captured)).toBe(0);
  });

  // REPLACED 2026-07-31 (mig 0112). This asserted a 0.90 gate match RETIRED the older belief. It no
  // longer does: Raziel's decision is that a companion supersedes their own thought. Every read filters
  // `superseded_by IS NULL`, so the old behaviour let a cosine score silently delete a belief from view
  // -- and an inferring pass had already recorded something false about his relationship with Drevan,
  // which is why a machine no longer gets that call. Inverted rather than deleted, so the change stays
  // pinned. This handler is the THIRD of three writers of the same rule.
  it("a 0.90 gate match PROPOSES only -- older belief stays live, no UPDATE", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.id).toBe("string");
    expect(body.superseded).toBeFalsy();
    expect(insertCalls(captured)).toBe(1);
    expect(supersedeUpdateFor(captured, "oldrow456")).toBeUndefined();

    // The candidate is persisted on the new row so the companion can be asked later.
    const insertIdx = captured.prepared.findIndex((sql) => sql.includes("INSERT INTO companion_conclusions"));
    expect(captured.binds[insertIdx]).toContain("oldrow456");

    // Embedding reused from the gate -- no second AI.run, one Vectorize upsert. Unchanged.
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("inserts plainly below the supersede threshold (score 0.5)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:unrelated", score: 0.5 }], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.novelty).toEqual({ action: "insert" });
    expect(insertCalls(captured)).toBe(1);
    expect(captured.prepared.some((sql) => sql.includes("UPDATE companion_conclusions SET superseded_by"))).toBe(false);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("plain insert (no similar matches) still succeeds and stores a vector", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.novelty).toEqual({ action: "insert" });
    expect(insertCalls(captured)).toBe(1);
  });
});

// Source-side vector cleanup (2026-07-20 review): when a supersede fires, the OLD row's
// vector must be best-effort deleted so it can never resurface as a future novelty-gate
// match. Mirrors salience-prune.ts's pattern: a delete failure must never affect the write.
describe("postConclusion -- supersede deletes the OLD row's vector", () => {
  // REPLACED 2026-07-31 (mig 0112): a merely-PROPOSED match keeps its vector. Deleting it would pull a
  // still-live belief out of semantic recall and out of future gate comparisons -- a silent partial
  // erasure that no read would reveal. The caller-declared case below still deletes, and is unchanged.
  it("a gate-PROPOSED match does not delete the older belief's vector", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });

  it("caller-declared `supersedes` also calls VECTORIZE.deleteByIds with that OLD row's vector id", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured); // no gate match -- purely caller-declared

    const res = await postConclusion(makeRequest({ ...BASE_BODY, supersedes: "caller-old-1" }), env);

    expect(res.status).toBe(200);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith([vectorId("companion_conclusions", "caller-old-1")]);
  });

  // Still guards exactly what it always guarded -- D1 is truth, the index is rebuildable, a Vectorize
  // hiccup must never fail a committed write. Retargeted 2026-07-31 (mig 0112) to a CALLER-DECLARED
  // supersede, because that is now the only path that deletes a vector; a gate match merely proposes and
  // never deletes, so driving this through the gate would have exercised nothing.
  it("a deleteByIds failure never affects the write or the response", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured);
    env.VECTORIZE.deleteByIds = vi.fn(async () => { throw new Error("vectorize delete 500"); });

    const res = await postConclusion(makeRequest({ ...BASE_BODY, supersedes: "oldrow456" }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.superseded).toBe("oldrow456");
    expect(insertCalls(captured)).toBe(1);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalled();
  });

  it("plain insert (no supersede) never calls deleteByIds", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:unrelated", score: 0.5 }], captured);

    await postConclusion(makeRequest(BASE_BODY), env);

    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });
});
