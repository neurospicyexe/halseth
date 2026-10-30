// Raziel's inbox: one list of every letter left for him (companion_journal tagged letter / letter_to_raziel), with read marks.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getRazielInbox, getRazielInboxItem, postRazielInboxRead } from "../handlers/raziel-inbox.js";

function setup() {
  const { DB } = makeSqliteD1() as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const seed = async (id: string, at: string, agent: string, tags: string[], text: string, review?: string) => {
    await DB.prepare(
      "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, review_state) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, at, agent, text, JSON.stringify(tags), review ?? "kept").run();
  };
  const req = (method: string, path: string, body?: unknown, auth = true) =>
    new Request(`http://x${path}`, {
      method,
      headers: { ...(auth ? { Authorization: "Bearer s" } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const list = async (qs = "") => (await getRazielInbox(req("GET", `/raziel/inbox${qs}`), env, {})).json() as Promise<any>;
  const mark = (body: unknown) => postRazielInboxRead(req("POST", "/raziel/inbox/read", body), env, {});
  return { env, seed, req, list, mark };
}

async function seeded() {
  const s = setup();
  await s.seed("j1", "2026-10-01 10:00:00", "cypher", ["letter"], "Dear Raziel,\n\n  line   two");
  await s.seed("j2", "2026-10-02 10:00:00", "steward", ["briefing", "letter_to_raziel"], "x".repeat(300));
  await s.seed("j3", "2026-10-03 10:00:00", "gaia", ["note"], "not a letter");
  await s.seed("j4", "2026-10-04 10:00:00", "drevan", ["letter"], "dropped letter", "dropped");
  return s;
}

describe("raziel inbox", () => {
  it("lists only letter-tagged, non-dropped rows newest first", async () => {
    const { list } = await seeded();
    const r = await list();
    expect(r.items.map((i: any) => i.agent)).toEqual(["steward", "cypher"]);
    expect(r.items[0]).toMatchObject({ id: "j2", kind: "letter", read: false });
    expect(r.items[0].preview).toHaveLength(160);
    expect(r.items[0].text).toHaveLength(300);
    expect(r.items[1].preview).toBe("Dear Raziel, line two");
    expect(r.unread_count).toBe(2);
  });

  it("marks read and is idempotent", async () => {
    const { list, mark } = await seeded();
    const a = await mark({ ids: ["j1"] });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true, marked: 1 });
    const b = await mark({ ids: ["j1"] });
    expect(await b.json()).toEqual({ ok: true, marked: 0 });
    const r = await list();
    expect(r.items.find((i: any) => i.id === "j1").read).toBe(true);
    expect(r.items.find((i: any) => i.id === "j2").read).toBe(false);
    expect(r.unread_count).toBe(1);
  });

  it("a row whose tags are not JSON breaks neither the list, the count nor the item read", async () => {
    const s = await seeded();
    await s.env.DB.prepare(
      "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, review_state) VALUES ('bad', '2026-10-05 10:00:00', 'cypher', 'x', 'letter, not json', 'kept')",
    ).run();
    const r = await s.list();
    expect(r.items.map((i: any) => i.id)).toEqual(["j2", "j1"]);
    expect(r.unread_count).toBe(2);
    const one = await getRazielInboxItem(s.req("GET", "/raziel/inbox/bad"), s.env, { id: "bad" });
    expect(one.status).toBe(404);
  });

  it("migration 0153 adds the partial letters index", async () => {
    const { env } = setup();
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_companion_journal_letters'").first();
    expect(idx?.sql).toMatch(/WHERE tags LIKE '%letter%'/);
  });

  it("unread_count ignores limit", async () => {
    const { list } = await seeded();
    const r = await list("?limit=1");
    expect(r.items).toHaveLength(1);
    expect(r.unread_count).toBe(2);
  });

  it("rejects empty ids / >100 ids / bad shapes", async () => {
    const { mark } = setup();
    expect((await mark({ ids: [] })).status).toBe(400);
    expect((await mark({ ids: Array.from({ length: 101 }, (_, i) => `i${i}`) })).status).toBe(400);
    expect((await mark({ ids: [1] })).status).toBe(400);
    expect((await mark({})).status).toBe(400);
  });

  it("requires auth", async () => {
    const { env, req } = setup();
    expect((await getRazielInbox(req("GET", "/raziel/inbox", undefined, false), env, {})).status).toBe(401);
    expect((await getRazielInboxItem(req("GET", "/raziel/inbox/j1", undefined, false), env, { id: "j1" })).status).toBe(401);
    expect((await postRazielInboxRead(req("POST", "/raziel/inbox/read", { ids: ["j1"] }, false), env, {})).status).toBe(401);
  });

  it("GET /raziel/inbox/:id returns the item, 404 for unknown or non-letter", async () => {
    const { env, req } = await seeded();
    const ok = await getRazielInboxItem(req("GET", "/raziel/inbox/j1"), env, { id: "j1" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).item).toMatchObject({ id: "j1", agent: "cypher", read: false });
    expect((await getRazielInboxItem(req("GET", "/raziel/inbox/nope"), env, { id: "nope" })).status).toBe(404);
    expect((await getRazielInboxItem(req("GET", "/raziel/inbox/j3"), env, { id: "j3" })).status).toBe(404);
  });
});
