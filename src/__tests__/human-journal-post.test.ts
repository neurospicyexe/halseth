// POST /journal (2026-09-26): Raziel's own entry from Hearth's /mind form. Before this route
// existed the form posted to /mind/journal (never a Halseth route), so every entry was lost.

import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../db/queries.js", () => ({ generateId: () => "generated-id" }));

import { postJournal } from "../handlers/human-journal.js";

function makeEnv() {
  const bound: unknown[][] = [];
  return {
    bound,
    env: {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => {
            bound.push([sql, ...args]);
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        }),
      },
    } as never,
  };
}

const post = (body: unknown) =>
  new Request("https://x/journal", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /journal", () => {
  it("inserts a trimmed entry into human_journal with tags as a JSON string", async () => {
    const { env, bound } = makeEnv();
    const res = await postJournal(post({ entry: "  a long day, held  ", tags: ["rest", " ", "  body "] }), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, id: "generated-id" });
    const [sql, id, , entryText, emotion, sub, mood, tags] = bound[0]!;
    expect(sql).toContain("INSERT INTO human_journal");
    expect(id).toBe("generated-id");
    expect(entryText).toBe("a long day, held");
    expect([emotion, sub, mood]).toEqual([null, null, null]);
    // D1 column is TEXT: binding the array straight through was a D1_TYPE_ERROR on the Librarian path.
    expect(tags).toBe('["rest","body"]');
  });

  it("stores null tags when none are sent", async () => {
    const { env, bound } = makeEnv();
    await postJournal(post({ entry: "just this" }), env);
    expect(bound[0]![7]).toBeNull();
  });

  it("rejects an empty entry, a missing entry, and bad JSON without writing", async () => {
    const { env, bound } = makeEnv();
    expect((await postJournal(post({ entry: "   " }), env)).status).toBe(400);
    expect((await postJournal(post({ tags: ["x"] }), env)).status).toBe(400);
    expect((await postJournal(post("{not json"), env)).status).toBe(400);
    expect(bound).toHaveLength(0);
  });

  it("refuses an over-long entry with 413 rather than truncating it", async () => {
    const { env, bound } = makeEnv();
    expect((await postJournal(post({ entry: "x".repeat(8001) }), env)).status).toBe(413);
    expect(bound).toHaveLength(0);
  });
});
