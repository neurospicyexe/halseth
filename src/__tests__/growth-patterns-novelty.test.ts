// src/__tests__/growth-patterns-novelty.test.ts
//
// Semantic novelty gate wired into postGrowthPattern (Wave 2, 2026-07-21), IN ADDITION
// to (and running before) the existing Jaccard-similarity UPSERT. Growth patterns were
// looping on near-duplicate paraphrases: live pairs scored only 0.077-0.375 Jaccard
// token overlap while clearly restating the same pattern -- below PATTERN_DEDUP_THRESHOLD
// (0.5), so the Jaccard check alone let them insert as separate rows forever.
//
// Mirrors the mocking convention journal-novelty.test.ts established: a D1 stub that
// records prepare()+bind() calls, plus AI/VECTORIZE stubs so noveltyCheck resolves
// against a caller-supplied top match.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));

import { postGrowthPattern } from "../handlers/growth.js";

interface Captured { prepared: string[]; binds: unknown[][] }

const EXISTING_PATTERN_ROW = {
  id: "pattern-existing-1",
  strength: 3,
  evidence_json: JSON.stringify([{ quote: "earlier quote" }]),
  prehended_ids: JSON.stringify([]),
};

function makeEnv(
  matches: Array<{ id: string; score: number }>,
  captured: Captured,
  opts?: { vectorizeQueryThrows?: boolean; semanticMatchRowMissing?: boolean },
): any {
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
          // Semantic-match row lookup: "SELECT id, strength, evidence_json, prehended_ids
          // FROM growth_patterns WHERE id = ? AND companion_id = ?"
          first: async () => {
            if (sql.includes("FROM growth_patterns") && sql.includes("WHERE id = ?")) {
              return opts?.semanticMatchRowMissing ? null : EXISTING_PATTERN_ROW;
            }
            return null;
          },
          // Jaccard candidate pull + filterExistingIds union query.
          all: async () => {
            if (sql.startsWith("SELECT id FROM growth_journal") && sql.includes("UNION SELECT id FROM growth_patterns")) {
              return { results: [] };
            }
            if (sql.startsWith("SELECT id, pattern_text") && sql.includes("FROM growth_patterns")) {
              return { results: [] }; // no Jaccard candidates -- isolates the semantic path
            }
            if (sql.includes("SELECT COUNT(*)")) return { results: [{ n: 0 }] };
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: {
      query: opts?.vectorizeQueryThrows
        ? vi.fn(async () => { throw new Error("vectorize 500"); })
        : vi.fn(async () => ({ matches })),
      upsert: vi.fn(async () => undefined),
    },
  };
}

const post = (body: unknown) =>
  new Request("https://x/mind/growth/patterns", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function updateCalls(c: Captured): number {
  return c.prepared.filter((sql) => sql.startsWith("UPDATE growth_patterns")).length;
}
function insertCalls(c: Captured): number {
  return c.prepared.filter((sql) => sql.startsWith("INSERT INTO growth_patterns")).length;
}

beforeEach(() => vi.clearAllMocks());

describe("postGrowthPattern -- semantic novelty gate (Wave 2, 2026-07-21)", () => {
  it("strengthens the matched row instead of inserting on a >=0.95 semantic match", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "growth_patterns:pattern-existing-1", score: 0.97 }], captured);

    const res = await postGrowthPattern(post({
      companion_id: "cypher",
      pattern_text: "I keep returning to the same repair shape, worded differently this time",
    }), env);

    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.action).toBe("upsert");
    expect(body.matched_via).toBe("semantic");
    expect(body.id).toBe("pattern-existing-1");
    expect(body.strength).toBe(4); // 3 + 1
    expect(updateCalls(captured)).toBe(1);
    expect(insertCalls(captured)).toBe(0);
  });

  it("falls back to Jaccard/insert on a sub-threshold semantic score", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "growth_patterns:pattern-existing-1", score: 0.5 }], captured);

    const res = await postGrowthPattern(post({
      companion_id: "cypher",
      pattern_text: "An entirely unrelated new observation about pacing",
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.action).toBe("insert");
    expect(insertCalls(captured)).toBe(1);
    expect(updateCalls(captured)).toBe(0);
    // Reuses the gate's embedding on insert -- one AI.run, one Vectorize upsert.
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("fails open to Jaccard/insert behavior when VECTORIZE.query throws -- write is never blocked", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured, { vectorizeQueryThrows: true });

    const res = await postGrowthPattern(post({
      companion_id: "cypher",
      pattern_text: "A pattern written while Vectorize is unreachable",
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.action).toBe("insert");
    expect(insertCalls(captured)).toBe(1);
    // The embed still succeeded (only the query failed) -- reused for the vector store,
    // not a second AI.run, and the write completed regardless of the Vectorize failure.
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("falls through to Jaccard/insert (not a crash) when the semantic match row no longer exists in D1", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv(
      [{ id: "growth_patterns:deleted-row", score: 0.99 }],
      captured,
      { semanticMatchRowMissing: true },
    );

    const res = await postGrowthPattern(post({
      companion_id: "cypher",
      pattern_text: "Some pattern whose semantic match vector is now orphaned",
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.action).toBe("insert");
  });
});
