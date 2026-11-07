import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";

const SQL_PATH = fileURLToPath(new URL("../../migrations/0176_sol_mind.sql", import.meta.url).href);

describe("mig 0176 sol mind", () => {
  const { db } = makeSqliteD1();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

  it("creates all 7 tables", () => {
    for (const t of ["creature_appraisals", "creature_traits", "creature_trait_evidence", "creature_quirks", "creature_grudges", "creature_personas", "creature_voice_shadow"]) {
      expect(tables).toContain(t);
    }
  });
  it("adds creature_interactions.via", () => {
    const cols = (db.prepare("PRAGMA table_info(creature_interactions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("via");
  });
  it("seeds Sol's persona", () => {
    const sol = db.prepare("SELECT id FROM creatures WHERE kind='companion_pet' AND name='Sol'").get() as { id: string };
    const p = db.prepare("SELECT * FROM creature_personas WHERE creature_id = ?").get(sol.id) as any;
    expect(p.species).toBe("crow");
    expect(JSON.parse(p.body_json).sounds).toContain("kraa");
    const lines = JSON.parse(p.sample_lines) as string[];
    expect(lines).toHaveLength(6);
    const src = fs.readFileSync(fileURLToPath(new URL("../webmind/creatures.ts", import.meta.url).href), "utf8");
    for (const l of lines) expect(src).toContain(l.replace(/''/g, "'"));
  });
  it("re-applying the seed is a no-op", () => {
    const sql = fs.readFileSync(SQL_PATH, "utf8");
    const seed = sql.slice(sql.indexOf("INSERT OR IGNORE"));
    db.exec(seed);
    expect((db.prepare("SELECT COUNT(*) n FROM creature_personas").get() as any).n).toBe(1);
  });
  it("uses no REFERENCES", () => {
    expect(fs.readFileSync(SQL_PATH, "utf8")).not.toMatch(/REFERENCES/i);
  });
});
