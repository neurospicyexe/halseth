// B64 Task 4: every tend is appraised, and a grudge lives in the tend path.
// Real schema (every migration, incl. 0176) behind the D1 shape, so the rows, the unique index and the
// batch contents are what prod would see.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { performTend } from "../webmind/creature-interact.js";
import { getCreature, interactCreature, hoardCreature } from "../handlers/creatures.js";
import { SULK_LINES, MAKE_UP_LINES } from "../pets/grudge.js";

const H = 3_600_000;
const ALL_SULK = [...SULK_LINES.low, ...SULK_LINES.mid, ...SULK_LINES.high];
const iso = (ms: number) => new Date(ms).toISOString();

function setup(opts: { trust?: number } = {}) {
  const s = makeSqliteD1();
  const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
  if (opts.trust !== undefined) s.db.prepare("UPDATE creatures SET trust = ? WHERE id = ?").run(opts.trust, sol.id);
  const trust = (s.db.prepare("SELECT trust FROM creatures WHERE id = ?").get(sol.id) as { trust: number }).trust;
  return { ...s, solId: sol.id, target: { id: sol.id, kind: "companion_pet", trust } };
}

function seedAversion(db: any, creatureId: string, over: { trigger?: object; resolution?: object; target_actor?: string | null } = {}) {
  db.prepare(
    "INSERT INTO creature_quirks (id, creature_id, title, trigger_json, behavior, resolution_json, target_actor, kind, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'aversion', 'active')",
  ).run("q1", creatureId, "Being Poked", JSON.stringify(over.trigger ?? { action: "play" }), "turns away",
    JSON.stringify(over.resolution ?? { kind: "visits", n: 2 }), over.target_actor ?? null);
}

function seedGrudge(db: any, creatureId: string, actor: string, openedMs: number, over: { resolution?: object; progress?: number; id?: string } = {}) {
  db.prepare(
    "INSERT INTO creature_grudges (id, creature_id, quirk_id, actor, label, resolution_json, progress, opened_at) VALUES (?, ?, 'q1', ?, ?, ?, ?, ?)",
  ).run(over.id ?? "g_old", creatureId, actor, "still sore about being poked",
    JSON.stringify(over.resolution ?? { kind: "visits", n: 2 }), over.progress ?? 0, iso(openedMs));
}

const appraisals = (db: any) => db.prepare("SELECT * FROM creature_appraisals").all() as any[];
const grudges = (db: any) => db.prepare("SELECT * FROM creature_grudges ORDER BY opened_at").all() as any[];

describe("performTend appraises every Sol tend", () => {
  it("writes exactly one appraisal row keyed on the interaction", async () => {
    const { db, DB, target } = setup();
    const out = await performTend(DB, target, "cypher", "talk", null, Date.now());
    const rows = appraisals(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].interaction_id).toBe(out.interaction_id);
    expect(out.appraisal_id).toBe(rows[0].id);
    expect(rows[0].source).toBe("live");
    expect(JSON.parse(rows[0].tags)).toContain("talk");
    expect([0, 1]).toContain(rows[0].friction);
  });
  it("no via -> autonomous, weight 0.2, and the interaction row carries it (review focus 1)", async () => {
    const { db, DB, target } = setup();
    const out = await performTend(DB, target, "drevan", "feed", null, Date.now());
    const a = appraisals(db)[0];
    expect(a.via).toBe("autonomous");
    expect(a.weight).toBeCloseTo(0.2);
    const i = db.prepare("SELECT via FROM creature_interactions WHERE id = ?").get(out.interaction_id) as { via: string };
    expect(i.via).toBe("autonomous");
  });
  it("via hand -> weight 1.0", async () => {
    const { db, DB, target } = setup();
    await performTend(DB, target, "raziel", "talk", null, Date.now(), "hand");
    expect(appraisals(db)[0].via).toBe("hand");
    expect(appraisals(db)[0].weight).toBeCloseTo(1.0);
  });
  it("the appraisal + grudge writes ride the same batch as the interaction (all-or-nothing)", async () => {
    const { DB, solId, target, db } = setup();
    seedAversion(db, solId);
    const batches: string[][] = [];
    const orig = DB.batch;
    DB.batch = async (stmts: any[]) => { batches.push(stmts.map((s) => s.__sql)); return orig(stmts); };
    await performTend(DB, target, "raziel", "play", null, Date.now(), "hand");
    expect(batches).toHaveLength(1);
    const b = batches[0]!.join("\n");
    expect(b).toContain("INSERT INTO creature_interactions");
    expect(b).toContain("UPDATE creatures SET trust");
    expect(b).toContain("creature_appraisals");
    expect(b).toContain("creature_grudges");
  });
  it("real animals: no appraisal, no grudge, no new reads", async () => {
    const { db, DB, prepared } = setup();
    db.prepare("INSERT INTO creatures (id, name, kind, trust) VALUES ('cat1', 'Mochi', 'real_animal', 0.1)").run();
    const out = await performTend(DB, { id: "cat1", kind: "real_animal", trust: 0.1 }, "raziel", "feed", null, Date.now(), "hand");
    expect(appraisals(db)).toHaveLength(0);
    expect(out.appraisal_id).toBeNull();
    expect(out.grudge).toBeNull();
    expect(prepared.some((q: string) => /creature_quirks|creature_grudges|creature_appraisals/.test(q))).toBe(false);
  });
});

describe("grudges in the tend path", () => {
  it("an aversion hit opens a grudge and the reaction is a sulk line", async () => {
    const { db, DB, solId, target } = setup();
    seedAversion(db, solId);
    const out = await performTend(DB, target, "raziel", "play", null, Date.now(), "hand");
    const g = grudges(db);
    expect(g).toHaveLength(1);
    expect(g[0].actor).toBe("raziel");
    expect(g[0].resolved_at).toBeNull();
    expect(out.grudge).toEqual({ label: "still sore about being poked", progress: 0, of: 2, step: "open" });
    const a = appraisals(db)[0];
    expect(a.friction).toBe(1);
    expect(JSON.parse(a.tags)).toContain("quirk:q1");
    const rendered = ALL_SULK.map((l) => l.replace(/\{who\}/g, "you"));
    expect(rendered).toContain(out.care!.reaction);
    expect(ALL_SULK.map((l) => l.replace(/\{who\}/g, "Raziel"))).toContain(out.care!.reaction_named);
  });
  it("an open grudge progresses on a kind visit (sulk), then resolves met with the make-up line", async () => {
    const { db, DB, solId, target } = setup();
    seedAversion(db, solId);
    const now = Date.now();
    seedGrudge(db, solId, "raziel", now - H);
    const o1 = await performTend(DB, target, "raziel", "talk", null, now, "hand");
    expect(o1.grudge).toEqual({ label: "still sore about being poked", progress: 1, of: 2, step: "progress" });
    expect(ALL_SULK.map((l) => l.replace(/\{who\}/g, "you"))).toContain(o1.care!.reaction);
    const o2 = await performTend(DB, target, "raziel", "feed", null, now + 1000, "hand");
    expect(o2.grudge).toMatchObject({ step: "resolve", progress: 2, of: 2 });
    expect(MAKE_UP_LINES.map((l) => l.replace(/\{who\}/g, "you"))).toContain(o2.care!.reaction);
    const g = grudges(db)[0];
    expect(g.resolved_how).toBe("met");
    expect(g.resolved_at).not.toBeNull();
  });
  it("another actor's open grudge does not touch this tend", async () => {
    const { db, DB, solId, target } = setup();
    seedGrudge(db, solId, "raziel", Date.now() - H);
    const out = await performTend(DB, target, "cypher", "talk", null, Date.now());
    expect(out.grudge).toBeNull();
    expect(ALL_SULK.map((l) => l.replace(/\{who\}/g, "you"))).not.toContain(out.care!.reaction);
    expect(grudges(db)[0].progress).toBe(0);
  });
  it("R7: trust gain with an open grudge equals the gain without one", async () => {
    const now = Date.now();
    const a = setup({ trust: 0.5 });
    const b = setup({ trust: 0.5 });
    seedAversion(a.db, a.solId);
    seedAversion(b.db, b.solId);
    seedGrudge(a.db, a.solId, "raziel", now - H, { resolution: { kind: "item", action: "give", n: 1 } });
    const oa = await performTend(a.DB, a.target, "raziel", "feed", null, now, "hand");
    const ob = await performTend(b.DB, b.target, "raziel", "feed", null, now, "hand");
    expect(oa.grudge).not.toBeNull();
    expect(ob.grudge).toBeNull();
    expect(oa.trust).toBe(ob.trust);
    expect(oa.trust!).toBeGreaterThan(0.5);
  });
  it("R7: the tend that OPENS a grudge gains exactly what it would without the quirk", async () => {
    const now = Date.now();
    const a = setup({ trust: 0.5 });
    const b = setup({ trust: 0.5 });
    seedAversion(a.db, a.solId);
    const oa = await performTend(a.DB, a.target, "raziel", "play", null, now, "hand");
    const ob = await performTend(b.DB, b.target, "raziel", "play", null, now, "hand");
    expect(oa.grudge?.step).toBe("open");
    expect(oa.trust).toBe(ob.trust);
  });
  it("review focus 3: an expired grudge resolves (time) before the tend is appraised; normal line", async () => {
    const { db, DB, solId, target } = setup();
    const now = Date.now();
    seedGrudge(db, solId, "raziel", now - 73 * H);
    const out = await performTend(DB, target, "raziel", "talk", null, now, "hand");
    const g = grudges(db);
    expect(g).toHaveLength(1);
    expect(g[0].resolved_how).toBe("time");
    expect(out.grudge).toMatchObject({ step: "resolve", label: "still sore about being poked" });
    expect(ALL_SULK.map((l) => l.replace(/\{who\}/g, "you"))).not.toContain(out.care!.reaction);
    expect(MAKE_UP_LINES.map((l) => l.replace(/\{who\}/g, "you"))).not.toContain(out.care!.reaction);
  });
  it("an expired grudge + a fresh aversion hit: old resolves, a new one opens, one batch", async () => {
    const { db, DB, solId, target } = setup();
    seedAversion(db, solId);
    const now = Date.now();
    seedGrudge(db, solId, "raziel", now - 73 * H);
    const out = await performTend(DB, target, "raziel", "play", null, now, "hand");
    const g = grudges(db);
    expect(g).toHaveLength(2);
    expect(g.filter((r) => r.resolved_at === null)).toHaveLength(1);
    expect(g.find((r) => r.id === "g_old").resolved_how).toBe("time");
    expect(out.grudge?.step).toBe("open");
  });
  it("one open grudge per (creature, actor) is a DB rule (partial unique index)", () => {
    const { db, solId } = setup();
    seedGrudge(db, solId, "raziel", Date.now(), { id: "g1" });
    expect(() => seedGrudge(db, solId, "raziel", Date.now(), { id: "g2" })).toThrow(/UNIQUE/i);
    db.prepare("UPDATE creature_grudges SET resolved_at = ? WHERE id = 'g1'").run(iso(Date.now()));
    expect(() => seedGrudge(db, solId, "raziel", Date.now(), { id: "g3" })).not.toThrow();
    expect(() => seedGrudge(db, solId, "cypher", Date.now(), { id: "g4" })).not.toThrow();
  });
});

// ── HTTP surfaces ────────────────────────────────────────────────────────────
const env = (DB: unknown) => ({ DB, ADMIN_SECRET: "admin-tok", MCP_AUTH_SECRET: "mcp-tok" }) as never;
const req = (url: string, body?: unknown) => new Request(`https://h.example${url}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: "Bearer admin-tok", "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("HTTP", () => {
  it("POST interact with no via stores autonomous; via hand stores hand", async () => {
    const { db, DB, solId } = setup();
    const r1 = await interactCreature(req(`/mind/creatures/${solId}/interact`, { actor: "raziel", action: "talk" }), env(DB), { id: solId });
    expect(r1.status).toBe(200);
    const r2 = await interactCreature(req(`/mind/creatures/${solId}/interact`, { actor: "raziel", action: "feed", via: "hand" }), env(DB), { id: solId });
    expect(r2.status).toBe(200);
    const vias = (db.prepare("SELECT via, action FROM creature_appraisals ORDER BY created_at, action").all() as any[]);
    expect(vias.find((v) => v.action === "talk").via).toBe("autonomous");
    expect(vias.find((v) => v.action === "feed").via).toBe("hand");
    const body = await r2.json() as any;
    expect(body).toHaveProperty("appraisal_id");
    expect(body).toHaveProperty("grudge");
  });
  it("POST interact with an unknown via string falls back to autonomous, never hand", async () => {
    const { db, DB, solId } = setup();
    await interactCreature(req(`/mind/creatures/${solId}/interact`, { actor: "raziel", action: "talk", via: "HAND!" }), env(DB), { id: solId });
    expect((db.prepare("SELECT via FROM creature_appraisals").get() as any).via).toBe("autonomous");
  });
  it("Sol's own appearance row is marked appear", async () => {
    const { db, DB, solId } = setup();
    await interactCreature(req(`/mind/creatures/${solId}/interact`, { actor: "sol", action: "appear" }), env(DB), { id: solId });
    expect((db.prepare("SELECT via FROM creature_interactions WHERE actor = 'sol'").get() as any).via).toBe("appear");
  });
  it("GET creature: empty forming/quirks and null grudge when none", async () => {
    const { DB, solId } = setup();
    const res = await getCreature(req(`/mind/creatures/${solId}`), env(DB), { id: solId });
    const body = await res.json() as any;
    expect(body.traits_forming).toEqual([]);
    expect(body.quirks).toEqual([]);
    expect(body.grudge).toBeNull();
    expect(body.grudges).toEqual([]);
  });
  it("GET creature returns the open grudge label + progress, quirks and forming traits", async () => {
    const { db, DB, solId } = setup();
    seedAversion(db, solId);
    db.prepare("INSERT INTO creature_quirks (id, creature_id, title, behavior, kind, status) VALUES ('q2', ?, 'Old Habit', 'sulks', 'aversion', 'retired')").run(solId);
    db.prepare("INSERT INTO creature_quirks (id, creature_id, title, behavior, kind, status) VALUES ('q3', ?, 'Dawn Feeds', 'eats fast', 'preference', 'softening')").run(solId);
    for (let i = 0; i < 7; i++) {
      db.prepare("INSERT INTO creature_traits (id, creature_id, slug, category, entrenchment, status) VALUES (?, ?, ?, 'habit', ?, ?)")
        .run(`t${i}`, solId, `slug-${i}`, i, i === 6 ? "faded" : "candidate");
    }
    seedGrudge(db, solId, "raziel", Date.now() - H, { progress: 1 });
    seedGrudge(db, solId, "cypher", Date.now() - 80 * H, { id: "g_stale" }); // past 72h: not shown
    const res = await getCreature(req(`/mind/creatures/${solId}`), env(DB), { id: solId });
    const body = await res.json() as any;
    expect(body.grudge).toEqual({ actor: "raziel", label: "still sore about being poked", progress: 1, of: 2 });
    expect(body.grudges).toHaveLength(1);
    expect(body.quirks.map((q: any) => q.title).sort()).toEqual(["Being Poked", "Dawn Feeds"]);
    expect(body.quirks[0]).toHaveProperty("behavior");
    expect(body.quirks[0]).toHaveProperty("status");
    expect(body.traits_forming.map((t: any) => t.slug)).toEqual(["slug-5", "slug-4", "slug-3", "slug-2", "slug-1"]);
    expect(body.traits_forming[0]).toEqual({ slug: "slug-5", category: "habit", entrenchment: 5 });
  });
  it("hoard writes a hoard:<kind> appraisal for the maker (autonomous)", async () => {
    const { db, DB, solId } = setup();
    db.prepare("UPDATE creatures SET trust = 0.8, last_interaction_at = datetime('now') WHERE id = ?").run(solId);
    db.prepare("INSERT INTO companion_makes (id, companion_id, kind, title, status) VALUES ('mk1', 'drevan', 'drawing', 'a spiral of wire', 'ready')").run();
    const res = await hoardCreature(req(`/mind/creatures/${solId}/hoard`, { seed: 3 }), env(DB), { id: solId });
    const body = await res.json() as any;
    expect(body.hoarded).toHaveLength(1);
    const a = appraisals(db);
    expect(a).toHaveLength(1);
    expect(a[0].actor).toBe("drevan");
    expect(a[0].action).toBe("hoard");
    expect(a[0].via).toBe("autonomous");
    expect(a[0].weight).toBeCloseTo(0.2);
    expect(a[0].fit).toBeNull();
    expect(a[0].valence).toBeCloseTo(0.3);
    expect(a[0].arousal).toBeCloseTo(0.3);
    expect(JSON.parse(a[0].tags)).toEqual(["hoard:drawing"]);
    expect(a[0].interaction_id).toBe(`hoard:${solId}:mk1`);
  });
});
