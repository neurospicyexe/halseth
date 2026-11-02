// Unresolved x intensity on the boot slate (T3 P2, 2026-10-13). Real SQLite, real schema.
//
// Prod finding: companion_open_loops.weight is REAL but 22 of 23 open loops carried the labels
// 'light'/'medium'/'high'/'heavy'. TEXT sorts above numbers and alphabetically, so the old boot
// ORDER BY (`weight DESC, opened_at ASC`) ranked medium > light > high > heavy -- the heaviest
// loops last -- and broke ties toward the OLDEST row. bootLoopsSql ranks decayed numeric weight.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { bootLoopsSql, loopWeightSql } from "../webmind/loops.js";

function seed() {
  const h = makeSqliteD1();
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const add = (id: string, weight: string | number, openedDaysAgo: number, extra: { closed?: boolean; actedDaysAgo?: number } = {}) =>
    h.db.prepare(
      `INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at, closed_at, acted_at)
       VALUES (?, 'drevan', ?, ?, ?, ?, ?)`,
    ).run(id, `loop ${id}`, weight as never, daysAgo(openedDaysAgo),
      extra.closed ? daysAgo(0) : null, extra.actedDaysAgo !== undefined ? daysAgo(extra.actedDaysAgo) : null);
  const boot = async () =>
    (await h.DB.prepare(bootLoopsSql()).bind("drevan").all()).results as Array<{ id: string; weight: number; effective_weight: number }>;
  return { h, add, boot };
}

describe("loopWeightSql", () => {
  it("passes numbers through and maps labels onto 0..1 in the right order", () => {
    const { h } = seed();
    const w = (v: string | number) => {
      h.db.prepare("DELETE FROM companion_open_loops").run();
      h.db.prepare("INSERT INTO companion_open_loops (id, companion_id, loop_text, weight) VALUES ('x','cypher','t',?)").run(v as never);
      return (h.db.prepare(`SELECT ${loopWeightSql()} AS w FROM companion_open_loops`).get() as { w: number }).w;
    };
    expect(w(0.63)).toBeCloseTo(0.63);
    expect(w("light")).toBeLessThan(w("medium"));
    expect(w("medium")).toBeLessThan(w("high"));
    expect(w("high")).toBeLessThan(w("heavy"));
    expect(w("HEAVY ")).toBe(w("heavy"));
    expect(w("whatever")).toBe(0.5);
  });
});

describe("boot slate ranking", () => {
  it("a heavy loop outranks a medium one of the same age (the label sort was inverted)", async () => {
    const { add, boot } = seed();
    add("med", "medium", 3);
    add("light", "light", 3);
    add("high", "high", 3);
    add("heavy", "heavy", 3);
    expect((await boot()).map((r) => r.id)).toEqual(["heavy", "high", "med", "light"]);
  });

  it("returns a numeric weight and the decayed effective_weight", async () => {
    const { add, boot } = seed();
    add("a", "heavy", 14);
    const [row] = await boot();
    expect(row!.weight).toBe(0.9);
    expect(row!.effective_weight).toBeCloseTo(0.45, 1); // one half-life
  });

  it("at equal weight the FRESHER claim wins, not the oldest (stasis does not hold the slot)", async () => {
    const { add, boot } = seed();
    add("old", 0.5, 40);
    add("new", 0.5, 1);
    expect((await boot()).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("acting on a loop refreshes it; the decay anchors on acted_at", async () => {
    const { add, boot } = seed();
    add("stale", 0.6, 30);
    add("acted", 0.6, 30, { actedDaysAgo: 1 });
    expect((await boot())[0]!.id).toBe("acted");
  });

  it("only unresolved loops surface, capped at five, and reading writes nothing", async () => {
    const { h, add, boot } = seed();
    add("closed", 1.0, 0, { closed: true });
    for (let i = 0; i < 7; i++) add(`o${i}`, 0.5, i);
    const before = JSON.stringify(h.db.prepare("SELECT * FROM companion_open_loops ORDER BY id").all());
    const rows = await boot();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.id)).not.toContain("closed");
    expect(JSON.stringify(h.db.prepare("SELECT * FROM companion_open_loops ORDER BY id").all())).toBe(before);
  });
});
