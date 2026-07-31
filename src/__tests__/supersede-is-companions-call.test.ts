// Supersession is the companion's call (mig 0112, Raziel's decision 2026-07-31).
//
// WHAT WAS HAPPENING: `noveltyCheck` auto-superseded any new conclusion whose cosine similarity to an
// existing one was >= 0.88, and EVERY read of companion_conclusions filters `WHERE superseded_by IS
// NULL`. So a similarity score silently deleted a belief from view. 0.88 is loose enough that two
// genuinely different thoughts about the same subject clear it.
//
// WHY IT CHANGED, in his words: an inferring pass had already written that Drevan had a NEGATIVE
// experience with him which was in fact deeply positive. A machine that has gotten the interior of a
// relationship wrong does not get to decide which of a companion's beliefs is dead.
//
// THE PRINCIPLE: an edge may RANK, never HIDE, until a mind has confirmed it. A wrong ranking is a bad
// day; a wrong hide is a companion looking like he lost something he never lost.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types.js";

// The gate is stubbed so the test drives the DECISION branch, not the embedding math.
vi.mock("../webmind/novelty.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webmind/novelty.js")>();
  return { ...actual, noveltyCheck: vi.fn() };
});
vi.mock("../mcp/embed.js", () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
  storeVector: vi.fn(async () => undefined),
  embedAndStoreAsync: vi.fn(async () => undefined),
  vectorId: (t: string, id: string) => `${t}:${id}`,
  EMBEDDING_MODEL: "stub",
}));

const { noveltyCheck } = await import("../webmind/novelty.js");
const { execConclusionAdd } = await import("../librarian/executors/writes.js");

interface Stmt { sql: string; binds: unknown[] }

function fakeEnv() {
  const stmts: Stmt[] = [];
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => {
      const rec = { sql, binds };
      return {
        run: async () => { stmts.push(rec); return { meta: { changes: 1 } }; },
        first: async () => null,
        all: async () => ({ results: [] }),
        __rec: rec,
      };
    },
  });
  const env = {
    DB: {
      prepare,
      batch: async (list: Array<{ __rec: Stmt }>) => { for (const s of list) stmts.push(s.__rec); return []; },
    },
    VECTORIZE: { deleteByIds: vi.fn(async () => undefined), query: vi.fn() },
  } as unknown as Env;
  return { env, stmts };
}

const ctx = (env: Env, context: Record<string, unknown>) => ({
  env,
  req: { companion_id: "cypher" as const, request: "I conclude something", context: JSON.stringify(context) },
  entry: {} as never,
  frontState: null,
  pluralAvailable: false,
});

describe("the novelty gate proposes; it does not retire", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a gate match at 0.9 writes NO superseded_by -- the older belief stays live", async () => {
    vi.mocked(noveltyCheck).mockResolvedValue({
      action: "supersede", matchRowId: "older-belief", score: 0.9, embedding: [0.1, 0.2],
    });
    const { env, stmts } = fakeEnv();
    const res = await execConclusionAdd(ctx(env, { conclusion_text: "a related but distinct thought" }) as never);

    const updates = stmts.filter(s => /UPDATE companion_conclusions SET superseded_by/.test(s.sql));
    expect(updates).toHaveLength(0);                       // nothing retired
    expect((res as { superseded?: boolean }).superseded).toBe(false);
  });

  it("...and records the match as a CANDIDATE on the new row instead", async () => {
    vi.mocked(noveltyCheck).mockResolvedValue({
      action: "supersede", matchRowId: "older-belief", score: 0.9, embedding: [0.1, 0.2],
    });
    const { env, stmts } = fakeEnv();
    const res = await execConclusionAdd(ctx(env, { conclusion_text: "a related but distinct thought" }) as never);

    const insert = stmts.find(s => s.sql.startsWith("INSERT INTO companion_conclusions"))!;
    expect(insert.binds).toContain("older-belief");        // candidate id persisted
    expect(insert.binds).toContain(0.9);
    const cand = (res as { supersede_candidate?: { match_id: string } }).supersede_candidate;
    expect(cand?.match_id).toBe("older-belief");
  });

  it("does NOT delete the older belief's vector -- it is still live and must stay recallable", async () => {
    // The old code deleted the superseded row's vector. Doing that for a merely-PROPOSED match would
    // remove a live belief from semantic recall and from future gate comparisons: a silent partial
    // erasure that no read would reveal.
    vi.mocked(noveltyCheck).mockResolvedValue({
      action: "supersede", matchRowId: "older-belief", score: 0.9, embedding: [0.1, 0.2],
    });
    const { env } = fakeEnv();
    await execConclusionAdd(ctx(env, { conclusion_text: "x" }) as never);
    expect((env.VECTORIZE as unknown as { deleteByIds: ReturnType<typeof vi.fn> }).deleteByIds).not.toHaveBeenCalled();
  });

  it("the response never claims something was superseded when it was only proposed", async () => {
    // If the write said superseded:true, the companion would believe a belief was retired while it is
    // still live -- the write claiming an authority it no longer has.
    vi.mocked(noveltyCheck).mockResolvedValue({
      action: "supersede", matchRowId: "older-belief", score: 0.93, embedding: [0.1, 0.2],
    });
    const { env } = fakeEnv();
    const res = await execConclusionAdd(ctx(env, { conclusion_text: "x" }) as never) as Record<string, unknown>;
    expect(res["superseded"]).toBe(false);
    expect((res["novelty"] as { action: string }).action).toBe("propose_supersede");
    expect(String((res["supersede_candidate"] as { note: string }).note)).toMatch(/STILL LIVE/i);
  });
});

describe("the companion's own pen still works immediately", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a companion-declared `supersedes` retires the named belief at once", async () => {
    // This is the half that must NOT be weakened. Their own judgment acts without ceremony.
    vi.mocked(noveltyCheck).mockResolvedValue({ action: "insert", embedding: [0.1, 0.2] });
    const { env, stmts } = fakeEnv();
    const res = await execConclusionAdd(ctx(env, {
      conclusion_text: "I no longer think that", supersedes: "my-old-belief",
    }) as never);

    const upd = stmts.filter(s => /UPDATE companion_conclusions SET superseded_by/.test(s.sql));
    expect(upd).toHaveLength(1);
    expect(upd[0]!.binds).toContain("my-old-belief");
    // Guarded so it cannot clobber a row that was already superseded.
    expect(upd[0]!.sql).toMatch(/superseded_by IS NULL/);
    expect((res as { superseded?: boolean }).superseded).toBe(true);
  });

  it("a declared supersede DOES delete the retired belief's vector", async () => {
    vi.mocked(noveltyCheck).mockResolvedValue({ action: "insert", embedding: [0.1, 0.2] });
    const { env } = fakeEnv();
    await execConclusionAdd(ctx(env, { conclusion_text: "y", supersedes: "my-old-belief" }) as never);
    expect((env.VECTORIZE as unknown as { deleteByIds: ReturnType<typeof vi.fn> }).deleteByIds)
      .toHaveBeenCalledWith(["companion_conclusions:my-old-belief"]);
  });

  it("an exact duplicate is still skipped -- dedup is not a judgment about meaning", async () => {
    // The skip band (>= 0.95) is byte-level near-identity, not an opinion about whether one thought
    // replaced another. It stays automatic.
    vi.mocked(noveltyCheck).mockResolvedValue({ action: "skip", matchRowId: "same", score: 0.99 });
    const { env } = fakeEnv();
    const res = await execConclusionAdd(ctx(env, { conclusion_text: "identical" }) as never) as Record<string, unknown>;
    expect(res["deduped"]).toBe(true);
  });
});
