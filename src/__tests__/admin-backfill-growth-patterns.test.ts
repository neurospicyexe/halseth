// src/__tests__/admin-backfill-growth-patterns.test.ts
//
// growth_patterns was added to backfillEmbeddings' TABLES map (Wave 2, 2026-07-21) so
// the ~98 prod rows that predate the semantic novelty gate can be embedded via one
// admin call: POST /admin/backfill-embeddings?table=growth_patterns.

import { describe, it, expect, vi } from "vitest";
import { backfillEmbeddings } from "../handlers/admin.js";

function req(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer admin-tok" },
  });
}

describe("backfillEmbeddings -- growth_patterns table wiring", () => {
  it("recognizes ?table=growth_patterns instead of 400ing as an unknown table", async () => {
    const rows = [{ id: "p1", pattern_text: "I keep returning to repair architecture", companion_id: "cypher" }];
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    };
    const env = {
      ADMIN_SECRET: "admin-tok",
      DB: fakeDb,
      AI: { run: vi.fn(async () => ({ data: rows.map(() => [0.1, 0.2, 0.3]) })) },
      VECTORIZE: { upsert: vi.fn(async () => undefined) },
    } as any;

    const res = await backfillEmbeddings(req("https://h.example/admin/backfill-embeddings?table=growth_patterns"), env);
    const body = await res.json() as { error?: string; backfilled?: Record<string, number> };

    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.backfilled?.growth_patterns).toBe(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("uses pattern_text as the embed source and companion_id for scoping", async () => {
    const rows = [{ id: "p1", pattern_text: "the shape I keep returning to", companion_id: "drevan" }];
    let upsertedMetadata: unknown = null;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    };
    const env = {
      ADMIN_SECRET: "admin-tok",
      DB: fakeDb,
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      VECTORIZE: {
        upsert: vi.fn(async (vectors: Array<{ metadata: unknown }>) => { upsertedMetadata = vectors[0]?.metadata; }),
      },
    } as any;

    await backfillEmbeddings(req("https://h.example/admin/backfill-embeddings?table=growth_patterns"), env);

    expect(upsertedMetadata).toEqual({ table: "growth_patterns", row_id: "p1", companion_id: "drevan" });
  });
});
