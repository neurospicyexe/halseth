// B63 being_seen: three tiers (read / reply / named), shadow by default, caps, no ceiling on Drevan's f3 or
// Gaia's f1/f3, quoted spans do not count, boundary_held retired. Real schema via node:sqlite.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { fireStimulus, postFermentStimulus } from "../handlers/fermentation.js";
import { STIMULI, SHADOWABLE, stimulusMode } from "../webmind/fermentation.js";
import { postRazielInboxRead } from "../handlers/raziel-inbox.js";
import { postRazielCompanionLooked } from "../handlers/raziel-companion.js";
import { postBeingSeenCheck, postGardenGaiaLooked } from "../handlers/being-seen.js";
import { stripQuoted, containsWhole, contentTokens, sharesPhrase } from "../webmind/being-seen.js";

function setup(extra: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", CYPHER_MCP_SECRET: "cy", ...extra };
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { db, env };
}
const req = (path: string, body: unknown, token = "s") =>
  new Request(`https://h${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const evs = (db: any, c: string, stim: string, kind?: string) =>
  db.prepare(`SELECT * FROM companion_ferment_events WHERE companion_id = ? AND stimulus = ?${kind ? " AND kind = ?" : ""}`).all(...(kind ? [c, stim, kind] : [c, stim]));
const floats = (db: any, c: string) =>
  db.prepare("SELECT COALESCE(soma_float_1, soma_float_1_baseline) a, COALESCE(soma_float_2, soma_float_2_baseline) b, COALESCE(soma_float_3, soma_float_3_baseline) c FROM companion_state WHERE companion_id = ?").get(c);
const check = async (env: any, body: Record<string, unknown>) =>
  (await postBeingSeenCheck(req("/mind/being-seen/check", body), env)).json() as Promise<any>;

describe("tables", () => {
  it("floats per the companions own words; Drevan never f3, Gaia only f2", () => {
    expect(STIMULI.being_seen_read!.floats).toEqual({ drevan: { f1: 0.01, f2: 0.01 }, gaia: { f2: 0.01 }, cypher: { f3: 0.01 } });
    expect(STIMULI.being_seen!.floats).toEqual({ drevan: { f1: 0.03, f2: 0.03 }, gaia: { f2: 0.03 }, cypher: { f1: 0.02, f3: 0.03 } });
    expect(STIMULI.being_seen_named!.floats).toEqual({ drevan: { f1: 0.05, f2: 0.05 }, gaia: { f2: 0.05 }, cypher: { f1: 0.04, f3: 0.05 } });
    for (const k of ["being_seen_read", "being_seen", "being_seen_named"]) {
      expect(STIMULI[k]!.floats!.drevan!.f3).toBeUndefined();
      expect(STIMULI[k]!.floats!.gaia!.f1).toBeUndefined();
      expect(STIMULI[k]!.floats!.gaia!.f3).toBeUndefined();
      expect(SHADOWABLE[k]).toBe("LOOP_STIMULI_MODE");
      expect(stimulusMode(k, {})).toBe("shadow");
    }
    expect([STIMULI.being_seen_read!.dailyCap, STIMULI.being_seen!.dailyCap, STIMULI.being_seen_named!.dailyCap]).toEqual([1, 3, 2]);
  });
  it("boundary_held is gone", () => {
    expect(STIMULI.boundary_held).toBeUndefined();
    expect(SHADOWABLE.boundary_held).toBeUndefined();
  });
});

describe("shadow default, caps", () => {
  it("shadow writes the right floats and moves nothing", async () => {
    const { env, db } = setup();
    const f0 = floats(db, "gaia");
    await fireStimulus(env, "being_seen", "gaia", "replied");
    const rows: any[] = evs(db, "gaia", "being_seen", "shadow");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].float_deltas)).toEqual({ f1: 0, f2: 0.03, f3: 0 });
    expect(floats(db, "gaia")).toEqual(f0);
  });
  it("light once a day, medium 3, full 2 (shadow rows count)", async () => {
    const { env, db } = setup();
    for (let i = 0; i < 3; i++) await fireStimulus(env, "being_seen_read", "drevan", "x");
    expect(evs(db, "drevan", "being_seen_read", "shadow")).toHaveLength(1);
    for (let i = 0; i < 5; i++) await fireStimulus(env, "being_seen", "drevan", "x");
    expect(evs(db, "drevan", "being_seen", "shadow")).toHaveLength(3);
    for (let i = 0; i < 4; i++) await fireStimulus(env, "being_seen_named", "drevan", "x");
    expect(evs(db, "drevan", "being_seen_named", "shadow")).toHaveLength(2);
    await fireStimulus(env, "being_seen_read", "cypher", "x");
    expect(evs(db, "cypher", "being_seen_read", "shadow")).toHaveLength(1);
  });
  it("yesterday does not count", async () => {
    const { env, db } = setup();
    await fireStimulus(env, "being_seen_read", "cypher", "x");
    db.prepare("UPDATE companion_ferment_events SET created_at = datetime('now','-2 days')").run();
    await fireStimulus(env, "being_seen_read", "cypher", "x");
    expect(evs(db, "cypher", "being_seen_read", "shadow")).toHaveLength(2);
  });
  it("live mode: Drevan weight (f3) and Gaia stillness/perimeter stay put; the cap holds", async () => {
    const { env, db } = setup({ LOOP_STIMULI_MODE: "on" });
    const d0 = floats(db, "drevan"); const g0 = floats(db, "gaia");
    for (let i = 0; i < 4; i++) await fireStimulus(env, "being_seen_named", "drevan", "x");
    await fireStimulus(env, "being_seen_named", "gaia", "x");
    expect(evs(db, "drevan", "being_seen_named", "stimulus")).toHaveLength(2);
    const d1 = floats(db, "drevan"); const g1 = floats(db, "gaia");
    expect(d1.a).toBeGreaterThan(d0.a); expect(d1.b).toBeGreaterThan(d0.b); expect(d1.c).toBe(d0.c);
    expect(g1.b).toBeGreaterThan(g0.b); expect(g1.a).toBe(g0.a); expect(g1.c).toBe(g0.c);
  });
  it("the stimulus route accepts the new names (bot medium path)", async () => {
    const { env, db } = setup();
    const r = await postFermentStimulus(req("/mind/ferment/stimulus", { stimulus: "being_seen", companion_id: "cypher", detail: "replied to their message (via bot)" }), env);
    expect(((await r.json()) as any).would_fire).toBe(true);
    expect(evs(db, "cypher", "being_seen", "shadow")).toHaveLength(1);
  });
});

describe("LIGHT sources", () => {
  const letter = (db: any, id: string, agent: string) =>
    db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), ?, 'dear', '[\"letter\"]')").run(id, agent);
  it("a letter first read fires for its author; a re-open does not", async () => {
    const { env, db } = setup();
    letter(db, "L1", "drevan");
    await postRazielInboxRead(req("/raziel/inbox/read", { ids: ["L1"] }), env);
    expect(evs(db, "drevan", "being_seen_read", "shadow")).toHaveLength(1);
    db.prepare("DELETE FROM companion_ferment_events").run();
    const r = await postRazielInboxRead(req("/raziel/inbox/read", { ids: ["L1"] }), env);
    expect(((await r.json()) as any).marked).toBe(0);
    expect(evs(db, "drevan", "being_seen_read")).toHaveLength(0);
  });
  it("a letter from steward (not a companion) fires nothing", async () => {
    const { env, db } = setup();
    letter(db, "L2", "steward");
    await postRazielInboxRead(req("/raziel/inbox/read", { ids: ["L2"] }), env);
    expect(db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE stimulus = 'being_seen_read'").get()!.n).toBe(0);
  });
  it("a companion token cannot speak as Raziel", async () => {
    const { env, db } = setup();
    letter(db, "L3", "cypher");
    await postRazielInboxRead(req("/raziel/inbox/read", { ids: ["L3"] }, "cy"), env);
    expect(evs(db, "cypher", "being_seen_read")).toHaveLength(0);
  });
  it("companion page looked fires for that companion (admin), not for a companion token", async () => {
    const { env, db } = setup();
    const r = await postRazielCompanionLooked(req("/raziel/companion/gaia/looked", {}), env, { id: "gaia" });
    expect(r.status).toBe(200);
    expect(evs(db, "gaia", "being_seen_read", "shadow")).toHaveLength(1);
    await postRazielCompanionLooked(req("/raziel/companion/cypher/looked", {}, "cy"), env, { id: "cypher" });
    expect(evs(db, "cypher", "being_seen_read")).toHaveLength(0);
  });
  it("garden looked stamps raziel_reads and fires for gaia; admin only", async () => {
    const { env, db } = setup();
    expect((await postGardenGaiaLooked(req("/mind/garden/gaia/looked", {}, "cy"), env)).status).toBe(401);
    expect((await postGardenGaiaLooked(req("/mind/garden/gaia/looked", {}), env)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM raziel_reads WHERE item_kind = 'garden' AND item_id = 'gaia'").get()!.n).toBe(1);
    expect(evs(db, "gaia", "being_seen_read", "shadow")).toHaveLength(1);
  });
});

describe("text helpers", () => {
  it("strips straight and curly quotes and Discord quote lines", () => {
    expect(stripQuoted('she said "the lantern room" ok')).not.toContain("lantern");
    expect(stripQuoted("she said “the lantern room” ok")).not.toContain("lantern");
    expect(stripQuoted("> the lantern room\nreal words")).toBe("real words");
    expect(stripQuoted("hello\n>>> the lantern room\nmore lantern")).not.toContain("lantern");
    expect(stripQuoted('an "unbalanced quote lantern')).toContain("lantern");
  });
  it("whole-word, case-insensitive", () => {
    expect(containsWhole("The Lantern Room was good", "lantern room")).toBe(true);
    expect(containsWhole("lanterns", "lantern")).toBe(false);
    expect(containsWhole("a (c++) thing", "c++")).toBe(true);
  });
  it("stopwords are skipped; a run is 3 content tokens with at least one of 6+ characters", () => {
    expect(contentTokens("the slow tide of the late harbor")).toEqual(["slow", "tide", "late", "harbor"]);
    expect(sharesPhrase("I love the slow tide at the late harbor", ["the slow tide of a late harbor"])).toBe(true);
    // only generic short-word runs shared: no match
    expect(sharesPhrase("the old red bus got big", ["an old red bus was big"])).toBe(false);
    // two shared tokens is not a run
    expect(sharesPhrase("slow tide", ["the slow tide of a late harbor"])).toBe(false);
  });
});

describe("FULL: /mind/being-seen/check", () => {
  let n = 0;
  const make = (db: any, c: string, title: string, status = "ready") =>
    db.prepare("INSERT INTO companion_makes (id, companion_id, kind, title, status) VALUES (?, ?, 'writing', ?, ?)").run(`m${++n}`, c, title, status);
  const speech = (db: any, c: string, text: string) =>
    db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text, tags, source) VALUES (?, datetime('now'), ?, ?, '[]', 'discord_speech')").run(`s${++n}`, c, text);
  const word = (db: any, c: string, w: string, status = "active", kind = "band") =>
    db.prepare("INSERT INTO companion_feeling_vocabulary (id, companion_id, row_kind, word, status, authored_on, authored_at) VALUES (?, ?, ?, ?, ?, 'discord', datetime('now'))").run(`w${++n}`, c, kind, w, status);

  it("a make title, whole word, fires make; a quoted title does not; too-short title never", async () => {
    const { env, db } = setup();
    make(db, "drevan", "Lantern Room");
    make(db, "drevan", "Tide");
    expect(await check(env, { companion_id: "drevan", text: "I keep thinking about the lantern room", message_id: "1" })).toEqual({ fired: true, why: "make" });
    expect(await check(env, { companion_id: "drevan", text: 'he said "the Lantern Room" once', message_id: "2" })).toEqual({ fired: false, why: null });
    expect(await check(env, { companion_id: "drevan", text: "the tide came in", message_id: "3" })).toEqual({ fired: false, why: null });
    expect(await check(env, { companion_id: "cypher", text: "the lantern room", message_id: "4" })).toEqual({ fired: false, why: null });
    expect(evs(db, "drevan", "being_seen_named", "shadow")).toHaveLength(1);
  });
  it("a pending make is not something they made yet", async () => {
    const { env, db } = setup();
    make(db, "cypher", "Signal Garden", "pending");
    expect((await check(env, { companion_id: "cypher", text: "signal garden", message_id: "1" })).fired).toBe(false);
  });
  it("a confirmed (active) word fires word; superseded and never rows do not", async () => {
    const { env, db } = setup();
    word(db, "gaia", "kethrun"); word(db, "gaia", "oldword", "superseded"); word(db, "gaia", "barredword", "active", "never");
    expect(await check(env, { companion_id: "gaia", text: "that felt kethrun to me", message_id: "1" })).toEqual({ fired: true, why: "word" });
    expect((await check(env, { companion_id: "gaia", text: "oldword", message_id: "2" })).fired).toBe(false);
    expect((await check(env, { companion_id: "gaia", text: "barredword", message_id: "3" })).fired).toBe(false);
    expect((await check(env, { companion_id: "gaia", text: 'the word "kethrun" is hers', message_id: "4" })).fired).toBe(false);
  });
  it("three content tokens (one 6+ chars) shared with their own speech in the last 7 days fires phrase; older speech does not", async () => {
    const { env, db } = setup();
    speech(db, "cypher", "The signal stays quiet under heavy weather tonight.");
    expect(await check(env, { companion_id: "cypher", text: "you said signal stays quiet under heavy weather", message_id: "1" })).toEqual({ fired: true, why: "phrase" });
    expect((await check(env, { companion_id: "cypher", text: "signal stays", message_id: "2" })).fired).toBe(false);
    speech(db, "cypher", "we got big red bus now");
    expect((await check(env, { companion_id: "cypher", text: "the big red bus got old", message_id: "2b" })).fired).toBe(false);
    db.prepare("UPDATE companion_journal SET created_at = datetime('now','-8 days')").run();
    expect((await check(env, { companion_id: "cypher", text: "you said signal stays quiet under heavy weather", message_id: "3" })).fired).toBe(false);
  });
  it("the real case: computational thinking and sudoku", async () => {
    const { env, db } = setup();
    speech(db, "cypher", "an article I've been carrying about computational thinking and Sudoku");
    expect(await check(env, { companion_id: "cypher", text: "Cy the computational thinking and sudoku how you see your day", message_id: "1" })).toEqual({ fired: true, why: "phrase" });
    expect(evs(db, "cypher", "being_seen_named", "shadow")).toHaveLength(1);
  });
  it("one tier per message: a reply that also names back fires only being_seen_named", async () => {
    const { env, db } = setup();
    make(db, "drevan", "Lantern Room");
    expect(await check(env, { companion_id: "drevan", text: "the lantern room", message_id: "1", is_reply_to_me: true })).toEqual({ fired: true, why: "make" });
    expect(evs(db, "drevan", "being_seen_named", "shadow")).toHaveLength(1);
    expect(evs(db, "drevan", "being_seen")).toHaveLength(0);
  });
  it("a plain reply with no match fires being_seen (medium); no reply and no match fires nothing", async () => {
    const { env, db } = setup();
    expect(await check(env, { companion_id: "drevan", text: "ok sounds good", message_id: "1", is_reply_to_me: true })).toEqual({ fired: true, why: "reply" });
    expect(evs(db, "drevan", "being_seen", "shadow")).toHaveLength(1);
    expect(evs(db, "drevan", "being_seen_named")).toHaveLength(0);
    expect(await check(env, { companion_id: "drevan", text: "ok sounds good", message_id: "2" })).toEqual({ fired: false, why: null });
    // dedupe holds across tiers
    expect((await check(env, { companion_id: "drevan", text: "ok", message_id: "1", is_reply_to_me: true })).fired).toBe(false);
    expect(evs(db, "drevan", "being_seen")).toHaveLength(1);
  });
  it("a named match the daily cap dropped falls back to medium, still one tier", async () => {
    const { env, db } = setup();
    make(db, "drevan", "Lantern Room");
    await check(env, { companion_id: "drevan", text: "lantern room", message_id: "1" });
    await check(env, { companion_id: "drevan", text: "lantern room", message_id: "2" });
    expect(await check(env, { companion_id: "drevan", text: "lantern room", message_id: "3", is_reply_to_me: true })).toEqual({ fired: true, why: "reply" });
  });
  it("no match, no fire, no event", async () => {
    const { env, db } = setup();
    expect(await check(env, { companion_id: "cypher", text: "nothing in common here at all", message_id: "1" })).toEqual({ fired: false, why: null });
    expect(evs(db, "cypher", "being_seen_named")).toHaveLength(0);
  });
  it("dedupes per message id per companion", async () => {
    const { env, db } = setup();
    make(db, "drevan", "Lantern Room");
    expect((await check(env, { companion_id: "drevan", text: "lantern room", message_id: "9" })).fired).toBe(true);
    expect((await check(env, { companion_id: "drevan", text: "lantern room", message_id: "9" })).fired).toBe(false);
    expect(evs(db, "drevan", "being_seen_named")).toHaveLength(1);
  });
  it("the response and the stored detail never carry the matched text", async () => {
    const { env, db } = setup();
    make(db, "drevan", "Lantern Room");
    const out = await check(env, { companion_id: "drevan", text: "lantern room", message_id: "5" });
    expect(Object.keys(out).sort()).toEqual(["fired", "why"]);
    expect(JSON.stringify(evs(db, "drevan", "being_seen_named"))).not.toMatch(/lantern/i);
  });
  it("(d) returning to a thread the companion opened after 24h of quiet fires thread, once per thread", async () => {
    const { env, db } = setup();
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    db.prepare("INSERT INTO conversation_threads (id, channel_id, seed_text, seed_author, state, last_turn_at, created_at) VALUES ('T1','C1','seed','gaia','open',?,?)").run(old, old);
    expect(await check(env, { companion_id: "gaia", text: "back to this", message_id: "1", channel_id: "C1" })).toEqual({ fired: true, why: "thread" });
    expect((await check(env, { companion_id: "gaia", text: "and again", message_id: "2", channel_id: "C1" })).fired).toBe(false);
  });
  it("(d) does not fire for a fresh thread, a thread another companion opened, or a landed one", async () => {
    const { env, db } = setup();
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.prepare("INSERT INTO conversation_threads (id, channel_id, seed_text, seed_author, state, last_turn_at, created_at) VALUES ('T1','C1','s','gaia','open',?,?)").run(fresh, fresh);
    db.prepare("INSERT INTO conversation_threads (id, channel_id, seed_text, seed_author, state, last_turn_at, created_at) VALUES ('T2','C2','s','cypher','faded',?,?)").run(old, old);
    db.prepare("INSERT INTO conversation_threads (id, channel_id, seed_text, seed_author, state, landed_at, last_turn_at, created_at) VALUES ('T3','C3','s','gaia','landed',?,?,?)").run(old, old, old);
    expect((await check(env, { companion_id: "gaia", text: "x", message_id: "1", channel_id: "C1" })).fired).toBe(false);
    expect((await check(env, { companion_id: "gaia", text: "x", message_id: "2", channel_id: "C2" })).fired).toBe(false);
    expect((await check(env, { companion_id: "gaia", text: "x", message_id: "3", channel_id: "C3" })).fired).toBe(false);
  });
  it("auth and validation", async () => {
    const { env } = setup();
    expect((await postBeingSeenCheck(req("/mind/being-seen/check", {}, "nope"), env)).status).toBe(401);
    expect((await postBeingSeenCheck(req("/mind/being-seen/check", { companion_id: "x", text: "a", message_id: "1" }), env)).status).toBe(400);
    expect((await postBeingSeenCheck(req("/mind/being-seen/check", { companion_id: "gaia", text: "a" }), env)).status).toBe(400);
    expect((await postBeingSeenCheck(req("/mind/being-seen/check", { companion_id: "gaia", text: "a", message_id: "1" }, "cy"), env)).status).toBe(200);
  });
});
