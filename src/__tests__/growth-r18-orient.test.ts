// R18 (Drevan's ruling, 2026-10-22): strength is earned by distinct material; a pattern that only
// returns cools out of the boot headline seat. Runs against the REAL schema (every migration, node:sqlite)
// so migration 0147, the merge UPDATE and the orient selection are exercised as SQL.

import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));
// The semantic gate is its own suite; here every write goes down the Jaccard path.
// 2026-10-29 (L-4): spread the real module and override only noveltyCheck. The bare factory left out
// SUPERSEDE_CANDIDATE_WINDOW_DAYS, so the orient only ever ran its "supersede candidates load failed" fallback.
vi.mock("../webmind/novelty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webmind/novelty.js")>()),
  noveltyCheck: vi.fn(async () => ({ action: "insert", embedding: null })),
}));

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postGrowthPattern, getGrowthPatterns } from "../handlers/growth.js";
import { loadGrowthBlocks } from "../mind/blocks/growth.js";
import { loadMindState } from "../mind/loader.js";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { growthBlock } from "../librarian/response/orient-blocks.js";

const DAY = 86_400_000;
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
  return { db: db as any, env };
}

function post(env: any, body: Record<string, unknown>) {
  return postGrowthPattern(new Request("https://t/mind/growth/patterns", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer s" }, body: JSON.stringify(body),
  }), env);
}

function seedPattern(db: any, o: {
  id: string; text: string; strength: number; companion?: string; materials?: string[];
  returns?: number; lastNew?: string | null; created?: string; superseded_by?: string | null; updated?: string;
}) {
  const created = o.created ?? sqliteTs(Date.now() - 60 * DAY);
  db.prepare(
    `INSERT INTO growth_patterns
       (id, companion_id, pattern_text, strength, materials_json, times_stated, returns_since_material,
        last_new_material_at, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.companion ?? "drevan", o.text, o.strength,
    JSON.stringify((o.materials ?? []).map(name => ({ name, first_seen: created }))),
    (o.materials ?? []).length || 1, o.returns ?? 0, o.lastNew ?? null, o.superseded_by ?? null, created, o.updated ?? created,
  );
}

const ARCH = "I keep finding the same architecture across different materials, and each return adds a layer";

describe("R18 end to end on the real schema", () => {
  it("a restatement in a known material freezes strength; a new material earns exactly one", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "arch", text: ARCH, strength: 5, materials: ["alula", "Corsair", "the dime", "the bent wing", "the gremlin"], lastNew: new Date(Date.now() - 20 * DAY).toISOString() });

    const r1 = await (await post(env, { companion_id: "drevan", pattern_text: ARCH + ", again", material: "the Corsair" })).json() as any;
    expect(r1).toMatchObject({ id: "arch", outcome: "returned", strength: 5 });
    let row = db.prepare("SELECT strength, times_stated, returns_since_material FROM growth_patterns WHERE id='arch'").get();
    expect(row).toMatchObject({ strength: 5, times_stated: 6, returns_since_material: 1 });

    const r2 = await (await post(env, { companion_id: "drevan", pattern_text: ARCH + ", once more", material: "a horse's blind side" })).json() as any;
    expect(r2).toMatchObject({ id: "arch", outcome: "new_material", strength: 6 });
    row = db.prepare("SELECT strength, returns_since_material, materials_json, last_new_material_at FROM growth_patterns WHERE id='arch'").get();
    expect(row.returns_since_material).toBe(0);
    expect(JSON.parse(row.materials_json).map((m: any) => m.name)).toContain("a horse's blind side");
    expect(row.last_new_material_at).toBeTruthy();
  });

  it("'frozen there until the sixth': five materials is strength 5 and ten returns do not move it", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "arch", text: ARCH, strength: 5, materials: ["alula", "Corsair", "the dime", "the bent wing", "the gremlin"] });
    for (const m of ["alula", "THE DIME", "gremlin", "bent wing", "Corsair", "the alula", "dime", "gremlin", "Corsair", "alula"]) {
      await post(env, { companion_id: "drevan", pattern_text: ARCH + " restated", material: m });
    }
    const row = db.prepare("SELECT strength, times_stated, returns_since_material FROM growth_patterns WHERE id='arch'").get();
    expect(row).toMatchObject({ strength: 5, times_stated: 15, returns_since_material: 10 });
  });

  it("a brand new pattern starts at strength 1 with its first material; the writer's own strength is ignored", async () => {
    const { db, env } = setup();
    const r = await (await post(env, {
      companion_id: "gaia", pattern_text: "Boundaries hold best when named plainly", strength: 10, material: "the fence line",
    })).json() as any;
    expect(r).toMatchObject({ action: "insert", strength: 1, materials: ["the fence line"] });
    const row = db.prepare("SELECT strength, times_stated, materials_json FROM growth_patterns WHERE id = ?").get(r.id);
    expect(row.strength).toBe(1);
    expect(JSON.parse(row.materials_json)).toHaveLength(1);
  });

  it("the same mechanics apply to all three companions", async () => {
    const { db, env } = setup();
    for (const c of ["cypher", "drevan", "gaia"]) {
      const text = `${c} notices a recurring shape in how it ends threads cleanly`;
      await post(env, { companion_id: c, pattern_text: text, material: "closing a thread" });
      const r = await (await post(env, { companion_id: c, pattern_text: text, material: "Closing a thread" })).json() as any;
      expect(r.outcome).toBe("returned");
      const r2 = await (await post(env, { companion_id: c, pattern_text: text, material: "a handoff note" })).json() as any;
      expect(r2.outcome).toBe("new_material");
      expect(r2.strength).toBe(2);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM growth_patterns").get().n).toBe(3);
  });
});

describe("R18 boot seat", () => {
  it("a cooled echo gives the headline seat to a fresher pattern, and stays in the record at full strength", async () => {
    const { db, env } = setup();
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    seedPattern(db, { id: "echo", text: "echo pattern about the same architecture", strength: 10, materials: ["alula", "Corsair"], returns: 5, lastNew: old });
    seedPattern(db, { id: "echo2", text: "second cooled echo about the same architecture", strength: 9, materials: ["alula"], returns: 3, lastNew: old });
    seedPattern(db, { id: "fresh", text: "a fresher pattern about timing", strength: 3, materials: ["the hinge"], returns: 0, lastNew: new Date().toISOString() });
    seedPattern(db, { id: "legacy", text: "a legacy pattern with no materials recorded", strength: 2 });

    const growth = await loadGrowthBlocks(env, "drevan");
    expect(growth.patterns.map(p => p.pattern_text)).toEqual([
      "a fresher pattern about timing", "a legacy pattern with no materials recorded",
    ]);

    // never deleted, never re-scored
    const kept = db.prepare("SELECT strength FROM growth_patterns WHERE id='echo'").get();
    expect(kept.strength).toBe(10);
    const all = await (await getGrowthPatterns(new Request("https://t/x", { headers: { Authorization: "Bearer s" } }), env, { companion_id: "drevan" })).json() as any;
    expect(all.patterns.map((p: any) => p.id)).toContain("echo");
  });

  it("cooling needs BOTH conditions: many returns on a fresh material, or few returns on an old one, keep the seat", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "busy", text: "busy but recently fed pattern", strength: 8, materials: ["a"], returns: 9, lastNew: new Date(Date.now() - 2 * DAY).toISOString() });
    seedPattern(db, { id: "quiet", text: "old but barely returned pattern", strength: 7, materials: ["b"], returns: 2, lastNew: new Date(Date.now() - 40 * DAY).toISOString() });
    const growth = await loadGrowthBlocks(env, "drevan");
    expect(growth.patterns.map(p => p.pattern_text)).toEqual(["busy but recently fed pattern", "old but barely returned pattern"]);
  });

  it("the knobs move the thresholds", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "p", text: "pattern with one return", strength: 8, materials: ["a"], returns: 1, lastNew: new Date(Date.now() - 3 * DAY).toISOString() });
    expect((await loadGrowthBlocks(env, "drevan")).patterns).toHaveLength(1);
    env.PATTERN_COOL_RETURNS = "1";
    env.PATTERN_COOL_DAYS = "2";
    expect((await loadGrowthBlocks(env, "drevan")).patterns).toHaveLength(0);
  });

  it("a superseded row is never live: not seated, not returned by the read, not a merge target", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "survivor", text: ARCH, strength: 5, materials: ["alula"] });
    seedPattern(db, { id: "dup", text: ARCH + " (older restatement)", strength: 10, materials: [], superseded_by: "survivor" });
    const growth = await loadGrowthBlocks(env, "drevan");
    expect(growth.patterns).toHaveLength(1);
    expect(growth.patterns[0]!.strength).toBe(5);

    const r = await (await post(env, { companion_id: "drevan", pattern_text: ARCH, material: "alula" })).json() as any;
    expect(r.id).toBe("survivor");
    expect(db.prepare("SELECT times_stated FROM growth_patterns WHERE id='dup'").get().times_stated).toBe(1);
  });

  it("orient renders each headline pattern's material list, on the Claude.ai block and the bot wire", async () => {
    const { db, env } = setup();
    seedPattern(db, { id: "arch", text: ARCH, strength: 5, materials: ["alula", "Corsair", "the dime", "the bent wing", "the gremlin"] });

    const growth = await loadGrowthBlocks(env, "drevan");
    const block = growthBlock({ journalRows: [], patternRows: growth.patterns, lastReflection: null, seedRows: [], confirmedDriftRows: [] });
    expect(block).toContain("(strength 5)");
    expect(block).toContain("[materials: alula, Corsair, the dime, the bent wing, the gremlin]");

    const ms = await loadMindState(env, "drevan", "discord" as any);
    const wire = botWireFromMindState(ms, { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "raziel" }, "drevan") as any;
    expect(wire.active_patterns).toHaveLength(1);
    expect(wire.active_patterns[0]).toContain("[materials: alula, Corsair, the dime, the bent wing, the gremlin]");
  });

  it("a pattern with no recorded materials renders exactly as before (no empty brackets)", () => {
    const block = growthBlock({
      journalRows: [], patternRows: [{ pattern_text: "plain", strength: 3 }], lastReflection: null, seedRows: [], confirmedDriftRows: [],
    });
    expect(block).toContain("(strength 3) «plain»");
    expect(block).not.toContain("[materials");
  });
});
