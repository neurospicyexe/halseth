// src/__tests__/creatures-handler.test.ts
import { describe, test, expect } from "vitest";
// Validation is pure; exported for testability.
import { validateInteract } from "../handlers/creatures.js";

describe("validateInteract", () => {
  test("companion may feed", () => {
    expect(validateInteract("cypher", "feed")).toBeNull();
  });
  test("sol may only appear", () => {
    expect(validateInteract("sol", "appear")).toBeNull();
    expect(validateInteract("sol", "feed")).toMatch(/sol/i);
  });
  test("companion may not 'appear'", () => {
    expect(validateInteract("cypher", "appear")).toMatch(/action/i);
  });
  test("unknown actor rejected", () => {
    expect(validateInteract("stranger", "feed")).toMatch(/actor/i);
  });
});

// ── performTend (0100): the ONE shared write path for tends ──────────────────
import { performTend } from "../webmind/creature-interact.js";

/** Minimal fake D1: records every statement; scripted first()/run() results. */
function fakeDb() {
  const executed: Array<{ sql: string; binds: unknown[] }> = [];
  let trustAfter = 0.82;
  const db = {
    executed,
    setTrustAfter(t: number) { trustAfter = t; },
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            sql, binds,
            async run() {
              executed.push({ sql, binds });
              // INSERT OR IGNORE reports a landed row (changes=1) unless a
              // duplicate marker is present in the milestone id.
              const dup = sql.includes("INSERT OR IGNORE") && String(binds[1]).startsWith("dup_");
              return { meta: { changes: dup ? 0 : 1 } };
            },
            async first() {
              executed.push({ sql, binds });
              if (sql.includes("SELECT trust, state_json")) return { trust: trustAfter, state_json: '{"mood":"delighted"}' };
              if (sql.includes("COUNT(*)")) return { n: 0 };
              return null;
            },
            async all() { executed.push({ sql, binds }); return { results: [] }; },
          };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      for (const s of stmts) executed.push({ sql: s.sql, binds: s.binds });
      return [];
    },
  };
  return db;
}

describe("performTend", () => {
  test("fires exactly the crossed milestone and reports it", async () => {
    const db = fakeDb();
    db.setTrustAfter(0.82); // 0.78 + give(0.06) crosses 0.80
    const out = await performTend(db as never, { id: "sol1", kind: "companion_pet", trust: 0.78 }, "drevan", "give", null);
    expect(out.trust).toBe(0.82);
    expect(out.milestones_fired.map(m => m.id)).toEqual(["shoulder_perch"]);
    expect(out.milestones_fired[0]!.text).toContain("shoulder");
  });
  test("no crossing, no milestone", async () => {
    const db = fakeDb();
    db.setTrustAfter(0.79);
    const out = await performTend(db as never, { id: "sol1", kind: "companion_pet", trust: 0.78 }, "cypher", "talk", null);
    expect(out.milestones_fired).toEqual([]);
  });
  test("give with words lands in the nest with the giver's name", async () => {
    const db = fakeDb();
    db.setTrustAfter(0.5);
    await performTend(db as never, { id: "sol1", kind: "companion_pet", trust: 0.45 }, "raziel", "give", "a smooth stone from the river");
    const nestInsert = db.executed.find(e => e.sql.includes("INSERT INTO creature_nest"));
    expect(nestInsert).toBeDefined();
    expect(nestInsert!.binds).toContain("a smooth stone from the river");
    expect(nestInsert!.binds).toContain("raziel");
  });
  test("real animals get neither milestones nor nest rows (texts are Sol's)", async () => {
    const db = fakeDb();
    db.setTrustAfter(0.9);
    const out = await performTend(db as never, { id: "cat1", kind: "real_animal", trust: 0.1 }, "raziel", "give", "a ribbon");
    expect(out.milestones_fired).toEqual([]);
    expect(db.executed.some(e => e.sql.includes("creature_nest"))).toBe(false);
  });
});
