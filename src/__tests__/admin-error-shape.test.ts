import { describe, it, expect } from "vitest";
import { backfillEmbeddings } from "../handlers/admin.js";

function req(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer admin-tok" },
  });
}

describe("backfillEmbeddings error shape", () => {
  it("does not leak raw exception text in per-table batch errors", async () => {
    // NOTE: the brief's original version of this test made `DB.prepare` throw for
    // every call, expecting it to be caught by the per-row batch catch (line
    // 229-237 in admin.ts). Running that version first (RED step) showed the
    // table-loop's OWN `env.DB.prepare()` call (admin.ts:214-216) is NOT inside
    // any try/catch -- it threw uncaught straight out of `backfillEmbeddings`,
    // never reaching the batch-embed catch block at all. That is a separate,
    // pre-existing gap (an unhandled exception path at the table-loop level)
    // outside this task's scope -- flagged in the task report, not fixed here.
    //
    // To actually exercise the code this task fixes (the `errors.push(...)` at
    // admin.ts:236), the DB read must succeed (so the loop reaches the inner
    // try/catch) and the failure must occur inside `embedAndStoreBatch` instead
    // -- reached via `env.AI.run()`, which is where that helper throws.
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{ id: "1", emotion: "joy", sub_emotion: null, companion_id: "cypher" }],
          }),
        }),
      }),
    };
    const throwingAi = {
      run: async () => {
        throw new Error("D1_ERROR: no such table: feelings (raw diagnostic)");
      },
    };
    const env = { ADMIN_SECRET: "admin-tok", DB: fakeDb, AI: throwingAi } as any;
    const res = await backfillEmbeddings(req("https://h.example/admin/backfill-embeddings?table=feelings"), env);
    // This exercises the inner per-row batch catch (admin.ts:229-237) --
    // confirms no raw D1/embedding diagnostic text leaks into the client response.
    const text = await res.text();
    expect(text).not.toContain("raw diagnostic");
    expect(text).not.toContain("D1_ERROR");
    const body = JSON.parse(text) as { errors?: Array<{ error: string }> };
    expect(body.errors).toBeDefined();
    expect(body.errors?.[0]?.error).toBe("batch embed failed — see server logs");
  });
});
