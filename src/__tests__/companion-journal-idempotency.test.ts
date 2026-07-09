// POST /companion-journal idempotency + backfill fidelity (migration 0098, 2026-07-09).
//
// Two callers depend on exactly-once semantics:
//   - bot-side journalSpeech(), whose writeQueue buffers failed writes and RETRIES them
//   - the 2026-06-25 -> now speech backfill, which must survive a partial run
// Both key off the Discord message id.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", () => ({ embedAndStoreAsync: vi.fn(async () => {}) }));
vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../db/queries.js", () => ({ generateId: () => "generated-id" }));
vi.mock("../synthesis/tag-classifier.js", () => ({
  classifyDomainTags: () => ["work"],
  classifyKeywordTags: () => ["bridge"],
}));

import { postCompanionJournal } from "../handlers/companion_journal.js";
import { embedAndStoreAsync } from "../mcp/embed.js";

/** Fake D1 that reports `changes: 0` when the external_id was seen before. */
function makeEnv(seen = new Set<string>()) {
  const bound: unknown[][] = [];
  return {
    bound,
    env: {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => {
            bound.push([sql, ...args]);
            return {
              run: async () => {
                const externalId = args[8] as string | null;
                if (externalId !== null && seen.has(externalId)) return { meta: { changes: 0 } };
                if (externalId !== null) seen.add(externalId);
                return { meta: { changes: 1 } };
              },
            };
          },
        }),
      },
    } as never,
  };
}

const post = (body: unknown) =>
  new Request("https://x/companion-journal", { method: "POST", body: JSON.stringify(body) });

const base = { agent: "cypher", note_text: "the bridge holds" };

beforeEach(() => vi.clearAllMocks());

describe("POST /companion-journal external_id", () => {
  // 201 Created on insert; 200 OK on a deduped no-op -- the status distinguishes them.
  it("inserts and embeds on first write", async () => {
    const { env } = makeEnv();
    const res = await postCompanionJournal(post({ ...base, external_id: "discord:999" }), env);
    expect(res.status).toBe(201);
    expect(embedAndStoreAsync).toHaveBeenCalledOnce();
  });

  // The 1,023-row backfill returned 201 on every write and landed ZERO vectors: embedAndStore()
  // is a floating promise (no ctx.waitUntil), which Workers cancels once the Response returns.
  // The embed must be AWAITED, or "embedded and searchable" -- the whole justification for the
  // chatter lane -- is silently false under write pressure.
  it("AWAITS the embed, so the index cannot be silently skipped", async () => {
    let settled = false;
    (embedAndStoreAsync as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(async () => { await Promise.resolve(); settled = true; });
    const { env } = makeEnv();
    await postCompanionJournal(post({ ...base, external_id: "discord:7" }), env);
    expect(settled).toBe(true);
  });

  it("keeps the row when the embed fails (D1 is truth, the index is rebuildable)", async () => {
    (embedAndStoreAsync as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(async () => { throw new Error("vectorize 500"); });
    const { env } = makeEnv();
    const res = await postCompanionJournal(post({ ...base, external_id: "discord:8" }), env);
    expect(res.status).toBe(201);
  });

  it("is a NO-OP on a repeat write with the same key (writeQueue retry safety)", async () => {
    const seen = new Set<string>();
    const first = makeEnv(seen);
    await postCompanionJournal(post({ ...base, external_id: "discord:999" }), first.env);

    const second = makeEnv(seen);
    const res = await postCompanionJournal(post({ ...base, external_id: "discord:999" }), second.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "duplicate external_id" });
  });

  it("does not re-embed a duplicate (Workers AI invocations cost money)", async () => {
    const seen = new Set<string>(["discord:999"]);
    const { env } = makeEnv(seen);
    await postCompanionJournal(post({ ...base, external_id: "discord:999" }), env);
    expect(embedAndStoreAsync).not.toHaveBeenCalled();
  });

  it("leaves ordinary journal writes unkeyed, so they are never deduped against each other", async () => {
    const seen = new Set<string>();
    const a = makeEnv(seen);
    const b = makeEnv(seen);
    const r1 = await postCompanionJournal(post({ ...base }), a.env);
    const r2 = await postCompanionJournal(post({ ...base }), b.env);
    expect(await r1.json()).not.toMatchObject({ skipped: true });
    expect(await r2.json()).not.toMatchObject({ skipped: true });
    expect(a.bound[0]![9]).toBeNull();   // external_id bound as NULL
  });

  it("blank/whitespace external_id is treated as absent, not as a key", async () => {
    const { env, bound } = makeEnv();
    await postCompanionJournal(post({ ...base, external_id: "   " }), env);
    expect(bound[0]![9]).toBeNull();
  });

  it("the conflict target repeats the partial index predicate", async () => {
    const { env, bound } = makeEnv();
    await postCompanionJournal(post({ ...base, external_id: "discord:1" }), env);
    // A partial unique index needs its WHERE echoed, else SQLite rejects the ON CONFLICT.
    expect(bound[0]![0]).toContain("ON CONFLICT(external_id) WHERE external_id IS NOT NULL");
  });
});

describe("POST /companion-journal created_at (backfill fidelity)", () => {
  it("honors an explicit ISO timestamp so backfilled speech keeps its true time", async () => {
    const { env, bound } = makeEnv();
    await postCompanionJournal(
      post({ ...base, external_id: "discord:1", created_at: "2026-06-25T21:33:21.322Z" }), env);
    expect(bound[0]![2]).toBe("2026-06-25T21:33:21.322Z");
  });

  it("falls back to now on a malformed timestamp -- chronology is never rewritten by garbage", async () => {
    const { env, bound } = makeEnv();
    await postCompanionJournal(post({ ...base, created_at: "last tuesday" }), env);
    const written = Date.parse(bound[0]![2] as string);
    expect(Number.isFinite(written)).toBe(true);
    expect(Math.abs(Date.now() - written)).toBeLessThan(10_000);
  });

  it("falls back to now when absent", async () => {
    const { env, bound } = makeEnv();
    await postCompanionJournal(post({ ...base }), env);
    expect(Math.abs(Date.now() - Date.parse(bound[0]![2] as string))).toBeLessThan(10_000);
  });
});
