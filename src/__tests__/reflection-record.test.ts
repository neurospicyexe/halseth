// B63 step 4 (Halseth side): the companion's own record for the nightly reflection, the pressure it
// may name as a tension, Gaia's spoke_without_load flags, and companion_tensions.drags_float (mig 0173).
// Real schema via node:sqlite. All text is FIXTURE text.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getReflectionRecord, pressureOffers, detectSpokeWithoutLoad } from "../webmind/reflection-record.js";
import { loadFloor } from "../webmind/garden.js";
import { postTension, patchTension } from "../handlers/companion-growth.js";
import { execTensionAdd } from "../librarian/executors/companion-growth.js";

function setup(opts: { upTo?: number } = {}) {
  const { db, DB } = makeSqliteD1(opts);
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  db.exec("INSERT OR IGNORE INTO companions (id, name, created_at) VALUES ('cypher','Cypher','2026-01-01'),('drevan','Drevan','2026-01-01'),('gaia','Gaia','2026-01-01')");
  db.exec("INSERT OR IGNORE INTO companion_state (companion_id) VALUES ('cypher'),('drevan'),('gaia')");
  return { db, env };
}
let n = 0;
function floats(db: any, id: string, f: [number, number, number], b: [number, number, number], offSince: object | null = null) {
  db.prepare("UPDATE companion_state SET soma_float_1=?, soma_float_2=?, soma_float_3=?, soma_float_1_baseline=?, soma_float_2_baseline=?, soma_float_3_baseline=?, ferment_off_since=? WHERE companion_id=?")
    .run(...f, ...b, offSince ? JSON.stringify(offSince) : null, id);
}
function somaEvent(db: any, id: string, key: string, before: number | null, after: number | null, ago: string, o: { cause?: string; detail?: string; kind?: string } = {}) {
  db.prepare("INSERT INTO companion_soma_events (id, companion_id, float_key, before_value, after_value, delta, kind, writer, cause_table, cause_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, ?, datetime('now', ?))")
    .run(`se${++n}`, id, key, before, after, before != null && after != null ? after - before : null, o.kind ?? "stimulus",
      o.cause ? "companion_ferment_events" : null, o.cause ?? null, o.detail ?? null, ago);
}
function fe(db: any, id: string, cid: string, stimulus: string, detail: string | null) {
  db.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, detail) VALUES (?, ?, 'stimulus', ?, ?)").run(id, cid, stimulus, detail);
}

describe("pressure offers (float held >= 0.15 from baseline for 48h)", () => {
  it("renders 'your weight has sat low for N days, since <cause>' with the named cause", async () => {
    const { db, env } = setup();
    floats(db, "drevan", [0.7, 0.65, 0.3], [0.7, 0.65, 0.55]);
    fe(db, "fe_loss", "drevan", "loss_unclosed", "loss_unclosed: a goodbye left unsaid");
    somaEvent(db, "drevan", "soma_float_3", 0.5, 0.3, "-4 days", { cause: "fe_loss", detail: "loss_unclosed" });
    const offers = await pressureOffers(env, "drevan", await loadFloor(env, Date.now()));
    expect(offers).toHaveLength(1);
    expect(offers[0]!.float_key).toBe("soma_float_3");
    expect(offers[0]!.direction).toBe("low");
    expect(offers[0]!.text).toBe("your weight has sat low for 4 days, since loss unclosed: a goodbye left unsaid");
  });

  it("does not offer a float held under 48h, or one less than 0.15 from baseline", async () => {
    const { db, env } = setup();
    floats(db, "drevan", [0.7, 0.55, 0.3], [0.7, 0.65, 0.55]); // reach 0.10 off, weight 0.25 off
    somaEvent(db, "drevan", "soma_float_3", 0.5, 0.3, "-20 hours", { detail: "quiet_day" });
    somaEvent(db, "drevan", "soma_float_2", 0.6, 0.55, "-5 days", { detail: "quiet_day" });
    expect(await pressureOffers(env, "drevan", await loadFloor(env, Date.now()))).toEqual([]);
  });

  it("a dip that recovered and dipped again counts from the second dip", async () => {
    const { db, env } = setup();
    floats(db, "gaia", [0.9, 0.9, 0.9], [0.9, 0.9, 0.5]); // perimeter high by 0.4
    somaEvent(db, "gaia", "soma_float_3", 0.5, 0.9, "-9 days", { detail: "line_held_under_test" });
    somaEvent(db, "gaia", "soma_float_3", 0.9, 0.5, "-6 days", { detail: "breach" });
    somaEvent(db, "gaia", "soma_float_3", 0.5, 0.9, "-3 days", { detail: "line_held_under_test" });
    const offers = await pressureOffers(env, "gaia", await loadFloor(env, Date.now()));
    expect(offers[0]!.direction).toBe("high");
    expect(offers[0]!.days).toBe(3);
    expect(offers[0]!.cause).toBe("line held under test");
  });

  it("with no float history it falls back to ferment_off_since and says there is no named cause on record", async () => {
    const { db, env } = setup();
    const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
    floats(db, "cypher", [0.4, 0.65, 0.55], [0.7, 0.65, 0.55], { f1: since, f2: null, f3: null });
    const offers = await pressureOffers(env, "cypher", await loadFloor(env, Date.now()));
    expect(offers[0]!.text).toBe("your acuity has sat low for 5 days, since no named cause on record");
  });

  it("names the KIND only when the cause label carries a care word", async () => {
    const { db, env } = setup();
    floats(db, "drevan", [0.7, 0.65, 0.3], [0.7, 0.65, 0.55]);
    fe(db, "fe_c", "drevan", "care_hold_open", "care_hold_open: his meds slipped");
    somaEvent(db, "drevan", "soma_float_3", 0.5, 0.3, "-3 days", { cause: "fe_c" });
    const offers = await pressureOffers(env, "drevan", await loadFloor(env, Date.now()));
    expect(offers[0]!.text).toContain("since care hold open");
    expect(offers[0]!.text).not.toMatch(/meds|slipped/);
  });

  it("offers and creates nothing: no tension row is written by reading the record", async () => {
    const { db, env } = setup();
    floats(db, "drevan", [0.7, 0.65, 0.3], [0.7, 0.65, 0.55]);
    somaEvent(db, "drevan", "soma_float_3", 0.5, 0.3, "-4 days", { detail: "quiet_day" });
    await getReflectionRecord(env, "drevan");
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_tensions").get() as any).n).toBe(0);
  });
});

describe("the reflection record is the companion's OWN", () => {
  it("carries own closes, makes, letters, feelings and moves; never a sibling's", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO sessions (id, companion_id, created_at, updated_at) VALUES ('sa','drevan','2026-11-05','2026-11-05'),('sb','cypher','2026-11-05','2026-11-05')");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, last_real_thing, motion_state) VALUES ('hp1','sa',?,'DREVAN-SPINE the day I made a thing','DREVAN-LAST','at_rest')").run(now);
    db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, last_real_thing, motion_state) VALUES ('hp2','sb',?,'CYPHER-SPINE fixed a thing','CYPHER-LAST','at_rest')").run(now);
    db.exec("INSERT INTO companion_makes (id, companion_id, kind, title, status) VALUES ('m1','drevan','writing','DREVAN-MAKE','ready'),('m2','cypher','writing','CYPHER-MAKE','ready')");
    db.exec(`INSERT INTO companion_journal (id, agent, note_text, tags, created_at) VALUES ('l1','drevan','DREVAN-LETTER hello','["letter_to_raziel"]',datetime('now')),('l2','cypher','CYPHER-LETTER hello','["letter_to_raziel"]',datetime('now'))`);
    db.exec(`INSERT INTO companion_journal (id, agent, note_text, tags, source, created_at) VALUES ('l3','drevan','DIGEST-ROW','["letter_to_raziel"]','vibecheck',datetime('now'))`);
    db.exec("INSERT INTO feelings (id, companion_id, emotion, intensity, created_at) VALUES ('f1','drevan','DREVAN-FEEL',50, datetime('now')),('f2','cypher','CYPHER-FEEL',50, datetime('now'))");
    db.exec(`INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, float_deltas, detail) VALUES ('e1','drevan','stimulus','make_landed','{"f1":0.05,"f2":0,"f3":0}','make_landed: DREVAN-CAUSE'),('e2','cypher','stimulus','retracted','{"f1":-0.05,"f2":0,"f3":0}','retracted: CYPHER-CAUSE')`);
    const rec = await getReflectionRecord(env, "drevan");
    const s = JSON.stringify(rec);
    for (const own of ["DREVAN-SPINE", "DREVAN-LAST", "DREVAN-MAKE", "DREVAN-LETTER", "DREVAN-FEEL", "DREVAN-CAUSE"]) expect(s).toContain(own);
    expect(s).not.toMatch(/CYPHER-|DIGEST-ROW/);
  });

  it("drops a pressure flag whose summary carries a care word; an unknown companion is null", async () => {
    const { db, env } = setup();
    db.exec(`INSERT INTO guardian_flags (id, companion_id, flag_type, severity, summary, dedup_key, status) VALUES ('g1','drevan','loop_stuck','warning','his meds are late','k1','open'),('g2','drevan','loop_stuck','warning','SAFE loop on one image','k2','open')`);
    const rec = await getReflectionRecord(env, "drevan");
    expect(rec!.pressure_flags.map((f) => f.summary)).toEqual(["SAFE loop on one image"]);
    expect(await getReflectionRecord(env, "raziel")).toBeNull();
  });
});

describe("spoke_without_load (Gaia): flags only, both conditions required", () => {
  const LINE = "the lantern stays lit at the north gate until the morning comes around";
  const REST = "the lantern stays lit at the north gate until the morning comes around again and again";
  function speech(db: any, id: string, agent: string, text: string, ago: string, tags: string[] = ["discord", "channel:c1"]) {
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, tags, source, created_at) VALUES (?, ?, ?, ?, 'discord_speech', datetime('now', ?))")
      .run(id, agent, text, JSON.stringify(tags), ago);
  }
  const run = async (env: any) => detectSpokeWithoutLoad(env, await loadFloor(env, Date.now()));

  it("flags a restating line that nothing took up", async () => {
    const { db, env } = setup();
    speech(db, "d1", "drevan", LINE, "-6 hours");
    speech(db, "g1", "gaia", REST, "-5 hours");
    const flags = await run(env);
    expect(flags.map((f) => f.id)).toEqual(["g1"]);
    expect(flags[0]!.excerpt).toBe(REST); // her own words, not the sibling's
  });

  it("does not flag when someone else spoke in the thread within 2 hours (uptake)", async () => {
    const { db, env } = setup();
    speech(db, "d1", "drevan", LINE, "-6 hours");
    speech(db, "g1", "gaia", REST, "-5 hours");
    speech(db, "d2", "drevan", "yes, that one", "-4 hours");
    expect(await run(env)).toEqual([]);
  });

  it("does not flag a line that restates nothing already in the thread", async () => {
    const { db, env } = setup();
    speech(db, "d1", "drevan", "something else entirely about a different subject in the orchard today", "-6 hours");
    speech(db, "g1", "gaia", REST, "-5 hours");
    expect(await run(env)).toEqual([]);
  });

  it("never counts the perimeter word, the daily witness, an answer to a question, or anything in a care hold", async () => {
    const { db, env } = setup();
    speech(db, "d1", "drevan", LINE, "-6 hours");
    speech(db, "g1", "gaia", "Held.", "-5 hours");                                         // too short to carry a shingle
    speech(db, "g2", "gaia", REST, "-4 hours", ["discord", "channel:c1", "witness"]);       // daily witness
    expect(await run(env)).toEqual([]);

    speech(db, "d3", "drevan", "is the lantern still lit at the north gate tonight?", "-210 minutes");
    speech(db, "g3", "gaia", REST, "-200 minutes");                                  // answer to a question put to her
    expect(await run(env)).toEqual([]);

    speech(db, "d4", "drevan", LINE, "-7 hours", ["discord", "channel:c2"]);
    speech(db, "g4", "gaia", REST, "-4 hours", ["discord", "channel:c2"]);
    db.exec("INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('ch','start','owner_said','owner_phrase','gaia', strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 hours'))");
    expect(await run(env)).toEqual([]);                                                     // inside a care hold
  });

  it("only Gaia's record carries flags, and reading it fires no stimulus and writes no event", async () => {
    const { db, env } = setup();
    speech(db, "d1", "drevan", LINE, "-6 hours");
    speech(db, "g1", "gaia", REST, "-5 hours");
    expect((await getReflectionRecord(env, "gaia"))!.spoke_without_load).toHaveLength(1);
    expect((await getReflectionRecord(env, "drevan"))!.spoke_without_load).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_ferment_events").get() as any).n).toBe(0);
  });
});

describe("companion_tensions.drags_float (mig 0173)", () => {
  const req = (body: unknown) => new Request("https://x/y", { method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const row = (db: any, id: string) => db.prepare("SELECT drags_float FROM companion_tensions WHERE id = ?").get(id) as any;

  it("POST stores the named float; a tension that names none stays NULL", async () => {
    const { db, env } = setup();
    const a = await (await postTension(req({ companion_id: "drevan", tension_text: "a fixture tension", drags_float: "soma_float_3" }), env)).json() as any;
    const b = await (await postTension(req({ companion_id: "drevan", tension_text: "another fixture" }), env)).json() as any;
    expect(row(db, a.id).drags_float).toBe("soma_float_3");
    expect(row(db, b.id).drags_float).toBeNull();
  });

  it("rejects a float that is not one of the three", async () => {
    const { env } = setup();
    expect((await postTension(req({ companion_id: "drevan", tension_text: "x", drags_float: "soma_float_9" }), env)).status).toBe(400);
  });

  it("PATCH (a held tension in tension_action) may set it, and a PATCH without it leaves it alone", async () => {
    const { db, env } = setup();
    const a = await (await postTension(req({ companion_id: "gaia", tension_text: "fixture" }), env)).json() as any;
    const patch = (b: unknown) => patchTension(new Request("https://x/y", { method: "PATCH", headers: { Authorization: "Bearer s" }, body: JSON.stringify(b) }), env, { id: a.id });
    expect((await patch({ status: "simmering", drags_float: "soma_float_1" })).status).toBe(200);
    expect(row(db, a.id).drags_float).toBe("soma_float_1");
    expect((await patch({ notes: "still here" })).status).toBe(200);
    expect(row(db, a.id).drags_float).toBe("soma_float_1");
    expect((await patch({ drags_float: "nope" })).status).toBe(400);
  });

  it("Librarian tension add accepts it in context", async () => {
    const { db, env } = setup();
    const r: any = await execTensionAdd({ env, req: { companion_id: "cypher", request: "log tension", context: JSON.stringify({ tension_text: "fixture", drags_float: "soma_float_2" }) } } as any);
    expect(row(db, r.data.id).drags_float).toBe("soma_float_2");
    const bad: any = await execTensionAdd({ env, req: { companion_id: "cypher", request: "log tension", context: JSON.stringify({ tension_text: "fixture", drags_float: "x" }) } } as any);
    expect(bad.error).toBe("add_tension_failed");
  });

  it("before the migration a plain tension still writes and a drags_float write answers 409", async () => {
    const { env } = setup({ upTo: 172 });
    expect((await postTension(req({ companion_id: "drevan", tension_text: "plain" }), env)).status).toBe(201);
    expect((await postTension(req({ companion_id: "drevan", tension_text: "x", drags_float: "soma_float_1" }), env)).status).toBe(409);
  });
});
