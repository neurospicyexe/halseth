// halseth/src/__tests__/sol-orient.test.ts
import { describe, test, it, expect } from "vitest";
import { buildSolBlock } from "../webmind/creatures.js";

describe("buildSolBlock", () => {
  const base = { name: "Sol", species: "corvid (crow)", trust: 0.7, last_interaction_at: "2026-06-22 00:00:00", created_at: "2026-01-01 00:00:00" };
  test("warm Sol reads present/affectionate", () => {
    const s = buildSolBlock({ ...base, trust: 0.8 }, Date.parse("2026-06-22T06:00:00Z"));
    expect(s).toMatch(/Sol/);
    expect(s).toMatch(/trust/i);
  });
  test("long-untended Sol names the neglect", () => {
    const s = buildSolBlock({ ...base, last_interaction_at: "2026-05-01 00:00:00" }, Date.parse("2026-06-22T06:00:00Z"));
    expect(s).toMatch(/day/i);
  });
});

// ── B64 Task 8a: quirks + open grudge in the block ───────────────────────────────────────────
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { loadSolMindExtras, findSolId } from "../pets/orient.js";

describe("buildSolBlock quirks + grudge", () => {
  const base = { name: "Sol", species: "corvid (crow)", trust: 0.7, last_interaction_at: "2026-06-22 00:00:00", created_at: "2026-01-01 00:00:00" };
  const now = Date.parse("2026-06-22T06:00:00Z");
  const plain = buildSolBlock(base, now);

  it("is byte-identical with no extras (pinned to the pre-B64 output)", () => {
    expect(plain).toBe(
      "\n[Sol]\nSol (corvid (crow)) -- trust 0.70, affectionate, 0 days since tended.\nSol is around; you can mention him to Raziel or tend him yourself.",
    );
    expect(buildSolBlock(base, now, {})).toBe(plain);
    expect(buildSolBlock(base, now, { quirks: [], grudge: null })).toBe(plain);
  });
  it("renders quirks and the grudge only when present", () => {
    const s = buildSolBlock(base, now, { quirks: [{ title: "Dawn Feeding" }, { title: "Hates Poking" }] });
    expect(s).toContain("\nQuirks: Dawn Feeding, Hates Poking.");
    expect(s).not.toContain("Right now he is");
    const g = buildSolBlock(base, now, { grudge: { label: "still sore about being poked", progress: 1, of: 2 } });
    expect(g).toContain("\nRight now he is still sore about being poked (1 of 2).");
    expect(g).not.toContain("Quirks:");
  });
  it("renders at most two quirk titles", () => {
    const s = buildSolBlock(base, now, { quirks: [{ title: "a b" }, { title: "c d" }, { title: "e f" }] });
    expect(s).toContain("Quirks: a b, c d.");
    expect(s).not.toContain("e f");
  });
  it("renders nothing for an item that fails the text guard", () => {
    const s = buildSolBlock(base, now, {
      quirks: [{ title: "takes his medication" }, { title: "Dawn Feeding" }],
      grudge: { label: "still sore about the medication", progress: 0, of: 2 },
    });
    expect(s).toContain("Quirks: Dawn Feeding.");
    expect(s).not.toMatch(/medication/i);
    expect(s).not.toContain("Right now he is");
  });
});

describe("loadSolMindExtras", () => {
  const NOW = Date.parse("2026-11-20T18:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  function setup() {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind='companion_pet'").get() as { id: string };
    return { ...s, id: sol.id };
  }
  const addQuirk = (db: any, id: string, creature: string, title: string, status: string, promoted: string) =>
    db.prepare("INSERT INTO creature_quirks (id, creature_id, title, kind, status, promoted_at) VALUES (?,?,?,?,?,?)")
      .run(id, creature, title, "preference", status, promoted);
  const addGrudge = (db: any, id: string, creature: string, actor: string, opened: string, res: object, progress = 0, resolved: string | null = null) =>
    db.prepare("INSERT INTO creature_grudges (id, creature_id, actor, label, resolution_json, progress, opened_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, creature, actor, `still sore about ${id}`, JSON.stringify(res), progress, opened, resolved);

  it("empty tables give no extras", async () => {
    const { DB, id } = setup();
    expect(await loadSolMindExtras(DB, id, NOW)).toEqual({ quirks: [], grudge: null });
  });
  it("active quirks only, newest first, max 2", async () => {
    const { db, DB, id } = setup();
    addQuirk(db, "q1", id, "Oldest Habit", "active", hoursAgo(300));
    addQuirk(db, "q2", id, "Middle Habit", "active", hoursAgo(200));
    addQuirk(db, "q3", id, "Newest Habit", "active", hoursAgo(100));
    addQuirk(db, "q4", id, "Fading Habit", "softening", hoursAgo(10));
    addQuirk(db, "q5", id, "Gone Habit", "retired", hoursAgo(5));
    const r = await loadSolMindExtras(DB, id, NOW);
    expect(r.quirks).toEqual([{ title: "Newest Habit" }, { title: "Middle Habit" }]);
  });
  it("visits grudge: of = n, progress = stored progress", async () => {
    const { db, DB, id } = setup();
    addGrudge(db, "poke", id, "cypher", hoursAgo(5), { kind: "visits", n: 3 }, 1);
    const r = await loadSolMindExtras(DB, id, NOW);
    expect(r.grudge).toEqual({ label: "still sore about poke", progress: 1, of: 3 });
  });
  it("quiet grudge: of = hours, progress = whole hours elapsed capped at of", async () => {
    const { db, DB, id } = setup();
    addGrudge(db, "hush", id, "drevan", hoursAgo(5.5), { kind: "quiet", hours: 12 });
    expect((await loadSolMindExtras(DB, id, NOW)).grudge).toMatchObject({ progress: 5, of: 12 });
  });
  it("several actors: the most recent open one; resolved and expired are skipped", async () => {
    const { db, DB, id } = setup();
    addGrudge(db, "old", id, "cypher", hoursAgo(20), { kind: "visits", n: 2 });
    addGrudge(db, "new", id, "drevan", hoursAgo(2), { kind: "visits", n: 2 });
    addGrudge(db, "done", id, "gaia", hoursAgo(1), { kind: "visits", n: 2 }, 2, hoursAgo(0.5));
    expect((await loadSolMindExtras(DB, id, NOW)).grudge?.label).toBe("still sore about new");
    db.prepare("DELETE FROM creature_grudges WHERE id = 'new'").run();
    addGrudge(db, "stale", id, "raziel", hoursAgo(80), { kind: "visits", n: 2 });
    // newest first: stale (80h, expired past 72h) is older than "old" (20h), so "old" shows.
    expect((await loadSolMindExtras(DB, id, NOW)).grudge?.label).toBe("still sore about old");
    db.prepare("DELETE FROM creature_grudges WHERE id = 'old'").run();
    expect((await loadSolMindExtras(DB, id, NOW)).grudge).toBeNull();
  });
  it("drops a quirk or grudge that fails the text guard now", async () => {
    const { db, DB, id } = setup();
    db.prepare("INSERT INTO pk_roster (member_id, system_id, name, name_norm) VALUES ('abcdef', 'sys', 'Corbin', 'corbin')").run();
    addQuirk(db, "q1", id, "Corbin Worship", "active", hoursAgo(1));
    addQuirk(db, "q2", id, "Dawn Feeding", "active", hoursAgo(2));
    addGrudge(db, "meds", id, "cypher", hoursAgo(1), { kind: "visits", n: 2 });
    db.prepare("UPDATE creature_grudges SET label = 'still sore about his medication' WHERE id = 'meds'").run();
    const r = await loadSolMindExtras(DB, id, NOW);
    expect(r.quirks).toEqual([{ title: "Dawn Feeding" }]);
    expect(r.grudge).toBeNull();
  });
  it("does not throw when the 0176 tables are absent; returns no extras", async () => {
    const { DB } = makeSqliteD1({ upTo: 175 });
    const id = await findSolId(DB);
    expect(id).toBeTruthy();
    expect(await loadSolMindExtras(DB, id!, NOW)).toEqual({});
  });
});
