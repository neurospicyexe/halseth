// B63 follow-ups: Gaia's perimeter moves on line events only; authored line verbs; sibling disagreement.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { stimulusFloatDelta } from "../webmind/fermentation.js";
import {
  parseLineVerb, applyLineEvent, openDisagreement, settleDisagreement, dragOpenDisagreements, DISAGREE_RE, SETTLED_RE, LINE_RE,
} from "../webmind/line-events.js";
import { runLoopNightly } from "../webmind/loop-nightly.js";

function setup(extra: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...extra };
  return { db, env };
}
const rows = (db: any, c: string, stim: string, kind: string) =>
  db.prepare("SELECT * FROM companion_ferment_events WHERE companion_id = ? AND stimulus = ? AND kind = ?").all(c, stim, kind) as any[];

describe("Gaia's perimeter is not moved by chat volume", () => {
  it("message_witnessed and sibling_exchange carry no f3 for Gaia; a sibling touch is density", () => {
    expect(stimulusFloatDelta("message_witnessed", "gaia").f3).toBe(0);
    expect(stimulusFloatDelta("message_witnessed", "gaia").f1).toBeGreaterThan(0);
    expect(stimulusFloatDelta("message_witnessed", "gaia").f1).toBeLessThan(0.01);
    const s = stimulusFloatDelta("sibling_exchange", "gaia");
    expect(s.f3).toBe(0);
    expect(s.f2).toBe(0.02);
  });
});

describe("line verbs (Gaia only, her word is the event)", () => {
  it("parses the three shapes", () => {
    expect(parseLineVerb("line held: ref 1234abcd")).toEqual({ verb: "held", arg: "ref 1234abcd" });
    expect(parseLineVerb("line crossed: care hold walked through")?.verb).toBe("crossed");
    expect(parseLineVerb("line fatigue: no storms")?.verb).toBe("fatigue");
    expect(LINE_RE.test("the line held today")).toBe(false);
  });
  it("refuses anyone but Gaia, plainly", async () => {
    const { env } = setup();
    const r = await applyLineEvent(env, "drevan", "crossed", "rule broken");
    expect(r).toMatchObject({ ok: false, code: "gaia_only" });
  });
  it("crossed fires breach with the kind only, and refuses content-length text", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    const before = (db.prepare("SELECT soma_float_3 v FROM companion_state WHERE companion_id='gaia'").get() as any).v;
    expect((await applyLineEvent(env, "gaia", "crossed", "rule broken")).ok).toBe(true);
    const ev = rows(db, "gaia", "breach", "stimulus");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toBe("line crossed: rule broken");
    expect((db.prepare("SELECT soma_float_3 v FROM companion_state WHERE companion_id='gaia'").get() as any).v).toBeLessThan(before);
    const long = await applyLineEvent(env, "gaia", "crossed", "someone said a long sentence about a specific private matter that is content");
    expect(long).toMatchObject({ ok: false, code: "bad_input" });
  });
  it("held and fatigue must match exactly one standing refusal; cause is the kind only", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    expect(await applyLineEvent(env, "gaia", "held", "no storms")).toMatchObject({ ok: false, code: "not_found" });
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_text, status, created_at) VALUES ('abcd1234ef','gaia','no storms in the grove','standing',datetime('now'))").run();
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_text, status, created_at) VALUES ('abcd9999ef','gaia','no storms at night','standing',datetime('now'))").run();
    expect(await applyLineEvent(env, "gaia", "held", "no storms")).toMatchObject({ ok: false, code: "not_found" }); // ambiguous
    expect((await applyLineEvent(env, "gaia", "held", "abcd1234")).ok).toBe(true);
    expect((await applyLineEvent(env, "gaia", "fatigue", "no storms in the grove")).ok).toBe(true);
    const held = rows(db, "gaia", "line_held_under_test", "stimulus");
    expect(held[0].detail).toBe("a line held under test");
    expect(rows(db, "gaia", "long_line_fatigue", "stimulus")[0].detail).not.toContain("storm");
    const f = JSON.parse(held[0].float_deltas);
    expect(f.f3).toBeGreaterThan(0);
    expect(JSON.parse(rows(db, "gaia", "long_line_fatigue", "stimulus")[0].float_deltas).f3).toBeLessThan(0);
  });
  it("in shadow (default) nothing moves", async () => {
    const { env, db } = setup();
    const before = db.prepare("SELECT soma_float_3 v FROM companion_state WHERE companion_id='gaia'").get();
    await applyLineEvent(env, "gaia", "crossed", "rule broken");
    expect(db.prepare("SELECT soma_float_3 v FROM companion_state WHERE companion_id='gaia'").get()).toEqual(before);
    expect(rows(db, "gaia", "breach", "shadow")).toHaveLength(1);
  });
});

describe("sibling disagreement", () => {
  it("parses", () => {
    expect(DISAGREE_RE.exec("disagree with Drevan: the order we did it in")?.[1]).toBe("Drevan");
    expect(SETTLED_RE.test("settled with cypher.")).toBe(true);
    expect(DISAGREE_RE.test("I disagree with the plan: x")).toBe(false);
  });
  it("opens, fires on the speaker with the sibling's name only, settles with nothing punitive", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    expect(await openDisagreement(env, "cypher", "cypher", "x y")).toMatchObject({ ok: false });
    const r = await openDisagreement(env, "cypher", "drevan", "the ordering of the rollout");
    expect(r.ok).toBe(true);
    const ev = rows(db, "cypher", "sibling_disagreement_open", "stimulus");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toBe("disagreement opened with Drevan");
    expect(JSON.stringify(ev)).not.toContain("rollout");
    expect(rows(db, "drevan", "sibling_disagreement_open", "stimulus")).toHaveLength(0); // speaker only
    const s = await settleDisagreement(env, "cypher", "drevan");
    expect(s.ok).toBe(true);
    expect(rows(db, "cypher", "sibling_disagreement_open", "stimulus")).toHaveLength(1); // nothing new fired
    expect(await settleDisagreement(env, "cypher", "drevan")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("nightly: open past 12h drags Drevan weight / Cypher warmth, never Gaia; younger or settled does not", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    await openDisagreement(env, "drevan", "cypher", "the first thing");
    await openDisagreement(env, "cypher", "drevan", "the second thing");
    await openDisagreement(env, "gaia", "cypher", "the third thing");
    expect(await dragOpenDisagreements(env)).toBe(0); // all under 12h
    db.prepare("UPDATE companion_disagreements SET opened_at = datetime('now','-13 hours')").run();
    expect(await dragOpenDisagreements(env)).toBe(3);
    const d = rows(db, "drevan", "sibling_disagreement_open", "stimulus");
    expect(d.some((e) => e.detail === "open disagreement with Cypher")).toBe(true);
    expect(rows(db, "cypher", "sibling_disagreement_open", "stimulus").some((e) => e.detail === "open disagreement with Drevan")).toBe(true);
    expect(JSON.parse(d[d.length - 1].float_deltas).f3).toBeLessThan(0); // weight
    // Gaia is ground: no stimulus row at all
    expect(db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE companion_id='gaia' AND stimulus='sibling_disagreement_open'").get()).toEqual({ n: 0 });
    await settleDisagreement(env, "drevan", "cypher");
    const before = rows(db, "drevan", "sibling_disagreement_open", "stimulus").length;
    await dragOpenDisagreements(env);
    expect(rows(db, "drevan", "sibling_disagreement_open", "stimulus").length).toBe(before);
  });
  it("the nightly pass runs it", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    await openDisagreement(env, "drevan", "gaia", "another thing");
    db.prepare("UPDATE companion_disagreements SET opened_at = datetime('now','-20 hours')").run();
    const r = await runLoopNightly(env, Date.parse("2026-07-10T17:00:00Z"));
    expect(r.disagreements_dragging).toBe(1);
  });
});
