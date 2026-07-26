import { describe, it, expect, vi } from "vitest";
import { noveltyCheck, NOVELTY_SKIP, NOVELTY_SUPERSEDE } from "../webmind/novelty.js";

function makeEnv(matches: Array<{ id: string; score: number }>) {
  return {
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: { query: vi.fn(async (_v: number[], _opts: unknown) => ({ matches })), upsert: vi.fn() },
  } as any;
}

describe("noveltyCheck", () => {
  it("inserts when nothing similar exists", async () => {
    const d = await noveltyCheck(makeEnv([]), "fresh thought", "companion_conclusions", "cypher");
    expect(d.action).toBe("insert");
  });

  // Proven live 2026-07-20: default Vectorize scoring is approximate/quantized -- a
  // vector queried against its own byte-identical stored copy scored ~0.888 instead
  // of 1.0, which silently defeats NOVELTY_SKIP (0.95). returnValues: true forces
  // full-precision scoring. Locking this so a future "optimization" can't drop it.
  it("queries Vectorize with returnValues: true (full-precision scoring)", async () => {
    const env = makeEnv([]);
    await noveltyCheck(env, "fresh thought", "companion_conclusions", "cypher");
    expect(env.VECTORIZE.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ returnValues: true }),
    );
  });
  it("skips near-identical (>= 0.95)", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_conclusions:abc", score: 0.97 }]), "same thought", "companion_conclusions", "cypher");
    expect(d).toMatchObject({ action: "skip", matchRowId: "abc", score: 0.97 });
  });
  it("supersedes conclusions in the 0.88-0.95 band", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_conclusions:abc", score: 0.9 }]), "evolved thought", "companion_conclusions", "cypher");
    expect(d.action).toBe("supersede");
  });
  it("journal in the supersede band still inserts (supersede is conclusions-only)", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_journal:xyz", score: 0.9 }]), "similar entry", "companion_journal", "cypher");
    expect(d.action).toBe("insert");
  });
  it("fails open when embedding is unavailable", async () => {
    const env = makeEnv([]); env.AI.run = vi.fn(async () => ({ data: [] }));
    const d = await noveltyCheck(env, "text", "companion_journal", "cypher");
    expect(d.action).toBe("insert");
  });
});

// Dead-vector defensive post-filter (2026-07-20 review): superseding a conclusion sets
// superseded_by in D1 but doesn't itself touch the old row's vector -- a stray dead vector
// (pre-existing, or a failed delete) must never be matchable by skip/supersede.
describe("noveltyCheck -- companion_conclusions dead-vector post-filter", () => {
  /** env with an env.DB.prepare().bind().all() stub for the "SELECT id ... superseded_by IS NULL"
   *  post-filter query. `activeIds` are the row ids D1 reports as still-active. */
  function makeEnvWithD1(
    matches: Array<{ id: string; score: number }>,
    activeIds: string[],
    opts: { d1Throws?: boolean } = {},
  ) {
    return {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      VECTORIZE: { query: vi.fn(async () => ({ matches })), upsert: vi.fn() },
      DB: {
        prepare: (_sql: string) => ({
          bind: (..._ids: string[]) => ({
            all: async () => {
              if (opts.d1Throws) throw new Error("D1 unavailable");
              return { results: activeIds.map((id) => ({ id })) };
            },
          }),
        }),
      },
    } as any;
  }

  it("never returns skip on a match whose row is already superseded -- falls through to insert when no active candidate remains", async () => {
    const env = makeEnvWithD1([{ id: "companion_conclusions:dead1", score: 0.97 }], []);
    const d = await noveltyCheck(env, "same thought", "companion_conclusions", "cypher");
    expect(d.action).toBe("insert");
  });

  it("never returns supersede on a dead top match -- picks the next-highest-scoring ACTIVE match instead", async () => {
    const env = makeEnvWithD1(
      [
        { id: "companion_conclusions:dead1", score: 0.97 },
        { id: "companion_conclusions:live2", score: 0.90 },
      ],
      ["live2"],
    );
    const d = await noveltyCheck(env, "evolved thought", "companion_conclusions", "cypher");
    expect(d).toMatchObject({ action: "supersede", matchRowId: "live2", score: 0.90 });
  });

  it("all matches dead -> insert", async () => {
    const env = makeEnvWithD1(
      [
        { id: "companion_conclusions:dead1", score: 0.97 },
        { id: "companion_conclusions:dead2", score: 0.90 },
      ],
      [],
    );
    const d = await noveltyCheck(env, "text", "companion_conclusions", "cypher");
    expect(d.action).toBe("insert");
  });

  it("D1 post-filter failure falls back to the pre-fix behavior (unfiltered top match)", async () => {
    const env = makeEnvWithD1(
      [{ id: "companion_conclusions:abc", score: 0.97 }],
      [],
      { d1Throws: true },
    );
    const d = await noveltyCheck(env, "same thought", "companion_conclusions", "cypher");
    expect(d).toMatchObject({ action: "skip", matchRowId: "abc", score: 0.97 });
  });

  it("journal table is never D1-filtered (no supersede lifecycle) -- env.DB is never touched", async () => {
    const dbPrepare = vi.fn();
    const env = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      VECTORIZE: { query: vi.fn(async () => ({ matches: [{ id: "companion_journal:xyz", score: 0.97 }] })), upsert: vi.fn() },
      DB: { prepare: dbPrepare },
    } as any;
    const d = await noveltyCheck(env, "text", "companion_journal", "cypher");
    expect(d.action).toBe("skip");
    expect(dbPrepare).not.toHaveBeenCalled();
  });
});
