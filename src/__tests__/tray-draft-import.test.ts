// POST /admin/tray/draft (B47, 2026-10-18): load outside text (a companion's Hermes MEMORY.md / USER.md
// lines) into THAT companion's tray as a draft. Real SQLite with the full migrated schema.

import { describe, it, expect, vi } from "vitest";

const embedSpy = vi.hoisted(() => ({ embedAndStoreAsync: vi.fn(async () => undefined) }));
vi.mock("../mcp/embed.js", async (orig) => {
  const actual = await orig<typeof import("../mcp/embed.js")>();
  return { ...actual, embedAndStoreAsync: embedSpy.embedAndStoreAsync, embedText: vi.fn(async () => [0.1]), storeVector: vi.fn(), embedAndStore: vi.fn() };
});
const noveltySpy = vi.hoisted(() => ({ noveltyCheck: vi.fn(async () => ({ action: "insert", embedding: null })) }));
vi.mock("../webmind/novelty.js", () => noveltySpy);

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postAdminTrayDraft } from "../handlers/tray.js";
import { listTray, reviewDraft } from "../webmind/tray.js";

const post = (body: unknown, auth = "Bearer s") => new Request("http://x/admin/tray/draft", {
  method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const mk = () => {
  const d = makeSqliteD1();
  return { d, env: { DB: d.DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" } as any };
};
const good = { agent: "drevan", content: "  Raziel prefers the blue mug.  ", source: "hermes_memory:MEMORY" };

describe("POST /admin/tray/draft", () => {
  it("creates a draft that listTray shows, carries provenance, and never embeds", async () => {
    const { d, env } = mk();
    const res = await postAdminTrayDraft(post(good), env);
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j).toMatchObject({ created: true, agent: "drevan" });
    const row = (d as any).db.prepare("SELECT * FROM wm_continuity_notes WHERE note_id = ?").get(j.id);
    expect(row).toMatchObject({ agent_id: "drevan", review_state: "draft", source: "hermes_memory:MEMORY", archived: 0 });
    expect(row.content).toBe("[hermes_memory:MEMORY] Raziel prefers the blue mug.");
    expect(row.reviewed_at).toBeNull();

    const view = await listTray(env, "drevan");
    expect(view.drafts.map((x) => x.id)).toContain(j.id);
    expect(view.drafts.find((x) => x.id === j.id)).toMatchObject({ kind: "note", source: "hermes_memory:MEMORY" });
    expect(view.drafts.find((x) => x.id === j.id)!.excerpt).toContain("[hermes_memory:MEMORY]");
    expect((await listTray(env, "cypher")).drafts).toHaveLength(0);
    expect(embedSpy.embedAndStoreAsync).not.toHaveBeenCalled();
    expect(noveltySpy.noveltyCheck).not.toHaveBeenCalled();
  });

  it("is idempotent by content hash and by dedup_key (across review states)", async () => {
    const { d, env } = mk();
    const a = await (await postAdminTrayDraft(post(good), env)).json() as any;
    const r2 = await postAdminTrayDraft(post({ ...good, content: "Raziel prefers the blue mug." }), env);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ id: a.id, created: false, agent: "drevan" });

    const k1 = await (await postAdminTrayDraft(post({ ...good, content: "one", dedup_key: "k1" }), env)).json() as any;
    const k2 = await (await postAdminTrayDraft(post({ ...good, content: "different text", dedup_key: "k1" }), env)).json() as any;
    expect(k2).toEqual({ id: k1.id, created: false, agent: "drevan" });
    // same key for another companion is its own row
    const other = await (await postAdminTrayDraft(post({ ...good, agent: "gaia", dedup_key: "k1" }), env)).json() as any;
    expect(other.created).toBe(true);

    // a dropped draft is not resurrected
    await reviewDraft(env, { agent: "drevan", id: k1.id, decision: "dropped" });
    const again = await (await postAdminTrayDraft(post({ ...good, content: "one", dedup_key: "k1" }), env)).json() as any;
    expect(again.created).toBe(false);
    expect((d as any).db.prepare("SELECT COUNT(*) AS n FROM wm_continuity_notes WHERE agent_id='drevan'").get().n).toBe(2);
  });

  it("keep and drop work on an imported draft; keep with rewrite stores the original", async () => {
    const { d, env } = mk();
    const a = await (await postAdminTrayDraft(post(good), env)).json() as any;
    const b = await (await postAdminTrayDraft(post({ ...good, content: "second line" }), env)).json() as any;
    const kept = await reviewDraft(env, { agent: "drevan", id: a.id, decision: "kept" });
    expect(kept).toMatchObject({ ok: true, kind: "note", decision: "kept", previous_state: "draft" });
    const dropped = await reviewDraft(env, { agent: "drevan", id: b.id, decision: "dropped" });
    expect(dropped).toMatchObject({ ok: true, decision: "dropped" });
    const db = (d as any).db;
    expect(db.prepare("SELECT review_state FROM wm_continuity_notes WHERE note_id=?").get(a.id).review_state).toBe("kept");
    expect(db.prepare("SELECT review_state FROM wm_continuity_notes WHERE note_id=?").get(b.id).review_state).toBe("dropped");
    // another companion cannot review it
    const c = await (await postAdminTrayDraft(post({ ...good, content: "third" }), env)).json() as any;
    expect(await reviewDraft(env, { agent: "cypher", id: c.id, decision: "kept" })).toMatchObject({ ok: false, reason: "not_found" });
    const rw = await reviewDraft(env, { agent: "drevan", id: c.id, decision: "kept", content: "my own words" });
    expect(rw).toMatchObject({ ok: true, rewritten: true });
    expect(db.prepare("SELECT original_content FROM wm_continuity_notes WHERE note_id=?").get(c.id).original_content).toBe("[hermes_memory:MEMORY] third");
  });

  it("400 on bad input, 401 on bad auth", async () => {
    const { d, env } = mk();
    const bad = [
      "not json", { ...good, agent: "sol" }, { ...good, agent: undefined }, { ...good, content: "   " },
      { ...good, content: "x".repeat(4001) }, { ...good, content: 5 }, { ...good, source: "Bad Source!" },
      { ...good, source: "a" }, { ...good, source: undefined }, { ...good, dedup_key: "" }, { ...good, dedup_key: 7 },
    ];
    for (const b of bad) expect((await postAdminTrayDraft(post(b), env)).status).toBe(400);
    expect((await postAdminTrayDraft(post({ ...good, content: "x".repeat(4000) }), env)).status).toBe(201);
    expect((await postAdminTrayDraft(post(good, "Bearer wrong"), env)).status).toBe(401);
    expect((await postAdminTrayDraft(post(good, ""), env)).status).toBe(401);
    expect((d as any).db.prepare("SELECT COUNT(*) AS n FROM wm_continuity_notes").get().n).toBe(1);
  });
});
