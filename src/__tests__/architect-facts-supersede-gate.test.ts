// A supersede must not be eaten by the novelty gate (2026-09-26).
//
// Hearth's /facts "Fix" posts a corrected fact with supersedes_id. A correction is by definition
// close to the row it replaces (a typo fix scores >=0.95), so the gate matched the very row being
// retired and answered {ok:true, deduped:true}: nothing written, nothing retired, "superseded" shown.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../webmind/novelty.js", () => ({
  noveltyCheck: vi.fn(async () => ({ action: "skip", matchRowId: "old-fact", score: 0.97 })),
}));
vi.mock("../mcp/embed.js", () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
  storeVector: vi.fn(async () => {}),
}));

import { postArchitectFact } from "../handlers/architect-facts.js";
import { noveltyCheck } from "../webmind/novelty.js";
import { embedText, storeVector } from "../mcp/embed.js";

function makeEnv() {
  const batched: string[] = [];
  const deleted: string[][] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          sql,
          first: async () => (sql.startsWith("SELECT id FROM architect_facts") ? { id: "old-fact" } : null),
        }),
      }),
      batch: async (stmts: Array<{ sql: string }>) => { batched.push(...stmts.map((s) => s.sql)); return []; },
    },
    VECTORIZE: { deleteByIds: async (ids: string[]) => { deleted.push(ids); } },
  } as never;
  return { env, batched, deleted };
}

const post = (body: unknown) =>
  new Request("https://x/identity/architect-facts", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("POST /identity/architect-facts supersede vs novelty gate", () => {
  it("writes the correction and retires the old row even when the text is near-identical", async () => {
    const { env, batched, deleted } = makeEnv();
    const res = await postArchitectFact(
      post({ fact: "Raziel lives in Missouri.", supersedes_id: "old-fact", source: "raziel" }), env);
    const body = await res.json() as Record<string, unknown>;

    expect(body.deduped).toBeUndefined();
    expect(body).toMatchObject({ ok: true, supersedes_id: "old-fact" });
    expect(noveltyCheck).not.toHaveBeenCalled();
    expect(batched.some((s) => s.includes("INSERT INTO architect_facts"))).toBe(true);
    expect(batched.some((s) => s.includes("SET status = 'retired'"))).toBe(true);
    expect(deleted).toEqual([["architect_facts:old-fact"]]);
  });

  it("still indexes the corrected fact so the next write's gate can see it", async () => {
    const { env } = makeEnv();
    await postArchitectFact(post({ fact: "Raziel lives in Missouri.", supersedes_id: "old-fact" }), env);
    expect(embedText).toHaveBeenCalledOnce();
    expect(storeVector).toHaveBeenCalledOnce();
  });

  it("an unprompted write still goes through the gate and is deduped", async () => {
    const { env, batched } = makeEnv();
    const res = await postArchitectFact(post({ fact: "Raziel lives in Missouri." }), env);
    expect(await res.json()).toMatchObject({ ok: true, deduped: true, id: "old-fact" });
    expect(noveltyCheck).toHaveBeenCalledOnce();
    expect(batched).toHaveLength(0);
  });
});
