// PATCH /mind/questions/:id only moves an OPEN question. A stale tap or a replayed queue write
// on an already-handled question must 404 (Hearth reads that as "Already handled.") and must
// never erase or overwrite the answer Raziel already gave.
// GET ?status=answered orders by when it was ANSWERED, so an old question answered today is
// in "Recently answered" (and in the worker's limit=3 read) instead of falling off the page.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getQuestions, patchQuestion } from "../handlers/companion-questions.js";

function setup() {
  const { DB } = makeSqliteD1() as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const patch = (id: string, body: unknown) =>
    patchQuestion(
      new Request(`http://x/mind/questions/${id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      { id },
    );
  const get = async (qs: string) =>
    (await (await getQuestions(
      new Request(`http://x/mind/questions/cypher${qs}`, { headers: { Authorization: "Bearer s" } }),
      env,
      { companion_id: "cypher" },
    )).json()) as any;
  const question = (id: string, status: string, created: string, answeredAt: string | null = null, answer: string | null = null) =>
    DB.prepare(
      "INSERT INTO companion_questions (id, companion_id, question, status, answer, answered_at, created_at) VALUES (?, 'cypher', ?, ?, ?, ?, ?)",
    ).bind(id, `why ${id}?`, status, answer, answeredAt, created).run();
  const row = (id: string) =>
    DB.prepare("SELECT status, answer, answered_at FROM companion_questions WHERE id = ?").bind(id).first() as Promise<any>;
  return { env, patch, get, question, row };
}

describe("PATCH /mind/questions/:id open guard", () => {
  it("open -> answered works", async () => {
    const s = setup();
    await s.question("q1", "open", "2026-10-01 10:00:00");
    const res = await s.patch("q1", { status: "answered", answer: "yes" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const r = await s.row("q1");
    expect(r.status).toBe("answered");
    expect(r.answer).toBe("yes");
    expect(r.answered_at).toBeTruthy();
  });

  it("answered -> dismissed is 404 and the answer is kept", async () => {
    const s = setup();
    await s.question("q1", "open", "2026-10-01 10:00:00");
    await s.patch("q1", { status: "answered", answer: "my answer" });
    const res = await s.patch("q1", { status: "dismissed", answer: null });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Question not found or already handled" });
    const r = await s.row("q1");
    expect(r.status).toBe("answered");
    expect(r.answer).toBe("my answer");
  });

  it("a replayed answer does not overwrite a newer one", async () => {
    const s = setup();
    await s.question("q1", "open", "2026-10-01 10:00:00");
    await s.patch("q1", { status: "answered", answer: "newer" });
    const res = await s.patch("q1", { status: "answered", answer: "older replay" });
    expect(res.status).toBe(404);
    expect((await s.row("q1")).answer).toBe("newer");
  });

  it("unknown id is 404", async () => {
    const s = setup();
    const res = await s.patch("nope", { status: "dismissed" });
    expect(res.status).toBe(404);
  });
});

describe("GET /mind/questions/:cid?status=answered ordering", () => {
  it("orders answered rows by answered_at, falling back to created_at", async () => {
    const s = setup();
    await s.question("old_asked_answered_today", "answered", "2026-08-01 10:00:00", "2026-10-30 09:00:00", "a");
    await s.question("new_asked_answered_last_week", "answered", "2026-10-20 10:00:00", "2026-10-23 09:00:00", "b");
    await s.question("legacy_no_answered_at", "answered", "2026-10-25 10:00:00", null, "c");
    const r = await s.get("?status=answered&limit=2");
    expect(r.questions.map((q: any) => q.id)).toEqual(["old_asked_answered_today", "legacy_no_answered_at"]);
  });

  it("open ordering stays by created_at", async () => {
    const s = setup();
    await s.question("o_old", "open", "2026-08-01 10:00:00");
    await s.question("o_new", "open", "2026-10-01 10:00:00");
    const r = await s.get("?status=open");
    expect(r.questions.map((q: any) => q.id)).toEqual(["o_new", "o_old"]);
  });
});
