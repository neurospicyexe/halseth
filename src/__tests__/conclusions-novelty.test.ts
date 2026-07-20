// src/__tests__/conclusions-novelty.test.ts
//
// Novelty gate wired into postConclusion (handlers/conclusions.ts). Mirrors the
// mock style of conclusions-worldview.test.ts, extended with AI/VECTORIZE stubs
// so noveltyCheck (src/webmind/novelty.ts) runs for real against a fake top match.

import { describe, it, expect, vi } from "vitest";
import { postConclusion } from "../handlers/conclusions.js";

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
            return stmt;
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

  it("supersedes on a 0.90 match -- inserts new row AND marks the old one superseded", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_conclusions:oldrow456", score: 0.90 }], captured);

    const res = await postConclusion(makeRequest(BASE_BODY), env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.id).toBe("string");
    expect(body.novelty).toMatchObject({ action: "supersede", match_id: "oldrow456", score: 0.90 });
    expect(insertCalls(captured)).toBe(1);

    const updateBind = supersedeUpdateFor(captured, "oldrow456");
    expect(updateBind).toBeDefined();
    expect(updateBind).toEqual([body.id, "oldrow456", "cypher"]);

    // Embedding reused from the gate -- no second AI.run, one Vectorize upsert.
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
