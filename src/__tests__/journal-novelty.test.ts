// src/__tests__/journal-novelty.test.ts
//
// Novelty gate wired into machine-source companion_journal writes (Task 12, 2026-07-20).
// SKIP-ONLY -- no supersede band for journal (novelty.ts restricts supersede to
// companion_conclusions, so a 0.90 match on companion_journal falls through to insert).
// Human-source writes (HUMAN_SOURCES, webmind/notes.ts) bypass the gate entirely --
// attribution is sacred, and a human saying the same thing twice is never a duplicate.
//
// Covers BOTH write paths named in the brief:
//   - handlers/companion_journal.ts (postCompanionJournal, HTTP)
//   - librarian/backends/halseth.ts (companionJournalAdd, internal) -- also converts its
//     fire-and-forget embedAndStore to an awaited path (known silent-death hazard, see
//     the 2026-07-09 postmortem comment in companion_journal.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../db/queries.js", () => ({ generateId: () => "generated-id" }));
vi.mock("../synthesis/tag-classifier.js", () => ({
  classifyDomainTags: () => ["work"],
  classifyKeywordTags: () => ["bridge"],
}));

import { postCompanionJournal } from "../handlers/companion_journal.js";
import { companionJournalAdd } from "../librarian/backends/halseth.js";

interface Captured { prepared: string[]; binds: unknown[][] }

/** D1 stub that records every prepare()+bind() call, plus AI/VECTORIZE stubs so
 *  noveltyCheck (src/webmind/novelty.ts) resolves against a caller-supplied top match. */
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
        };
        return stmt;
      },
    },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: {
      query: vi.fn(async () => ({ matches })),
      upsert: vi.fn(async () => undefined),
    },
  };
}

const post = (body: unknown) =>
  new Request("https://x/companion-journal", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function insertCalls(c: Captured): number {
  return c.prepared.filter((sql) => sql.includes("INSERT INTO companion_journal")).length;
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// postCompanionJournal (HTTP handler)
// ---------------------------------------------------------------------------

describe("postCompanionJournal -- novelty gate (machine sources only)", () => {
  it("(a) skips a machine-source write on a 0.96 match -- 200, deduped, NO INSERT", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing123", score: 0.96 }], captured);

    const res = await postCompanionJournal(
      post({ agent: "cypher", note_text: "the swarm holds", source: "autonomous" }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deduped).toBe(true);
    expect(body.id).toBe("existing123");
    expect(body.novelty).toEqual({ action: "skip", match_id: "existing123", score: 0.96 });
    expect(insertCalls(captured)).toBe(0);
  });

  it("(b) human-source write INSERTs unconditionally even at similarity 0.99 -- gate never called", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing123", score: 0.99 }], captured);

    const res = await postCompanionJournal(
      post({ agent: "cypher", note_text: "a human wrote this directly", source: "session_close" }),
      env,
    );

    expect(res.status).toBe(201);
    expect(insertCalls(captured)).toBe(1);
    expect(env.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it("(c) machine-source write at 0.90 still INSERTs -- no supersede band for journal", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:oldrow456", score: 0.90 }], captured);

    const res = await postCompanionJournal(
      post({ agent: "cypher", note_text: "another autonomous note", source: "autonomous" }),
      env,
    );

    expect(res.status).toBe(201);
    expect(insertCalls(captured)).toBe(1);
    // Journal has no superseded_by column/UPDATE at all -- prove no such statement ever fires.
    expect(captured.prepared.some((sql) => sql.toLowerCase().includes("supersed"))).toBe(false);
  });

  it("reuses the gate's embedding on insert -- one AI.run, one Vectorize upsert (net +0 AI calls)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured);

    await postCompanionJournal(
      post({ agent: "cypher", note_text: "fresh autonomous note", source: "autonomous" }),
      env,
    );

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it("an unlisted/unknown source is treated as non-machine -- ungated, inserts", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing", score: 0.99 }], captured);

    const res = await postCompanionJournal(
      post({ agent: "cypher", note_text: "some other source", source: "some_unlisted_source" }),
      env,
    );

    expect(res.status).toBe(201);
    expect(insertCalls(captured)).toBe(1);
    expect(env.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it("no source at all is treated as non-machine -- ungated, inserts (ordinary companion writes)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing", score: 0.99 }], captured);

    const res = await postCompanionJournal(post({ agent: "cypher", note_text: "plain reflection" }), env);

    expect(res.status).toBe(201);
    expect(insertCalls(captured)).toBe(1);
    expect(env.VECTORIZE.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// companionJournalAdd (librarian backend writer)
// ---------------------------------------------------------------------------

describe("companionJournalAdd (librarian backend) -- novelty gate + awaited embed", () => {
  it("skips a machine-source write on a near-identical match, no INSERT", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing456", score: 0.97 }], captured);

    const result = await companionJournalAdd(env, "gaia", "the nest holds", undefined, "synthesis_loop");

    expect(result.deduped).toBe(true);
    expect(result.id).toBe("existing456");
    // Consistency fix (2026-07-20 review): journal dedupe now carries novelty.match_id,
    // matching the shape companion_conclusions has always returned.
    expect(result.novelty).toEqual({ action: "skip", match_id: "existing456", score: 0.97 });
    expect(insertCalls(captured)).toBe(0);
  });

  it("human-source write inserts unconditionally, gate never called (VECTORIZE.query not invoked)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:existing456", score: 0.99 }], captured);

    const result = await companionJournalAdd(env, "gaia", "raziel said this directly", undefined, "session_close");

    expect(typeof result.id).toBe("string");
    expect(result.deduped).toBeUndefined();
    expect(insertCalls(captured)).toBe(1);
    expect(env.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it("machine-source write at 0.90 still inserts -- no supersede band for journal", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([{ id: "companion_journal:oldrow", score: 0.90 }], captured);

    const result = await companionJournalAdd(env, "cypher", "another autonomous note", undefined, "autonomous");

    expect(typeof result.id).toBe("string");
    expect(insertCalls(captured)).toBe(1);
    expect(captured.prepared.some((sql) => sql.toLowerCase().includes("supersed"))).toBe(false);
  });

  it("AWAITS the embed store -- no more fire-and-forget (known silent-death hazard)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured);
    let settled = false;
    env.VECTORIZE.upsert = vi.fn(async () => { await Promise.resolve(); settled = true; });

    await companionJournalAdd(env, "gaia", "fresh reflection", undefined, "autonomous");

    expect(settled).toBe(true);
  });

  it("keeps the row when the embed/vector store fails (D1 is truth, index is rebuildable)", async () => {
    const captured: Captured = { prepared: [], binds: [] };
    const env = makeEnv([], captured);
    env.VECTORIZE.upsert = vi.fn(async () => { throw new Error("vectorize 500"); });

    const result = await companionJournalAdd(env, "gaia", "fresh reflection", undefined, "autonomous");

    expect(typeof result.id).toBe("string");
    expect(insertCalls(captured)).toBe(1);
  });
});
