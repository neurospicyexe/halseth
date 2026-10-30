// Migration 0153: raziel_reads (what Raziel has opened) + companion_state.mood_set_at.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url).href);

describe("migration 0153", () => {
  it("creates raziel_reads with the 3 columns and a composite PK", () => {
    const { db } = makeSqliteD1();
    const cols = db.prepare("PRAGMA table_info(raziel_reads)").all() as Array<{ name: string; pk: number }>;
    expect(cols.map((c) => c.name).sort()).toEqual(["item_id", "item_kind", "read_at"]);
    expect(cols.filter((c) => c.pk > 0)).toHaveLength(2);
  });

  it("INSERT OR IGNORE on the same (item_kind, item_id) leaves one row", () => {
    const { db } = makeSqliteD1();
    const ins = db.prepare("INSERT OR IGNORE INTO raziel_reads (item_kind, item_id, read_at) VALUES (?, ?, ?)");
    ins.run("note", "n1", "2026-10-30T00:00:00Z");
    ins.run("note", "n1", "2026-10-30T01:00:00Z");
    const row = db.prepare("SELECT COUNT(*) AS n FROM raziel_reads").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("adds companion_state.mood_set_at", () => {
    const { db } = makeSqliteD1();
    const cols = db.prepare("PRAGMA table_info(companion_state)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("mood_set_at");
  });

  it("backfills mood_set_at from updated_at where a mood or compound state exists", () => {
    const { db } = makeSqliteD1({ upTo: 152 });
    db.prepare("INSERT OR REPLACE INTO companion_state (companion_id, current_mood, compound_state, updated_at) VALUES ('cypher', 'steady', NULL, '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT OR REPLACE INTO companion_state (companion_id, current_mood, compound_state, updated_at) VALUES ('gaia', NULL, NULL, '2026-01-02T00:00:00Z')").run();
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "0153_raziel_reads_and_mood_set_at.sql"), "utf8");
    db.exec(sql);
    const c = db.prepare("SELECT mood_set_at FROM companion_state WHERE companion_id='cypher'").get() as any;
    const g = db.prepare("SELECT mood_set_at FROM companion_state WHERE companion_id='gaia'").get() as any;
    expect(c.mood_set_at).toBe("2026-01-01T00:00:00Z");
    expect(g.mood_set_at).toBeNull();
  });
});
