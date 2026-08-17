// Chosen forgetting (consequence layer C7, mig 0123).
//
// The rails under test: reason REQUIRED (an unexplained forgetting is indistinguishable from
// data loss), owner-only, archive-never-delete via one atomic batch that also logs the release
// (write-gate falsifiability), 30d reversibility with a hard edge, and the structural exclusion
// (only journal/note/conclusion kinds exist -- canon and identity_kernel have no kind).

import { describe, it, expect } from "vitest";
import { execMemoryRelease, execMemoryReleaseUndo, execMemoryReleasesRead, RELEASE_REVERSIBLE_DAYS } from "../librarian/executors/forgetting.js";

interface CapturedCall { sql: string; binds: unknown[] }

/** Fake D1: `firstResults` answers .first() calls in order; every bind is captured; batch records. */
function makeEnv(firstResults: unknown[]): { env: any; calls: CapturedCall[]; batches: CapturedCall[][] } {
  const calls: CapturedCall[] = [];
  const batches: CapturedCall[][] = [];
  const mkStmt = (sql: string) => ({
    bind: (...binds: unknown[]) => {
      const call = { sql, binds };
      calls.push(call);
      return {
        __call: call,
        first: async () => firstResults.shift() ?? null,
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: firstResults.shift() ?? [] }),
      };
    },
  });
  const env = {
    DB: {
      prepare: mkStmt,
      batch: async (stmts: any[]) => { batches.push(stmts.map(s => s.__call)); return stmts.map(() => ({ meta: { changes: 1 } })); },
    },
  };
  return { env, calls, batches };
}

function ctxFor(companionId: string, context: unknown): any {
  return {
    env: undefined, // set by caller
    req: { companion_id: companionId, request: "release memory", context: JSON.stringify(context) },
    entry: { pattern: "memory_release" },
    frontState: null,
    pluralAvailable: false,
  };
}

describe("execMemoryRelease", () => {
  it("archives + logs in ONE batch, and the witness names the reversibility window", async () => {
    const { env, calls, batches } = makeEnv([{ id: "j1" }]);
    const ctx = ctxFor("cypher", { kind: "journal", id: "j1", reason: "it was a spiral I chose to stop re-reading" });
    ctx.env = env;
    const r = await execMemoryRelease(ctx);
    expect(r["ack"]).toBe(true);
    expect(String(r["witness"])).toContain(`${RELEASE_REVERSIBLE_DAYS} days`);
    // Ownership check ran against the right table/columns.
    expect(calls[0]!.sql).toContain("FROM companion_journal");
    expect(calls[0]!.sql).toContain("agent = ?");
    expect(calls[0]!.sql).toContain("archived = 0");
    // One batch: UPDATE archived=1 + INSERT memory_releases. A release that isn't logged is unfalsifiable.
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.sql).toContain("SET archived = 1");
    expect(batches[0]![1]!.sql).toContain("INSERT INTO memory_releases");
    expect(batches[0]![1]!.binds).toContain("it was a spiral I chose to stop re-reading");
  });

  it("REFUSES a release without a reason", async () => {
    const { env } = makeEnv([{ id: "j1" }]);
    const ctx = ctxFor("cypher", { kind: "journal", id: "j1" });
    ctx.env = env;
    const r = await execMemoryRelease(ctx);
    expect(r["error"]).toBe("memory_release_failed");
    expect(String(r["reason"])).toContain("reason");
  });

  it("a row that is not yours (or already released) is a no-change witness, not an archive", async () => {
    const { env, batches } = makeEnv([null]); // ownership SELECT finds nothing
    const ctx = ctxFor("cypher", { kind: "note", id: "n-drevan", reason: "r" });
    ctx.env = env;
    const r = await execMemoryRelease(ctx);
    expect(r["ack"]).toBe(false);
    expect(batches).toHaveLength(0);
  });

  it("conclusion releases target the archived lane and refuse already-superseded rows", async () => {
    const { env, calls } = makeEnv([{ id: "c1" }]);
    const ctx = ctxFor("gaia", { kind: "conclusion", id: "c1", reason: "no longer mine" });
    ctx.env = env;
    await execMemoryRelease(ctx);
    expect(calls[0]!.sql).toContain("FROM companion_conclusions");
    expect(calls[0]!.sql).toContain("superseded_by IS NULL");
  });

  it("only journal/note/conclusion kinds exist -- canon and kernel are structurally unreachable", async () => {
    const { env } = makeEnv([]);
    const ctx = ctxFor("cypher", { kind: "identity_kernel", id: "k1", reason: "r" });
    ctx.env = env;
    const r = await execMemoryRelease(ctx);
    expect(r["error"]).toBe("memory_release_failed");
  });
});

describe("execMemoryReleaseUndo", () => {
  const freshIso = () => new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const staleIso = () => new Date(Date.now() - (RELEASE_REVERSIBLE_DAYS + 1) * 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

  it("restores within the window: un-archives AND stamps restored_at in one batch", async () => {
    const { env, batches } = makeEnv([{ id: "rel1", kind: "journal", ref_id: "j1", released_at: freshIso(), restored_at: null }]);
    const ctx = ctxFor("cypher", { id: "rel1" });
    ctx.env = env;
    const r = await execMemoryReleaseUndo(ctx);
    expect(r["ack"]).toBe(true);
    expect(batches[0]![0]!.sql).toContain("SET archived = 0");
    expect(batches[0]![1]!.sql).toContain("SET restored_at");
  });

  it("past the 30-day window the release STANDS", async () => {
    const { env, batches } = makeEnv([{ id: "rel1", kind: "journal", ref_id: "j1", released_at: staleIso(), restored_at: null }]);
    const ctx = ctxFor("cypher", { id: "rel1" });
    ctx.env = env;
    const r = await execMemoryReleaseUndo(ctx);
    expect(r["ack"]).toBe(false);
    expect(String(r["witness"])).toContain("window has passed");
    expect(batches).toHaveLength(0);
  });

  it("an already-restored release cannot restore twice", async () => {
    const { env, batches } = makeEnv([{ id: "rel1", kind: "note", ref_id: "n1", released_at: freshIso(), restored_at: "2026-08-15 00:00:00" }]);
    const ctx = ctxFor("cypher", { id: "rel1" });
    ctx.env = env;
    const r = await execMemoryReleaseUndo(ctx);
    expect(r["ack"]).toBe(false);
    expect(batches).toHaveLength(0);
  });
});

describe("execMemoryReleasesRead", () => {
  it("returns releases with days_left on live rows and null on restored ones", async () => {
    const { env } = makeEnv([[
      { id: "a", kind: "journal", ref_id: "j1", reason: "r", released_at: "x", restored_at: null, days_left: 12 },
      { id: "b", kind: "note", ref_id: "n1", reason: "r", released_at: "x", restored_at: "y", days_left: 5 },
    ]]);
    const ctx = ctxFor("cypher", null);
    ctx.env = env;
    const r = await execMemoryReleasesRead(ctx);
    const releases = (r["data"] as any).releases;
    expect(releases[0].days_left).toBe(12);
    expect(releases[1].days_left).toBeNull();
    expect(r["count"]).toBe(2);
  });
});
