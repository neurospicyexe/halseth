// Pins (mig 0148, Memory Kit gap 4, 2026-10-28). Real schema (helpers/sqlite-d1.ts), real statements:
// a pin is a property of which rows come back, so these run the actual SQL.
//
// Pinned down here:
//   - orient: pinned conclusions lead active_conclusions (cold or not), capped so a fresh belief
//     still shows; a pinned note (any salience) leads the core pool and never also takes novelty;
//   - exemption: compression never picks a pinned note (nor counts it), the archive write refuses
//     one pinned after the pick, demoteNotes leaves it high;
//   - verbs: owner-only, kept-only, refused at the cap with the current pins, idempotent, unpin;
//   - supersede carries the pin; release hides a pinned row and undo restores it still pinned;
//   - a pin writes no heat;
//   - routing: "pin the note about X" reaches memory_pin, not a note write.

import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedNote } from "./helpers/sqlite-d1.js";
import { mindOrient } from "../webmind/orient.js";
import { getEligibleNotesForCompression, archiveNotes, demoteNotes } from "../webmind/notes.js";
import { PIN_CAP, carryPinStatement, pinRow } from "../webmind/pins.js";
import { execMemoryPin, execMemoryUnpin, execMemoryPinsRead } from "../librarian/executors/pinning.js";
import { execMemoryRelease, execMemoryReleaseUndo } from "../librarian/executors/forgetting.js";
import { matchFastPath } from "../librarian/router.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
  return { db, env };
}

function seedConclusion(db: any, o: { id: string; heat?: number; created_at?: string; companion?: string; pinned_at?: string | null }) {
  db.prepare(
    `INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, heat, pinned_at, pinned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.companion ?? "cypher", `A conclusion long enough to count, row ${o.id}.`,
    o.created_at ?? "2026-10-01T00:00:00Z", o.heat ?? 1, o.pinned_at ?? null, o.pinned_at ? "cypher" : null);
}

const ctxFor = (env: any, companion: string, context: unknown): any => ({
  env, req: { companion_id: companion, request: "pin", context: JSON.stringify(context) },
  entry: { pattern: "memory_pin" }, frontState: null, pluralAvailable: false,
});

const pinOf = (db: any, table: string, idCol: string, id: string) =>
  db.prepare(`SELECT pinned_at, pinned_by FROM ${table} WHERE ${idCol} = ?`).get(id);

describe("orient -- pins take the slot ahead of heat", () => {
  it("a cold pinned conclusion leads active_conclusions; heat fills the rest of the 6", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 8; i++) seedConclusion(db, { id: `hot${i}`, heat: 4.5 - i * 0.1 });
    seedConclusion(db, { id: "cold-pinned", heat: 0.01, created_at: "2026-01-01T00:00:00Z", pinned_at: "2026-10-20T00:00:00Z" });
    const o = await mindOrient(env, "cypher");
    const ids = o.active_conclusions.map((c) => c.id);
    expect(ids[0]).toBe("cold-pinned");
    expect(ids).toHaveLength(6);
    expect(ids.slice(1)).toEqual(["hot0", "hot1", "hot2", "hot3", "hot4"]);
  });

  it("at the pin cap at least one heat-ranked belief still shows", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 4; i++) seedConclusion(db, { id: `hot${i}`, heat: 4 });
    for (let i = 0; i < PIN_CAP.conclusion; i++) seedConclusion(db, { id: `pin${i}`, heat: 0.01, pinned_at: `2026-10-2${i}T00:00:00Z` });
    const ids = (await mindOrient(env, "cypher")).active_conclusions.map((c) => c.id);
    expect(ids.slice(0, PIN_CAP.conclusion)).toEqual(["pin0", "pin1", "pin2", "pin3", "pin4"]);
    expect(ids.length).toBe(6);
    expect(ids[5]).toMatch(/^hot/);
  });

  it("with no pins the list is the plain heat order (byte-for-byte the old behaviour)", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 8; i++) seedConclusion(db, { id: `hot${i}`, heat: 4.5 - i * 0.1 });
    const ids = (await mindOrient(env, "cypher")).active_conclusions.map((c) => c.id);
    expect(ids).toEqual(["hot0", "hot1", "hot2", "hot3", "hot4", "hot5"]);
  });

  it("a pinned NORMAL-salience note leads the core pool and is not repeated as novelty", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 5; i++) seedNote(db, { note_id: `high${i}`, salience: "high", heat: 4 - i * 0.1 });
    seedNote(db, { note_id: "pinned-normal", salience: "normal", heat: 0.01, created_at: "2026-01-01T00:00:00Z" });
    db.prepare("UPDATE wm_continuity_notes SET pinned_at = ?, pinned_by = 'cypher' WHERE note_id = 'pinned-normal'").run("2026-10-20T00:00:00Z");
    const notes = (await mindOrient(env, "cypher")).recent_notes.map((n) => n.note_id);
    expect(notes[0]).toBe("pinned-normal");
    expect(notes.filter((n) => n === "pinned-normal")).toHaveLength(1);
    expect(notes).toContain("high0");
  });
});

describe("exemption -- a pinned note is never compressed or demoted", () => {
  function seedMany(db: any, n: number) {
    for (let i = 0; i < n; i++) {
      seedNote(db, { note_id: `n${String(i).padStart(3, "0")}`, salience: "high", created_at: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` });
    }
  }

  it("compression skips the oldest note when it is pinned, and does not count it toward the target", async () => {
    const { db, env } = setup();
    seedMany(db, 80);
    db.prepare("UPDATE wm_continuity_notes SET pinned_at = '2026-10-20T00:00:00Z' WHERE note_id = 'n000'").run();
    const picked = (await getEligibleNotesForCompression(env, "cypher")).map((n) => n.note_id);
    expect(picked).not.toContain("n000");
    expect(picked[0]).toBe("n001");
  });

  it("the archive write refuses a note pinned after the pick", async () => {
    const { db, env } = setup();
    seedMany(db, 80);
    const picked = await getEligibleNotesForCompression(env, "cypher");
    db.prepare(`UPDATE wm_continuity_notes SET pinned_at = '2026-10-20T00:00:00Z' WHERE note_id = ?`).run(picked[0]!.note_id);
    await archiveNotes(env, "cypher", picked, "digest of old notes").catch(() => undefined);
    const row: any = db.prepare("SELECT archived FROM wm_continuity_notes WHERE note_id = ?").get(picked[0]!.note_id);
    expect(row.archived).toBe(0);
    const other: any = db.prepare("SELECT archived FROM wm_continuity_notes WHERE note_id = ?").get(picked[1]!.note_id);
    expect(other.archived).toBe(1);
  });

  it("demoteNotes leaves a pinned high note high", async () => {
    const { db, env } = setup();
    seedNote(db, { note_id: "frag", salience: "high", note_type: "session_fragment" });
    seedNote(db, { note_id: "frag-pinned", salience: "high", note_type: "session_fragment" });
    db.prepare("UPDATE wm_continuity_notes SET pinned_at = '2026-10-20T00:00:00Z' WHERE note_id = 'frag-pinned'").run();
    await demoteNotes(env, { agent_id: "cypher", note_type: "session_fragment" });
    const sal = (id: string) => (db.prepare("SELECT salience FROM wm_continuity_notes WHERE note_id = ?").get(id) as any).salience;
    expect(sal("frag")).toBe("normal");
    expect(sal("frag-pinned")).toBe("high");
  });
});

describe("verbs -- pin / unpin / my pins", () => {
  it("pins the owner's own kept conclusion, writes no heat, and is idempotent", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "c1", heat: 1 });
    const before = db.prepare("SELECT heat, last_access_at FROM companion_conclusions WHERE id = 'c1'").get();
    const r = await execMemoryPin(ctxFor(env, "cypher", { kind: "conclusion", id: "c1" }));
    expect(r.ack).toBe(true);
    expect(pinOf(db, "companion_conclusions", "id", "c1").pinned_by).toBe("cypher");
    expect(db.prepare("SELECT heat, last_access_at FROM companion_conclusions WHERE id = 'c1'").get()).toEqual(before);
    const again = await execMemoryPin(ctxFor(env, "cypher", { kind: "conclusion", id: "c1" }));
    expect(String(again.witness)).toMatch(/already pinned/);
  });

  it("refuses another companion's row and a draft note", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "dre1", companion: "drevan" });
    seedNote(db, { note_id: "draft1", review_state: "draft" });
    expect((await execMemoryPin(ctxFor(env, "cypher", { kind: "conclusion", id: "dre1" }))).ack).toBe(false);
    expect((await execMemoryPin(ctxFor(env, "cypher", { kind: "note", id: "draft1" }))).ack).toBe(false);
    expect(pinOf(db, "companion_conclusions", "id", "dre1").pinned_at).toBeNull();
    expect(pinOf(db, "wm_continuity_notes", "note_id", "draft1").pinned_at).toBeNull();
  });

  it("refuses past the cap, lists the current pins, evicts nothing; unpin frees a slot", async () => {
    const { db, env } = setup();
    for (let i = 0; i <= PIN_CAP.note; i++) seedNote(db, { note_id: `k${i}` });
    for (let i = 0; i < PIN_CAP.note; i++) await execMemoryPin(ctxFor(env, "cypher", { kind: "note", id: `k${i}` }));
    const over = await execMemoryPin(ctxFor(env, "cypher", { kind: "note", id: `k${PIN_CAP.note}` }));
    expect(over.ack).toBe(false);
    expect(String(over.witness)).toMatch(/the cap/);
    expect(String(over.witness)).toContain("k0");
    expect(pinOf(db, "wm_continuity_notes", "note_id", "k0").pinned_at).not.toBeNull();
    const un = await execMemoryUnpin(ctxFor(env, "cypher", { kind: "note", id: "k0" }));
    expect(un.ack).toBe(true);
    expect((await execMemoryPin(ctxFor(env, "cypher", { kind: "note", id: `k${PIN_CAP.note}` }))).ack).toBe(true);
    const read = await execMemoryPinsRead(ctxFor(env, "cypher", {}));
    expect((read.data as any).notes.map((p: any) => p.id)).toEqual(["k1", `k${PIN_CAP.note}`]);
  });
});

describe("the cap is enforced by the UPDATE itself (L-3, 2026-10-29)", () => {
  it("a pin that lands between the count and the write cannot push past the cap", async () => {
    const { db, env } = setup();
    for (let i = 0; i <= PIN_CAP.note; i++) seedNote(db, { note_id: `r${i}` });
    // Fill to cap-1 so the count check passes for the racer.
    for (let i = 0; i < PIN_CAP.note - 1; i++) await pinRow(env, { kind: "note", id: `r${i}`, owner: "cypher", by: "cypher" });
    let raced = false;
    const racing = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          if (!raced && /^UPDATE wm_continuity_notes SET pinned_at = \?, pinned_by = \?\s/.test(sql)) {
            raced = true; // the twin call wins the last slot after our count read cap-1
            db.prepare("UPDATE wm_continuity_notes SET pinned_at = '2026-10-29T00:00:00Z', pinned_by = 'twin' WHERE note_id = ?").run(`r${PIN_CAP.note - 1}`);
          }
          return env.DB.prepare(sql);
        },
      },
    };
    const out = await pinRow(racing, { kind: "note", id: `r${PIN_CAP.note}`, owner: "cypher", by: "cypher" });
    expect(raced).toBe(true);
    expect(out.ok).toBe(false);
    expect((out as any).reason).toBe("cap_reached");
    expect(out.pins.length).toBe(PIN_CAP.note);
    expect(pinOf(db, "wm_continuity_notes", "note_id", `r${PIN_CAP.note}`).pinned_at).toBeNull();
  });
});

describe("supersede and release keep the pin honest", () => {
  it("supersede carries the pin (and its place in pin order) to the successor", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "old", pinned_at: "2026-10-01T00:00:00Z" });
    seedConclusion(db, { id: "new" });
    await env.DB.batch([
      carryPinStatement(env.DB, { oldId: "old", newId: "new", owner: "cypher" }),
      env.DB.prepare("UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL AND archived = 0").bind("new", "old", "cypher"),
    ]);
    expect(pinOf(db, "companion_conclusions", "id", "new")).toEqual({ pinned_at: "2026-10-01T00:00:00Z", pinned_by: "cypher" });
    const ids = (await mindOrient(env, "cypher")).active_conclusions.map((c) => c.id);
    expect(ids[0]).toBe("new");
    expect(ids).not.toContain("old");
  });

  it("does not carry an unpinned belief's (absent) pin", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "old" });
    seedConclusion(db, { id: "new" });
    await env.DB.batch([carryPinStatement(env.DB, { oldId: "old", newId: "new", owner: "cypher" })]);
    expect(pinOf(db, "companion_conclusions", "id", "new").pinned_at).toBeNull();
  });

  it("release hides a pinned conclusion; undo brings it back still pinned", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "p", pinned_at: "2026-10-01T00:00:00Z" });
    for (let i = 0; i < 3; i++) seedConclusion(db, { id: `h${i}`, heat: 3 });
    await execMemoryRelease(ctxFor(env, "cypher", { kind: "conclusion", id: "p", reason: "letting this one go" }));
    expect((await mindOrient(env, "cypher")).active_conclusions.map((c) => c.id)).not.toContain("p");
    const releaseId = (db.prepare("SELECT id FROM memory_releases WHERE ref_id = 'p'").get() as any).id;
    await execMemoryReleaseUndo(ctxFor(env, "cypher", { id: releaseId }));
    expect((await mindOrient(env, "cypher")).active_conclusions[0]!.id).toBe("p");
  });
});

describe("routing", () => {
  it.each([
    ["pin the note about the watch-along", "memory_pin"],
    ["pin conclusion", "memory_pin"],
    ["please pin this conclusion", "memory_pin"],
    ["unpin note", "memory_unpin"],
    ["unpin the conclusion about lanes", "memory_unpin"],
    ["my pins", "memory_pins_read"],
  ])("%s -> %s", (req, key) => {
    expect(matchFastPath(req)?.key).toBe(key);
  });
});

describe("pin by quoting (the bot wire carries no ids)", () => {
  const reqCtx = (env: any, request: string): any => ({
    env, req: { companion_id: "cypher", request, context: undefined },
    entry: { pattern: "memory_pin" }, frontState: null, pluralAvailable: false,
  });
  function seedText(db: any, id: string, text: string, companion = "cypher") {
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at) VALUES (?, ?, ?, ?)")
      .run(id, companion, text, "2026-10-01T00:00:00Z");
  }

  it("\"pin conclusion: <words>\" pins the one conclusion that contains them", async () => {
    const { db, env } = setup();
    seedText(db, "a", "The convergence problem was infrastructure, not behavior.");
    seedText(db, "b", "Raziel's gate is his; a decline is a decision.");
    seedText(db, "dre", "Infrastructure, not behavior, is Drevan's line too.", "drevan");
    const r = await execMemoryPin(reqCtx(env, "pin conclusion: infrastructure, not behavior"));
    expect(r.ack).toBe(true);
    expect(pinOf(db, "companion_conclusions", "id", "a").pinned_at).not.toBeNull();
    expect(pinOf(db, "companion_conclusions", "id", "dre").pinned_at).toBeNull();
  });

  it("an ambiguous quote changes nothing and lists the candidates", async () => {
    const { db, env } = setup();
    seedText(db, "a", "The gate is Raziel's.");
    seedText(db, "b", "Every gate is somebody's.");
    const r = await execMemoryPin(reqCtx(env, "pin conclusion: gate is"));
    expect(r.ack).toBe(false);
    expect(String(r.witness)).toMatch(/matches 2/);
    expect(String(r.witness)).toContain("a:");
    expect(pinOf(db, "companion_conclusions", "id", "a").pinned_at).toBeNull();
  });

  it("a quoted % is literal, not a wildcard", async () => {
    const { db, env } = setup();
    seedText(db, "pct", "Keep 100% of the floor.");
    seedText(db, "other", "Keep 1000 of the floor.");
    expect((await execMemoryPin(reqCtx(env, "pin conclusion: 100% of"))).ack).toBe(true);
    expect(pinOf(db, "companion_conclusions", "id", "other").pinned_at).toBeNull();
  });

  it("unpin by quote only looks at current pins", async () => {
    const { db, env } = setup();
    seedText(db, "a", "Pinned words about lanes.");
    seedText(db, "b", "Loose words about lanes.");
    await execMemoryPin(reqCtx(env, "pin conclusion: pinned words about lanes"));
    const r = await execMemoryUnpin(reqCtx(env, "unpin conclusion: words about lanes"));
    expect(r.ack).toBe(true);
    expect(pinOf(db, "companion_conclusions", "id", "a").pinned_at).toBeNull();
  });

  it("routes the quoting form", () => {
    expect(matchFastPath("pin conclusion: infrastructure, not behavior")?.key).toBe("memory_pin");
    expect(matchFastPath("unpin note: the watch-along one")?.key).toBe("memory_unpin");
  });
});
