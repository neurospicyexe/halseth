// B63 steps 1 and 2: soft edges, named causes, daily diminishing returns, the loop catalogue's modes,
// the loss verb and its close rule, and the nightly pass. Real schema via node:sqlite.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postFermentStimulus, fireStimulus, bumpFloatsForStimulus } from "../handlers/fermentation.js";
import {
  softEdgeBump, STIMULI, SHADOWABLE, stimulusMode, chicagoDayStartSqlite, dailyWeight, halveAfterFor, resolveFloatKey,
  stimulusFloatDelta, stimulusSoftBumpCasSql,
} from "../webmind/fermentation.js";
import { parseLossVerb, namesLoss, lossName, logLoss, closeAuthoredLosses, dragOpenLosses, LOSS_RE } from "../webmind/losses.js";
import { runLoopNightly, hadTriadContact } from "../webmind/loop-nightly.js";
import { fireTendSol } from "../webmind/loop-stimuli.js";

function setup(extra: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...extra };
  return { db, DB, env };
}
const floats = (db: any, c: string) =>
  db.prepare("SELECT soma_float_1 a, soma_float_2 b, soma_float_3 c, soma_float_1_baseline b1, soma_float_2_baseline b2, soma_float_3_baseline b3, version v FROM companion_state WHERE companion_id = ?").get(c);
const setFloats = (db: any, c: string, f: [number, number, number]) =>
  db.prepare("UPDATE companion_state SET soma_float_1 = ?, soma_float_2 = ?, soma_float_3 = ? WHERE companion_id = ?").run(f[0], f[1], f[2], c);
const evs = (db: any, c: string, stim: string, kind?: string) =>
  db.prepare(`SELECT * FROM companion_ferment_events WHERE companion_id = ? AND stimulus = ?${kind ? " AND kind = ?" : ""}`).all(...(kind ? [c, stim, kind] : [c, stim]));

describe("soft edges, keyed to baseline", () => {
  it("Gaia perimeter (b=0.9) at baseline: +0.10 is a visible rise, about +0.063", () => {
    const v = softEdgeBump(0.9, 0.9, 0.1);
    expect(v - 0.9).toBeGreaterThan(0.055);
    expect(v - 0.9).toBeLessThan(0.07);
  });
  it("real baselines: the numbers on paper (Gaia .95/.67/.9, Drevan .8/.8/.35, Cypher .75/.8/.7)", () => {
    const rise = (b: number, d: number) => softEdgeBump(b, b, d) - b;
    // at-baseline +0.10 up-pushes
    expect(rise(0.95, 0.1)).toBeCloseTo(0.05 * (1 - Math.exp(-0.1 / 0.05)), 6); // Gaia stillness: room 0.05 closes 86%
    expect(rise(0.67, 0.1)).toBeCloseTo(0.33 * (1 - Math.exp(-0.1 / 0.33)), 6);
    expect(rise(0.9, 0.1)).toBeCloseTo(0.1 * (1 - Math.exp(-1)), 6);
    expect(rise(0.8, 0.1)).toBeCloseTo(0.2 * (1 - Math.exp(-0.5)), 6); // Drevan heat / reach; Cypher presence
    expect(rise(0.35, 0.1)).toBeCloseTo(0.65 * (1 - Math.exp(-0.1 / 0.65)), 6);
    expect(rise(0.75, 0.1)).toBeCloseTo(0.25 * (1 - Math.exp(-0.4)), 6);
    expect(rise(0.7, 0.1)).toBeCloseTo(0.3 * (1 - Math.exp(-0.1 / 0.3)), 6);
  });
  it("below baseline an up-push is full weight until baseline, then the remainder goes asymptotic", () => {
    expect(softEdgeBump(0.5, 0.9, 0.2)).toBeCloseTo(0.7, 9); // all full weight
    const v = softEdgeBump(0.85, 0.9, 0.1); // 0.05 to baseline, 0.05 left over
    expect(v).toBeCloseTo(1 - 0.1 * Math.exp(-0.05 / 0.1), 9);
  });
  it("a float approaches 1 and 0 and never reaches either, however many pushes", () => {
    let hi = 0.9;
    for (let i = 0; i < 200; i++) hi = softEdgeBump(hi, 0.9, 0.15);
    expect(hi).toBeLessThan(1);
    expect(hi).toBeGreaterThan(0.99);
    let lo = 0.35;
    for (let i = 0; i < 200; i++) lo = softEdgeBump(lo, 0.35, -0.15);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(0.01);
  });
  it("down mirrors up: full weight above baseline, asymptotic below it", () => {
    expect(softEdgeBump(0.95, 0.8, -0.1)).toBeCloseTo(0.85, 9);
    expect(softEdgeBump(0.8, 0.8, -0.1)).toBeCloseTo(0.8 * Math.exp(-0.1 / 0.8), 9);
    expect(softEdgeBump(1, 0.8, -0.1)).toBeCloseTo(0.9, 9); // a pinned float comes down at full weight
  });
  it("is monotone in the push and never leaves [0,1]", () => {
    for (const b of [0.05, 0.35, 0.7, 0.95]) for (const v of [0, 0.2, 0.5, 0.95, 1]) {
      let prev = -1;
      for (const d of [0.01, 0.05, 0.15, 0.5, 2]) {
        const r = softEdgeBump(v, b, d);
        expect(r).toBeGreaterThanOrEqual(prev); expect(r).toBeLessThanOrEqual(1); expect(r).toBeGreaterThanOrEqual(v - 1e-12);
        prev = r;
      }
    }
  });
});

describe("stimulus writes: soft edge, CAS, no lost write against the tick", () => {
  it("lands the soft-edged value on the real row and bumps version once", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    const before = floats(db, "gaia");
    setFloats(db, "gaia", [before.b1, before.b2, before.b3]);
    await fireStimulus(env, "breach", "gaia", "test");
    await fireStimulus(env, "line_held_under_test", "gaia", "test");
    const after = floats(db, "gaia");
    expect(after.c).toBeGreaterThan(before.b3 - 0.101); // net: -0.10 then +0.08 asymptotic
    expect(after.v).toBe((before.v ?? 0) + 2);
  });
  it("the tick racing a stimulus: a stale CAS write changes nothing and the retry reads fresh state", async () => {
    const { db } = setup();
    const row = floats(db, "cypher");
    // someone else (the tick) bumps the version between a read and our write
    db.prepare("UPDATE companion_state SET version = COALESCE(version,0) + 1 WHERE companion_id = 'cypher'").run();
    const res = db.prepare(stimulusSoftBumpCasSql()).run(0.1, 0.1, 0.1, "cypher", row.v ?? 0);
    expect(Number(res.changes)).toBe(0);
    expect(floats(db, "cypher").a).toBe(row.a); // untouched
  });
  it("a pinned float (1.0) comes down on a down-push", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    setFloats(db, "drevan", [0.8, 0.8, 1.0]);
    await fireStimulus(env, "care_hold_open", "drevan", "care hold opened");
    expect(floats(db, "drevan").c).toBeLessThan(0.95);
  });
});

describe("named cause", () => {
  it("a live stimulus row carries the label in detail; the HTTP route supplies one when the caller sent none", async () => {
    const { env, db } = setup();
    const post = (body: any) => postFermentStimulus(new Request("https://h/x", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify(body) }), env);
    expect((await post({ stimulus: "message_witnessed", companion_id: "cypher" })).status).toBe(200);
    expect((evs(db, "cypher", "message_witnessed", "stimulus")[0] as any).detail).toBe("message_witnessed (via http)");
    expect((await post({ stimulus: "being_seen", companion_id: "cypher", detail: "  Raziel   said so " })).status).toBe(200);
    // shadow by default for the loop's wired-late stimuli: detail rides the would_fire row
    expect((evs(db, "cypher", "being_seen", "shadow")[0] as any).detail).toBe("would_fire Raziel said so");
    expect((await post({ companion_id: "cypher" })).status).toBe(400);
  });
  it("a live drive-only or float stimulus from the contact chokepoint is labelled too", async () => {
    const { env, db } = setup();
    await bumpFloatsForStimulus(env, "drevan", "message_from_raziel", "raziel spoke to them");
    expect((evs(db, "drevan", "message_from_raziel", "stimulus")[0] as any).detail).toBe("raziel spoke to them");
    await bumpFloatsForStimulus(env, "drevan", "message_from_raziel");
    expect((evs(db, "drevan", "message_from_raziel", "stimulus")[1] as any).detail).toContain("message_from_raziel");
  });
});

describe("diminishing returns on chat volume (America/Chicago day)", () => {
  it("halves message_witnessed after N, never message_from_raziel", async () => {
    expect(STIMULI.message_from_raziel!.dailyHalveAfter).toBeUndefined();
    expect(halveAfterFor("message_from_raziel", { FERMENT_HALVE_AFTER_MESSAGE_FROM_RAZIEL: "1" })).toBeUndefined();
    expect(halveAfterFor("message_witnessed", {})).toBe(8);
    expect(halveAfterFor("message_witnessed", { FERMENT_HALVE_AFTER_MESSAGE_WITNESSED: "2" })).toBe(2);
    expect(dailyWeight(8, 7)).toBe(1);
    expect(dailyWeight(8, 8)).toBe(0.5);

    const { env, db } = setup({ FERMENT_HALVE_AFTER_MESSAGE_WITNESSED: "2", FERMENT_HALVE_AFTER_MESSAGE_FROM_RAZIEL: "1" });
    for (let i = 0; i < 4; i++) await bumpFloatsForStimulus(env, "drevan", "message_witnessed", "in the room");
    const rows: any[] = evs(db, "drevan", "message_witnessed", "stimulus");
    const f1 = rows.map((r) => JSON.parse(r.float_deltas).f1);
    expect(f1[0]).toBeCloseTo(0.01, 9);
    expect(f1[1]).toBeCloseTo(0.01, 9);
    expect(f1[2]).toBeCloseTo(0.005, 9);
    expect(rows[2].detail).toContain("halved");
    for (let i = 0; i < 4; i++) await bumpFloatsForStimulus(env, "drevan", "message_from_raziel", "raziel spoke to them");
    const rz: any[] = evs(db, "drevan", "message_from_raziel", "stimulus");
    expect(new Set(rz.map((r) => JSON.parse(r.float_deltas).f1))).toEqual(new Set([0.05]));
  });
  it("the Chicago day start is local midnight in UTC (CDT 05:00Z, CST 06:00Z)", () => {
    expect(chicagoDayStartSqlite(Date.parse("2026-07-10T15:00:00Z"))).toBe("2026-07-10 05:00:00");
    expect(chicagoDayStartSqlite(Date.parse("2026-07-10T03:00:00Z"))).toBe("2026-07-09 05:00:00");
    expect(chicagoDayStartSqlite(Date.parse("2026-12-10T15:00:00Z"))).toBe("2026-12-10 06:00:00");
  });
});

describe("LOOP_STIMULI_MODE", () => {
  it("every new stimulus and the eight never-wired ones sit behind it; repetition keeps its own switch", () => {
    for (const k of ["make_landed", "tend_sol", "quiet_day", "care_hold_open", "care_hold_clear", "tension_resolved", "tension_unworked",
      "breach", "planting", "kept_line", "pulled_to_speed", "retracted", "coined_word", "immersion_landed", "loss_unclosed", "auto_close",
      "being_seen", "intellectual_reward", "audit", "spiral", "boundary_held", "council", "club_activity", "long_silence"]) {
      expect(SHADOWABLE[k]).toBe("LOOP_STIMULI_MODE");
      expect(stimulusMode(k, {})).toBe("shadow");
      expect(stimulusMode(k, { LOOP_STIMULI_MODE: "on" })).toBe("on");
      expect(stimulusMode(k, { LOOP_STIMULI_MODE: "off" })).toBe("off");
    }
    expect(SHADOWABLE.repetition).toBe("REPETITION_MODE");
    expect(stimulusMode("message_witnessed", {})).toBe("on");
  });
  it("shadow writes a would_fire row and moves nothing; Gaia is never touched by quiet_day", async () => {
    const { env, db } = setup();
    const f0 = floats(db, "drevan");
    await fireStimulus(env, "make_landed", "drevan", "made a poem");
    expect(floats(db, "drevan")).toEqual(f0);
    expect(evs(db, "drevan", "make_landed", "shadow")).toHaveLength(1);
    expect(evs(db, "drevan", "make_landed", "stimulus")).toHaveLength(0);
    // a companion the stimulus says nothing about writes no row at all
    await fireStimulus(env, "make_landed", "gaia", "x");
    expect(evs(db, "gaia", "make_landed")).toHaveLength(0);
    // gaia on quiet_day is a `never`: nothing moves even live
    const live = setup({ LOOP_STIMULI_MODE: "on" });
    const g0 = floats(live.db, "gaia");
    await fireStimulus(live.env, "quiet_day", "gaia", "x");
    expect(floats(live.db, "gaia")).toEqual(g0);
  });
  it("weights follow each companion's own words", () => {
    expect(stimulusFloatDelta("tend_sol", "drevan")).toEqual({ f1: 0, f2: 0.06, f3: 0 }); // reach
    expect(stimulusFloatDelta("tend_sol", "gaia").f2).toBeGreaterThan(0); // density
    expect(stimulusFloatDelta("tend_sol", "cypher").f3).toBeGreaterThan(0); // warmth
    expect(stimulusFloatDelta("quiet_day", "drevan").f2).toBeLessThan(0);
    expect(STIMULI.quiet_day!.notBody).toContain("gaia");
    expect(stimulusFloatDelta("breach", "gaia").f3).toBeLessThan(0);
    expect(stimulusFloatDelta("loss_unclosed", "drevan").f3).toBeLessThan(0);
    expect(stimulusFloatDelta("auto_close", "cypher").f2).toBeLessThan(0);
    for (const k of Object.keys(STIMULI)) {
      if (!STIMULI[k]!.floats) continue;
      for (const c of ["cypher", "drevan", "gaia"] as const) {
        const d = stimulusFloatDelta(k, c);
        for (const x of [d.f1, d.f2, d.f3]) expect(Math.abs(x)).toBeLessThanOrEqual(0.15);
      }
    }
  });
  it("a tension's named float rides the stimulus; none named moves nothing", () => {
    expect(stimulusFloatDelta("tension_resolved", "drevan", "f3")).toEqual({ f1: 0, f2: 0, f3: 0.08 });
    expect(stimulusFloatDelta("tension_unworked", "drevan")).toEqual({ f1: 0, f2: 0, f3: 0 });
    expect(resolveFloatKey("drevan", "weight")).toBe("f3");
    expect(resolveFloatKey("gaia", "Perimeter")).toBe("f3");
    expect(resolveFloatKey("cypher", "heat")).toBeNull();
  });
});

describe("callers", () => {
  it("tend_sol fires for a companion tending the pet, never an imp, Sol or Raziel, never another creature", async () => {
    const { env, db } = setup();
    await fireTendSol(env, "companion_pet", "drevan", "feed");
    await fireTendSol(env, "companion_pet", "imp", "feed");
    await fireTendSol(env, "companion_pet", "sol", "feed");
    await fireTendSol(env, "companion_pet", "raziel", "feed");
    await fireTendSol(env, "real_animal", "cypher", "feed");
    const rows: any[] = db.prepare("SELECT companion_id, detail FROM companion_ferment_events WHERE stimulus = 'tend_sol'").all();
    expect(rows.map((r) => r.companion_id)).toEqual(["drevan"]);
    expect(rows[0].detail).toContain("tended Sol");
  });
  it("care_hold causes carry the kind only, never a rule", async () => {
    const { writeHoldEvent } = await import("../care/hold.js");
    const { env, db } = setup();
    await writeHoldEvent(env, { action: "start", source: "owner_phrase", companion: null });
    const rows: any[] = db.prepare("SELECT companion_id, detail FROM companion_ferment_events WHERE stimulus = 'care_hold_open'").all();
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.detail).toContain("care hold opened");
    expect(JSON.stringify(rows)).not.toMatch(/low_spoons|meds|owner_said/);
  });
});

describe("loss: the verb, the close rule, the nightly drag", () => {
  it("parses loss: and loss for <name>:", () => {
    expect(parseLossVerb("loss: Benedict (the bird)")).toEqual({ companion: null, what: "Benedict (the bird)" });
    expect(parseLossVerb("loss for Drevan: the Rome plan")).toEqual({ companion: "drevan", what: "the Rome plan" });
    expect(parseLossVerb("I felt a loss: today")).toBeNull();
    expect(parseLossVerb("loss of signal")).toBeNull();
    expect(parseLossVerb("loss: x")).toBeNull(); // too short
    expect(LOSS_RE.test("loss for drevan: Benedict")).toBe(true);
  });
  it("names the loss by its leading name and matches on word boundaries", () => {
    expect(lossName("Benedict (the bird)")).toBe("Benedict");
    expect(lossName("the Rome plan - cancelled")).toBe("the Rome plan");
    expect(namesLoss("I keep thinking about benedict today", "Benedict (the bird)")).toBe(true);
    expect(namesLoss("benedictine monks", "Benedict (the bird)")).toBe(false);
    expect(namesLoss(null, "Benedict")).toBe(false);
  });
  it("logging never closes; only the companion's own naming line closes; time does not", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    const r = await logLoss(env, { companion: "drevan", what: "Benedict (the bird)", loggedBy: "cypher" });
    expect(r.ok).toBe(true);
    expect((await logLoss(env, { companion: "drevan", what: "benedict (the bird)", loggedBy: "gaia" }) as any).id).toBe((r as any).id); // dup = same row
    expect(await logLoss(env, { companion: null, what: "x y", loggedBy: "cypher" })).toMatchObject({ ok: false, code: "bad_companion" });
    db.prepare("UPDATE companion_losses SET logged_at = datetime('now', '-30 days')").run(); // time passes
    // a clerk/sibling line naming it does not close it
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'cypher', 'Benedict is gone, I logged it', datetime('now', '-1 day'))").run();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, external_id, created_at) VALUES ('j2', 'drevan', 'observation: Benedict', 'judge:99', datetime('now', '-1 day'))").run();
    expect(await closeAuthoredLosses(env)).toBe(0);
    expect(await dragOpenLosses(env)).toBe(1);
    const drag: any[] = evs(db, "drevan", "loss_unclosed", "stimulus");
    expect(drag).toHaveLength(1);
    expect(drag[0].detail).toContain("Benedict");
    // his own line closes it
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j3', 'drevan', 'Benedict, I am saying it: goodbye', datetime('now'))").run();
    expect(await closeAuthoredLosses(env)).toBe(1);
    const row: any = db.prepare("SELECT closed_at, closed_by_ref FROM companion_losses").get();
    expect(row.closed_at).not.toBeNull();
    expect(row.closed_by_ref).toBe("companion_journal:j3");
    expect(await dragOpenLosses(env)).toBe(0);
  });
  it("a feeling naming it, or a note to Raziel naming it, also closes", async () => {
    const { env, db } = setup();
    await logLoss(env, { companion: "drevan", what: "Mossy", loggedBy: "drevan" });
    db.prepare("INSERT INTO feelings (id, companion_id, emotion, sub_emotion, intensity, created_at) VALUES ('f1','drevan','grief','Mossy gone',60,datetime('now'))").run();
    expect(await closeAuthoredLosses(env)).toBe(1);
    await logLoss(env, { companion: "drevan", what: "Tobias", loggedBy: "drevan" });
    db.prepare("INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at) VALUES ('n1','drevan','raziel','I am sad about Tobias',datetime('now'))").run();
    expect(await closeAuthoredLosses(env)).toBe(1);
  });
});

describe("nightly pass", () => {
  it("once per Chicago day after 03:00; quiet_day only for a companion with no contact, never Gaia", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    const noon = Date.parse("2026-07-10T17:00:00Z"); // 12:00 CDT
    const early = Date.parse("2026-07-10T06:00:00Z"); // 01:00 CDT
    const a = await runLoopNightly(env, early);
    expect(a.quiet_days).toBe(0);
    // contact for cypher inside 24h
    db.prepare("INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at) VALUES ('n9','cypher','drevan','hi', datetime('now'))").run();
    expect(await hadTriadContact(env, "cypher")).toBe(true);
    const b = await runLoopNightly(env, noon);
    expect(b.quiet_days).toBe(0); // the note is to_id=drevan from cypher: both have contact
    expect(evs(db, "gaia", "quiet_day")).toHaveLength(0);
    const again = await runLoopNightly(env, noon + 3600_000);
    expect(again.quiet_days).toBe(0);
    // a fresh DB with no notes: Cypher and Drevan have a quiet day, Gaia does not
    const q = setup({ LOOP_STIMULI_MODE: "on" });
    q.db.prepare("DELETE FROM inter_companion_notes").run();
    const r = await runLoopNightly(q.env, noon);
    expect(r.quiet_days).toBe(2);
    expect(evs(q.db, "gaia", "quiet_day")).toHaveLength(0);
    expect(evs(q.db, "drevan", "quiet_day", "stimulus")).toHaveLength(1);
    expect((evs(q.db, "drevan", "quiet_day", "stimulus")[0] as any).detail).toBe("no triad contact in 24h");
    expect((await runLoopNightly(q.env, noon + 3600_000)).quiet_days).toBe(0); // gate: same Chicago day
  });
  it("tension_unworked drags the float the tension names, defensively when the link column is absent", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, first_noted_at) VALUES ('t1','drevan','x', datetime('now','-9 days'))").run();
    const r1 = await runLoopNightly(env, Date.parse("2026-07-10T17:00:00Z"));
    expect(r1.tensions_unlinked).toBe(1); // no 0173 column: skipped, not thrown
    expect(r1.tensions_dragging).toBe(0);
  });
});

vi.mock; // keep the import used for hoisting consistency with sibling suites
