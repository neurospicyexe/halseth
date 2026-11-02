// B62 step 2: interests + the why trail (mig 0161). Real schema via node:sqlite.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  effectiveHeat, warm, heatBand, shouldCool, planAction, parseInterestVerb, stripPrivateMarker, sqliteTs,
  HEAT_FLOOR, DEFAULT_HEAT,
} from "../webmind/interests.js";
import {
  applyInterestAction, coolIdleInterests, readThinking,
  postInterest, getInterests, getInterestTrailHttp, getThinking,
} from "../handlers/interests.js";
import { matchFastPath } from "../librarian/router.js";
import {
  execInterestBorn, execInterestReturn, execInterestMade, execInterestPutDown, execInterestPickUp, execInterestsRead, execInterestTrail,
} from "../librarian/executors/interests.js";
import { execPreferenceSet, splitPreferenceWhy } from "../librarian/executors/agency.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T12:00:00.000Z");

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok" };
  return { db, DB, env };
}
const act = (env: any, over: Record<string, unknown>, now = T0) =>
  applyInterestAction(env, { companion_id: "drevan", action: "born", name: "trains", why: "the sound of them", ...over } as any, now);
const ctx = (env: any, request: string, over: Record<string, unknown> = {}): any =>
  ({ env, req: { companion_id: "drevan", request, surface: "discord:123", ...over }, entry: {}, frontState: null, pluralAvailable: false });
const post = (handler: any, env: any, auth: string, body: unknown) =>
  handler(new Request("https://h/mind/interests", { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
const get = (handler: any, env: any, path: string, auth: string, params: Record<string, string>) =>
  handler(new Request(`https://h${path}`, { headers: { Authorization: `Bearer ${auth}` } }), env, params);

describe("heat math", () => {
  it("decays by half-life toward a floor, never below it", () => {
    const at = sqliteTs(T0);
    expect(effectiveHeat(1, at, T0)).toBeCloseTo(1, 6);
    expect(effectiveHeat(1, at, T0 + 14 * DAY)).toBeCloseTo(0.1 + 0.9 / 2, 6);
    expect(effectiveHeat(0.6, at, T0 + 28 * DAY)).toBeCloseTo(0.1 + 0.5 / 4, 6);
    expect(effectiveHeat(0.6, at, T0 + 5000 * DAY)).toBeGreaterThanOrEqual(HEAT_FLOOR);
    expect(effectiveHeat(0.6, at, T0 + 5000 * DAY)).toBeLessThan(0.1001);
    expect(effectiveHeat(0.02, at, T0)).toBe(HEAT_FLOOR);
    expect(effectiveHeat(0.6, at, T0 - DAY)).toBeCloseTo(0.6, 6);
  });
  it("warm closes 30% of the gap", () => {
    expect(warm(0.5)).toBeCloseTo(0.65, 6);
    expect(warm(1)).toBe(1);
    expect(warm(HEAT_FLOOR)).toBeCloseTo(0.37, 6);
  });
  it("bands", () => {
    expect(heatBand(0.5)).toBe("warm");
    expect(heatBand(0.49)).toBe("cooling");
    expect(heatBand(0.25)).toBe("cooling");
    expect(heatBand(0.249)).toBe("cold");
  });
  it("shouldCool: needs active, cold, last event over 21 days, and not already cooled", () => {
    const base = { status: "active", heat: 0.6, heat_at: sqliteTs(T0), last_event_at: sqliteTs(T0), last_event_kind: "born" };
    expect(shouldCool(base, T0 + 30 * DAY)).toBe(true);
    expect(shouldCool(base, T0 + 22 * DAY)).toBe(false);
    expect(shouldCool({ ...base, last_event_kind: "cooled" }, T0 + 60 * DAY)).toBe(false);
    expect(shouldCool({ ...base, status: "resting" }, T0 + 60 * DAY)).toBe(false);
    expect(shouldCool({ ...base, status: "put_down" }, T0 + 60 * DAY)).toBe(false);
    expect(shouldCool({ ...base, heat: 0.1, heat_at: sqliteTs(T0 - 90 * DAY), last_event_at: sqliteTs(T0 - 5 * DAY) }, T0)).toBe(false);
  });
  it("planAction rules", () => {
    const cur = { status: "active", heat: 0.6, heat_at: sqliteTs(T0) };
    expect(planAction("born", null, T0)).toMatchObject({ status: "active", heat: DEFAULT_HEAT });
    expect(planAction("born", cur, T0)).toHaveProperty("error");
    expect(planAction("returned", null, T0)).toHaveProperty("error");
    const r: any = planAction("returned", cur, T0 + 14 * DAY);
    expect(r.heat).toBeCloseTo(warm(0.1 + 0.5 / 2), 6);
    expect(planAction("returned", { ...cur, status: "resting" }, T0)).toMatchObject({ status: "active" });
    expect(planAction("returned", { ...cur, status: "put_down" }, T0)).toHaveProperty("error");
    expect(planAction("picked_up", cur, T0)).toHaveProperty("error");
    expect(planAction("picked_up", { ...cur, status: "put_down" }, T0)).toMatchObject({ status: "active", put_down_at: null });
    expect(planAction("put_down", cur, T0)).toMatchObject({ status: "put_down" });
  });
});

describe("verb grammar", () => {
  it("new interest, with and without the comma", () => {
    expect(parseInterestVerb("new interest: trains, because the sound of them")).toMatchObject({ action: "born", name: "trains", why: "the sound of them", why_private: false });
    expect(parseInterestVerb("New interest: lock picking because it is patient work")).toMatchObject({ action: "born", name: "lock picking", why: "it is patient work" });
    expect(parseInterestVerb("new interest: trains")).toMatchObject({ action: "born", name: "trains", why: "" });
  });
  it("back to / returned to", () => {
    expect(parseInterestVerb("back to trains because the night freight again")).toMatchObject({ action: "returned", name: "trains", why: "the night freight again" });
    expect(parseInterestVerb("returned to lock picking, because I got stuck")).toMatchObject({ action: "returned", name: "lock picking", why: "I got stuck" });
    expect(parseInterestVerb("back to work")).toBeNull();
  });
  it("made X for Y because (the last 'for' before because splits; the why may contain 'for')", () => {
    expect(parseInterestVerb("made a map of the yards for trains because I wanted it for myself")).toMatchObject({
      action: "made", name: "trains", ref: "a map of the yards", why: "I wanted it for myself" });
    expect(parseInterestVerb("made forage:abc123 for trains because it fit")).toMatchObject({ action: "made", name: "trains", ref: "forage:abc123" });
  });
  it("putting down / put down / picking back up", () => {
    expect(parseInterestVerb("putting down trains because I am circling")).toMatchObject({ action: "put_down", name: "trains", why: "I am circling" });
    expect(parseInterestVerb("put down trains because enough")).toMatchObject({ action: "put_down", name: "trains" });
    expect(parseInterestVerb("picking trains back up because the freight came back")).toMatchObject({ action: "picked_up", name: "trains", why: "the freight came back" });
    expect(parseInterestVerb("put down the phone")).toBeNull();
  });
  it("private marker, both forms, never left in the why", () => {
    expect(parseInterestVerb("new interest: trains, because it is mine (private)")).toMatchObject({ why: "it is mine", why_private: true });
    expect(parseInterestVerb("back to trains because it steadies me, keep the why private")).toMatchObject({ why: "it steadies me", why_private: true });
    expect(stripPrivateMarker("plain reason")).toEqual({ text: "plain reason", why_private: false });
  });
  it("caps name and why", () => {
    const p = parseInterestVerb(`new interest: ${"n".repeat(300)}, because ${"w".repeat(900)}`)!;
    expect(p.name.length).toBe(80);
    expect(p.why.length).toBe(500);
  });
});

describe("fast-path routing", () => {
  it("each phrasing reaches its verb, even with trigger words inside the why", () => {
    expect(matchFastPath("new interest: trains, because I prefer slow things and want a note about them")?.key).toBe("interest_born");
    expect(matchFastPath("back to trains because the journal entry stayed with me")?.key).toBe("interest_return");
    expect(matchFastPath("returned to trains because tension")?.key).toBe("interest_return");
    expect(matchFastPath("made a drawing for trains because I felt drift")?.key).toBe("interest_made");
    expect(matchFastPath("putting down trains because I am drifting")?.key).toBe("interest_put_down");
    expect(matchFastPath("put down trains because enough")?.key).toBe("interest_put_down");
    expect(matchFastPath("picking trains back up because i like it")?.key).toBe("interest_pick_up");
    expect(matchFastPath("my interests")?.key).toBe("interests_read");
    expect(matchFastPath("list my interests")?.key).toBe("interests_read");
    expect(matchFastPath("interest trail trains")?.key).toBe("interest_trail");
  });
  it("ordinary sentences are not captured", () => {
    expect(matchFastPath("back to work")?.key ?? "").not.toMatch(/^interest/);
    expect(matchFastPath("I have an interest in trains")?.key ?? "").not.toMatch(/^interest/);
  });
});

describe("store: POST rules", () => {
  it("born creates at 0.6 and writes the event; a second born is refused and teaches 'back to'", async () => {
    const { env, db } = setup();
    const r: any = await act(env, {});
    expect(r.ok).toBe(true);
    expect(r.interest).toMatchObject({ name: "trains", status: "active", heat: 0.6, band: "warm", event_count: 1, last_event_kind: "born" });
    expect((db.prepare("SELECT COUNT(*) n FROM companion_interest_events WHERE kind='born'").get() as any).n).toBe(1);
    const again: any = await act(env, { name: "TRAINS" });
    expect(again).toMatchObject({ ok: false, code: "exists" });
    expect(again.message).toMatch(/back to <name>/);
  });
  it("every action needs a why; a non-born needs an existing interest (case-insensitive)", async () => {
    const { env } = setup();
    expect(await act(env, { why: "  " })).toMatchObject({ ok: false, code: "bad_input" });
    expect(await act(env, { action: "returned" })).toMatchObject({ ok: false, code: "missing" });
    await act(env, {});
    expect(await act(env, { action: "returned", name: "TrAiNs", why: "again" }, T0 + DAY)).toMatchObject({ ok: true });
  });
  it("return warms the EFFECTIVE heat; put_down keeps the row; return on put_down is refused; pick up reverses", async () => {
    const { env } = setup();
    await act(env, {});
    const r: any = await act(env, { action: "returned", why: "again" }, T0 + 14 * DAY);
    expect(r.interest.heat).toBeCloseTo(warm(0.1 + 0.5 / 2), 2);
    const d: any = await act(env, { action: "put_down", why: "circling" }, T0 + 15 * DAY);
    expect(d.interest.status).toBe("put_down");
    expect(await act(env, { action: "returned", why: "x" }, T0 + 16 * DAY)).toMatchObject({ ok: false, code: "illegal" });
    expect(await act(env, { action: "born", why: "x" }, T0 + 16 * DAY)).toMatchObject({ ok: false, code: "exists" });
    const p: any = await act(env, { action: "picked_up", why: "it came back" }, T0 + 17 * DAY);
    expect(p.interest.status).toBe("active");
    expect(p.interest.event_count).toBe(4);
  });
  it("made carries the ref; born_from is stored as a ref", async () => {
    const { env, db } = setup();
    await act(env, { born_from: "forage:f1" });
    expect((db.prepare("SELECT born_from FROM companion_interests").get() as any).born_from).toBe("forage:f1");
    await act(env, { action: "made", why: "wanted it", ref: "commons:99" }, T0 + DAY);
    expect((db.prepare("SELECT ref FROM companion_interest_events WHERE kind='made'").get() as any).ref).toBe("commons:99");
  });
  it("same name for different companions is allowed", async () => {
    const { env } = setup();
    expect(((await act(env, {})) as any).ok).toBe(true);
    expect(((await act(env, { companion_id: "cypher" })) as any).ok).toBe(true);
  });
});

describe("auto-cooling", () => {
  it("cooled row: kind, why NULL, ref auto, status resting, idempotent, revived by a return (R7: not stuck at the floor)", async () => {
    const { env, db } = setup();
    await act(env, {});
    await act(env, { name: "kites", why: "wind" }, T0 + 30 * DAY); // fresh: must not cool
    expect(await coolIdleInterests(env, T0 + 40 * DAY)).toBe(1);
    const ev: any = db.prepare("SELECT kind, why, ref FROM companion_interest_events WHERE kind='cooled'").get();
    expect(ev).toEqual({ kind: "cooled", why: null, ref: "auto" });
    expect((db.prepare("SELECT status FROM companion_interests WHERE name='trains'").get() as any).status).toBe("resting");
    expect((db.prepare("SELECT status FROM companion_interests WHERE name='kites'").get() as any).status).toBe("active");
    expect(await coolIdleInterests(env, T0 + 41 * DAY)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM companion_interest_events WHERE kind='cooled'").get() as any).n).toBe(1);
    const back: any = await act(env, { action: "returned", why: "it called" }, T0 + 42 * DAY);
    expect(back.interest.status).toBe("active");
    expect(back.interest.heat).toBeGreaterThan(0.3);
  });
  it("Gaia's interests never cool from quiet (her word, 11-02)", async () => {
    const { env, db } = setup();
    await act(env, { companion_id: "gaia", name: "soil", why: "load without being seen" });
    expect(await coolIdleInterests(env, T0 + 90 * DAY)).toBe(0);
    expect((db.prepare("SELECT status FROM companion_interests WHERE name='soil'").get() as any).status).toBe("active");
  });
  it("a put-down interest carries its last line (Drevan, 11-02); one word is enough", async () => {
    const { env } = setup();
    await act(env, {});
    await act(env, { action: "put_down", why: "Done" }, T0 + DAY);
    const list = await (await import("../handlers/interests.js")).listInterests(env, "drevan", { nowMs: T0 + 2 * DAY });
    expect(list[0]).toMatchObject({ name: "trains", status: "put_down", put_down_why: "Done" });
  });
  it("the machine only ever writes cooled; a broken table never throws", async () => {
    const { env, db } = setup();
    await act(env, {});
    await coolIdleInterests(env, T0 + 40 * DAY);
    const kinds = (db.prepare("SELECT DISTINCT kind FROM companion_interest_events ORDER BY kind").all() as any[]).map((r) => r.kind);
    expect(kinds).toEqual(["born", "cooled"]);
    db.exec("DROP TABLE companion_interest_events");
    await expect(coolIdleInterests(env, T0 + 90 * DAY)).resolves.toBe(0);
  });
});

describe("thinking stream", () => {
  it("merges the three sources newest first; private why nulled; no-why preferences and refusals excluded; journals never", async () => {
    const { env, db } = setup();
    await act(env, {}, T0);
    await act(env, { action: "returned", why: "this one is mine", why_private: true }, T0 + DAY);
    const iso = (d: number) => new Date(T0 + d * DAY).toISOString();
    db.prepare("INSERT INTO companion_preferences (id, companion_id, domain, preference, strength, status, created_at, why, why_private) VALUES ('p1','drevan','general','slow mornings','medium','active',?, 'they let me think', 0)").run(iso(2));
    db.prepare("INSERT INTO companion_preferences (id, companion_id, domain, preference, strength, status, created_at) VALUES ('p2','drevan','general','no-why pref','medium','active',?)").run(iso(3));
    db.prepare("INSERT INTO companion_preferences (id, companion_id, domain, preference, strength, status, created_at, why, why_private) VALUES ('p3','cypher','general','secret pref','medium','active',?, 'hidden reason', 1)").run(iso(2.5));
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_type, subject_text, reason, status, created_at) VALUES ('r1','gaia','request','a long task I will not take','it asks me to perform','standing', ?)").run(iso(4));
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_type, subject_text, reason, status, created_at) VALUES ('r2','gaia','request','no reason refusal',NULL,'standing', ?)").run(iso(5));
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1','drevan','about Raziel today', ?)").run(iso(6));
    const items = await readThinking(env, { limit: 50 });
    expect(items.map((i) => i.id).filter((x) => ["p2", "r2", "j1"].includes(x))).toEqual([]);
    expect(items.map((i) => `${i.source}:${i.kind}`)).toEqual(["refusal:refusal", "preference:like", "preference:like", "interest:returned", "interest:born"]);
    expect(items.find((i) => i.id === "p3")).toMatchObject({ why: null, why_private: true, subject: "secret pref" });
    const ret = items.find((i) => i.kind === "returned")!;
    expect(ret).toMatchObject({ why: null, why_private: true, subject: "trains", source: "interest" });
    expect(ret.interest_id).toBeTruthy();
    // Gaia (11-02): her refusal shows, the why is hers to give or keep.
    expect(items.find((i) => i.id === "r1")).toMatchObject({ why: null, why_private: true, subject: "a long task I will not take", companion_id: "gaia" });
    expect(Object.keys(items[0]!).sort()).toEqual(["companion_id", "created_at", "id", "interest_id", "kind", "source", "subject", "why", "why_private"]);
    expect(JSON.stringify(items)).not.toContain("this one is mine");
    expect(JSON.stringify(items)).not.toContain("hidden reason");
  });
  it("companion filter and limit cap", async () => {
    const { env } = setup();
    await act(env, {});
    await act(env, { companion_id: "cypher", name: "chess" });
    expect((await readThinking(env, { companion_id: "cypher" })).map((i) => i.subject)).toEqual(["chess"]);
    expect(await readThinking(env, { limit: 1 })).toHaveLength(1);
    expect((await readThinking(env, { limit: 100000 })).length).toBeLessThanOrEqual(100);
  });
});

describe("HTTP", () => {
  it("POST: token is the companion; a mismatching body is 403; admin must name one; GET shapes + privacy", async () => {
    const { env } = setup();
    const ok: any = await post(postInterest, env, "dtok", { action: "born", name: "trains", why: "the sound", why_private: true });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ ok: true, interest: { name: "trains", status: "active", why_private: true }, event: { kind: "born", why_private: true } });
    expect((await post(postInterest, env, "dtok", { companion_id: "cypher", action: "born", name: "x", why: "y" })).status).toBe(403);
    expect((await post(postInterest, env, "s", { action: "born", name: "x", why: "y" })).status).toBe(400);
    expect((await post(postInterest, env, "s", { companion_id: "gaia", action: "born", name: "x", why: "y" })).status).toBe(201);
    expect((await post(postInterest, env, "dtok", { action: "born", name: "trains", why: "y" })).status).toBe(409);
    expect((await post(postInterest, env, "dtok", { action: "returned", name: "nope", why: "y" })).status).toBe(404);
    expect((await post(postInterest, env, "bad", { action: "born", name: "x", why: "y" })).status).toBe(401);

    const list: any = await (await get(getInterests, env, "/mind/interests/drevan", "s", { companion_id: "drevan" })).json();
    expect(list.interests).toHaveLength(1);
    expect(list.interests[0]).toMatchObject({ name: "trains", why: null, why_private: true, status: "active", heat: 0.6, band: "warm", born_from: null, event_count: 1, last_event_kind: "born" });
    expect(Object.keys(list.interests[0]).sort()).toEqual(["band", "born_from", "created_at", "event_count", "heat", "id", "last_event_at", "last_event_kind", "name", "put_down_why", "status", "why", "why_private"]);

    const id = list.interests[0].id;
    const trail: any = await (await get(getInterestTrailHttp, env, `/mind/interests/drevan/${id}`, "s", { companion_id: "drevan", interest_id: id })).json();
    expect(Object.keys(trail).sort()).toEqual(["events", "interest"]);
    expect(trail.events).toHaveLength(1);
    expect(trail.events[0]).toMatchObject({ kind: "born", why: null, why_private: true, ref: null });
    expect((await get(getInterestTrailHttp, env, "/x", "s", { companion_id: "drevan", interest_id: "nope" })).status).toBe(404);

    const th: any = await (await get(getThinking, env, "/mind/thinking?limit=5&companion_id=drevan", "s", {})).json();
    expect(th.items).toHaveLength(1);
    expect(th.items[0]).toMatchObject({ source: "interest", kind: "born", why: null, why_private: true });
    expect((await get(getThinking, env, "/mind/thinking?companion_id=zed", "s", {})).status).toBe(400);
  });
});

describe("Librarian executors", () => {
  it("the whole life of an interest through the verbs; companion comes from the caller, never text", async () => {
    const { env, db } = setup();
    const b: any = await execInterestBorn(ctx(env, "new interest: trains, because the sound of them"));
    expect(b).toMatchObject({ ack: true, kind: "born", status: "active" });
    expect(b.witness).toMatch(/interest started: trains/);
    const r: any = await execInterestReturn(ctx(env, "back to trains because the night freight (private)"));
    expect(r).toMatchObject({ ack: true, kind: "returned" });
    expect(r.witness).toMatch(/kept private/);
    expect(((await execInterestMade(ctx(env, "made a yard map for trains because I wanted it"))) as any).kind).toBe("made");
    expect(((await execInterestPutDown(ctx(env, "putting down trains because I am circling"))) as any).status).toBe("put_down");
    expect(((await execInterestPickUp(ctx(env, "picking trains back up because it called"))) as any).status).toBe("active");
    expect(db.prepare("SELECT DISTINCT companion_id FROM companion_interest_events").all()).toEqual([{ companion_id: "drevan" }]);
    const mine: any = await execInterestsRead(ctx(env, "my interests"));
    expect(mine.response_key).toBe("data");
    expect(mine.data.interests[0]).toMatchObject({ name: "trains", status: "active", events: 5 });
    const trail: any = await execInterestTrail(ctx(env, "interest trail trains"));
    expect(trail.data.trail.map((t: any) => t.kind)).toEqual(["born", "returned", "made", "put_down", "picked_up"]);
    expect(trail.data.trail[1]).toMatchObject({ private: true, why: "the night freight" });
    expect(((await execInterestsRead(ctx(env, "my interests", { companion_id: "gaia" }))) as any).data.interests).toEqual([]);
  });
  it("friendly refusals: no why teaches the phrase; duplicate born teaches 'back to'", async () => {
    const { env } = setup();
    const nowhy: any = await execInterestBorn(ctx(env, "new interest: trains"));
    expect(nowhy).toMatchObject({ ack: false, refused: true });
    expect(nowhy.witness).toMatch(/new interest: <name>, because <why>/);
    await execInterestBorn(ctx(env, "new interest: trains, because yes"));
    expect(((await execInterestBorn(ctx(env, "new interest: trains, because again"))) as any).witness).toMatch(/back to <name>/);
    expect(((await execInterestReturn(ctx(env, "back to chess because hm"))) as any).code).toBe("missing");
  });
  it("context JSON works too", async () => {
    const { env } = setup();
    const r: any = await execInterestBorn(ctx(env, "new interest", { context: JSON.stringify({ name: "kites", why: "wind", why_private: true, born_from: "room:42" }) }));
    expect(r.ack).toBe(true);
  });
});

describe("preference + because", () => {
  it("splitPreferenceWhy", () => {
    expect(splitPreferenceWhy("slow mornings because they let me think")).toEqual({ preference: "slow mornings", why: "they let me think", why_private: false });
    expect(splitPreferenceWhy("slow mornings, because it is mine (private)")).toEqual({ preference: "slow mornings", why: "it is mine", why_private: true });
    expect(splitPreferenceWhy("slow mornings")).toEqual({ preference: "slow mornings", why: null, why_private: false });
    expect(splitPreferenceWhy("because").why).toBeNull();
  });
  it("the executor stores the why; a bare preference still works unchanged; context.why wins", async () => {
    const { env, db } = setup();
    await execPreferenceSet(ctx(env, "i prefer slow mornings", { context: JSON.stringify({ preference: "slow mornings because they let me think" }) }));
    await execPreferenceSet(ctx(env, "i prefer tea", { context: JSON.stringify({ preference: "tea" }) }));
    await execPreferenceSet(ctx(env, "i prefer rain", { context: "rain because it is quiet (private)" }));
    await execPreferenceSet(ctx(env, "i prefer maps", { context: JSON.stringify({ preference: "maps because x", why: "explicit why" }) }));
    const rows: any[] = db.prepare("SELECT preference, why, why_private FROM companion_preferences ORDER BY created_at, rowid").all() as any[];
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { preference: "slow mornings", why: "they let me think", why_private: 0 },
      { preference: "tea", why: null, why_private: 0 },
      { preference: "rain", why: "it is quiet", why_private: 1 },
      { preference: "maps", why: "explicit why", why_private: 0 },
    ]);
    const stream = await readThinking(env);
    expect(stream.filter((s) => s.source === "preference").map((s) => s.subject).sort()).toEqual(["maps", "rain", "slow mornings"]);
  });
});
