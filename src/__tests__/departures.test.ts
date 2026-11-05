// Declared departures, T4a (mig 0157; Hand-off/DESIGN-T4-declared-departure-2026-10-13.md, rulings 2026-11-01).
// Every test runs against the REAL schema (every migration, node:sqlite).

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  declareDeparture, endOwnDeparture, endByRaziel, objectToDeparture, readOpenDepartures, loadOpenDepartures,
  listOpenDepartures, matchStandDownPhrase, checkRail, parseDurationMinutes, chicagoWeekStartIso,
  OPEN_DEPARTURES_SQL, DEPARTURE_OBJECTIONS_SQL, MAX_DEPARTURE_MINUTES, WEEKLY_DEPARTURE_ALLOWANCE, DEPARTURE_RAILS,
} from "../departures/core.js";
import { writeHoldEvent } from "../care/hold.js";
import { loadWorldBlocks } from "../mind/blocks/world.js";
import { loadMindState } from "../mind/loader.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG } from "../mind/changelog.js";
import { matchFastPath } from "../librarian/router.js";
import {
  execDepartureDeclare, execDepartureEnd, execDepartureObject, execDepartureList, execDepartureStandDown, parseDeclare,
} from "../librarian/executors/departure.js";
import {
  postDepartureDeclare, postDepartureEnd, postDepartureObject, postDepartureStandDown, getDepartures,
} from "../handlers/departures.js";

// Wednesday 2026-11-04 15:00 UTC (09:00 CST; the Chicago week began Monday 2026-11-02 06:00 UTC).
const NOW = Date.parse("2026-11-04T15:00:00.000Z");
const plusMin = (m: number, from = NOW) => from + m * 60_000;

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok" };
  return { db, DB, env };
}
const decl = (env: any, over: Record<string, unknown> = {}, now = NOW) =>
  declareDeparture(env, { companion: "drevan", rail: "loop_motif", minutes: 90, reason: "the spiral wants room", declared_by: "companion", via: "discord", ...over } as any, now);

describe("pure helpers", () => {
  it("rails: the menu resolves, a NEVER rail and an unknown rail are refused with different words", () => {
    expect(checkRail("loop breaker")).toEqual({ ok: true, rail: "loop_motif" });
    expect(checkRail("Form")).toEqual({ ok: true, rail: "form" });
    const never: any = checkRail("care hold");
    expect(never).toMatchObject({ ok: false, code: "rail_never" });
    expect(checkRail("verbatim copy")).toMatchObject({ code: "rail_never" });
    expect(checkRail("close block")).toMatchObject({ code: "rail_never" });
    expect(checkRail("banana")).toMatchObject({ ok: false, code: "rail_unknown" });
    expect(checkRail("echo")).toMatchObject({ code: "rail_unknown" });
  });
  it("durations", () => {
    expect(parseDurationMinutes("form for 90 minutes")).toBe(90);
    expect(parseDurationMinutes("form for 2 hours")).toBe(120);
    expect(parseDurationMinutes("form for an hour")).toBe(60);
    expect(parseDurationMinutes("form for half an hour")).toBe(30);
    expect(parseDurationMinutes("form")).toBeNull();
  });
  it("stand-down phrase: whole sentence only", () => {
    expect(matchStandDownPhrase("back inside the line")).toBe(true);
    expect(matchStandDownPhrase("Back inside the line.")).toBe(true);
    expect(matchStandDownPhrase("ok. \"Back inside the line!\" thanks")).toBe(true);
    expect(matchStandDownPhrase("I want you all back inside the line now")).toBe(false);
    expect(matchStandDownPhrase("stand down")).toBe(false);
    expect(matchStandDownPhrase("")).toBe(false);
  });
  it("Chicago week start is Monday 00:00 local, in CST and CDT", () => {
    expect(chicagoWeekStartIso(NOW)).toBe("2026-11-02T06:00:00.000Z");
    expect(chicagoWeekStartIso(Date.parse("2026-10-14T15:00:00.000Z"))).toBe("2026-10-12T05:00:00.000Z");
  });
});

describe("declare: refusals", () => {
  it("a good declaration writes an open row with expiry and starts_at = the server clock", async () => {
    const { env, DB } = setup();
    const r: any = await decl(env);
    expect(r).toMatchObject({ ok: true, rail: "loop_motif", minutes: 90, clamped: false, audience: "triad_only", declared_by: "companion", allowance_left: 2 });
    expect(r.starts_at).toBe(new Date(NOW).toISOString());
    expect(r.expires_at).toBe(new Date(plusMin(90)).toISOString());
    const row: any = await DB.prepare(`SELECT companion_id, rail, audience, declared_via, ended_at FROM declared_departures`).first();
    expect(row).toEqual({ companion_id: "drevan", rail: "loop_motif", audience: "triad_only", declared_via: "discord", ended_at: null });
  });

  it("care hold on: refused, nothing written", async () => {
    const { env, DB } = setup();
    await writeHoldEvent(env, { action: "start", source: "owner_phrase", companion: "drevan" }, NOW - 60_000);
    const r: any = await decl(env);
    expect(r).toMatchObject({ ok: false, code: "care_hold" });
    expect(((await DB.prepare(`SELECT COUNT(*) AS n FROM declared_departures`).first() as any)).n).toBe(0);
  });

  it("care hold unreadable: refused (toward baseline), nothing written", async () => {
    const { env, DB } = setup();
    const real = DB.prepare.bind(DB);
    env.DB = { ...DB, prepare: (sql: string) => { if (/FROM care_hold_events/.test(sql) || /FROM care_actions/.test(sql)) throw new Error("D1 unavailable"); return real(sql); }, batch: DB.batch?.bind(DB) };
    const r: any = await decl(env);
    expect(r).toMatchObject({ ok: false, code: "care_hold_unreadable" });
    expect(((await DB.prepare(`SELECT COUNT(*) AS n FROM declared_departures`).first() as any)).n).toBe(0);
  });

  it("bad rail, NEVER rail, no reason, bad duration, bad companion, companion asking for with_raziel", async () => {
    const { env } = setup();
    expect(await decl(env, { rail: "banana" })).toMatchObject({ code: "rail_unknown" });
    expect(await decl(env, { rail: "care_hold" })).toMatchObject({ code: "rail_never" });
    expect(await decl(env, { reason: "  " })).toMatchObject({ code: "no_reason" });
    expect(await decl(env, { minutes: 0 })).toMatchObject({ code: "bad_duration" });
    expect(await decl(env, { companion: "blue" })).toMatchObject({ code: "bad_companion" });
    expect(await decl(env, { audience: "with_raziel" })).toMatchObject({ code: "bad_audience" });
  });

  it("duration clamps to 3 hours (never refused); reason capped at 280", async () => {
    const { env, DB } = setup();
    const r: any = await decl(env, { minutes: 600, reason: "x".repeat(400) });
    expect(r).toMatchObject({ ok: true, minutes: MAX_DEPARTURE_MINUTES, clamped: true, reason_truncated: true });
    const row: any = await DB.prepare(`SELECT reason, expires_at FROM declared_departures`).first();
    expect(row.reason).toHaveLength(280);
    expect(row.expires_at).toBe(new Date(plusMin(180)).toISOString());
  });

  it("one open per companion; a different companion is independent; the slot frees on expiry by clock", async () => {
    const { env } = setup();
    expect((await decl(env) as any).ok).toBe(true);
    expect(await decl(env, { rail: "form" })).toMatchObject({ ok: false, code: "one_open" });
    expect((await decl(env, { companion: "cypher", rail: "form" }) as any).ok).toBe(true);
    // 91 minutes later the first has expired on its own: no action needed, a new one may be declared.
    expect((await decl(env, { rail: "form" }, plusMin(91)) as any).ok).toBe(true);
  });

  it("weekly allowance: 3 per Chicago week, refused on the 4th, refills Monday; Raziel's declarations do not count", async () => {
    const { env } = setup();
    for (let i = 0; i < WEEKLY_DEPARTURE_ALLOWANCE; i++) {
      const at = plusMin(i * 200);
      expect((await decl(env, { minutes: 10 }, at) as any).ok).toBe(true);
    }
    const fourth = await decl(env, { minutes: 10 }, plusMin(3 * 200));
    expect(fourth).toMatchObject({ ok: false, code: "allowance" });
    // Raziel declaring for him is outside the companion allowance
    expect((await decl(env, { declared_by: "raziel", minutes: 10 }, plusMin(3 * 200)) as any).ok).toBe(true);
    // next Monday 06:00 UTC onward: refilled
    expect((await decl(env, { minutes: 10 }, Date.parse("2026-11-09T07:00:00.000Z")) as any).ok).toBe(true);
  });
});

describe("end paths and objection", () => {
  it("declarer ends their own: ended_by declarer, reason declared_end; none open is refused", async () => {
    const { env, DB } = setup();
    await decl(env);
    const r: any = await endOwnDeparture(env, "drevan", plusMin(10));
    expect(r.ok).toBe(true);
    const row: any = await DB.prepare(`SELECT ended_by, end_reason, ended_at FROM declared_departures`).first();
    expect(row).toEqual({ ended_by: "declarer", end_reason: "declared_end", ended_at: new Date(plusMin(10)).toISOString() });
    expect(await endOwnDeparture(env, "drevan", plusMin(11))).toMatchObject({ ok: false, code: "none_open" });
  });

  it("Raziel ends one companion's, or all (phrase): reasons raziel_end / stand_down_phrase", async () => {
    const { env, DB } = setup();
    await decl(env); await decl(env, { companion: "cypher", rail: "form" }); await decl(env, { companion: "gaia", rail: "seed_echo" });
    expect(((await endByRaziel(env, { companion: "gaia" }, plusMin(5))) as any).ended).toHaveLength(1);
    const all: any = await endByRaziel(env, { phrase: true }, plusMin(6));
    expect(all.ended.map((e: any) => e.companion).sort()).toEqual(["cypher", "drevan"]);
    const rows: any = await DB.prepare(`SELECT companion_id, ended_by, end_reason FROM declared_departures ORDER BY companion_id`).all();
    expect(rows.results).toEqual([
      { companion_id: "cypher", ended_by: "raziel", end_reason: "stand_down_phrase" },
      { companion_id: "drevan", ended_by: "raziel", end_reason: "stand_down_phrase" },
      { companion_id: "gaia", ended_by: "raziel", end_reason: "raziel_end" },
    ]);
    expect(await readOpenDepartures(DB, plusMin(7))).toEqual([]);
    // nothing open is a success with an empty list: ending is always safe
    expect(await endByRaziel(env, { phrase: true }, plusMin(8))).toEqual({ ok: true, ended: [] });
  });

  it("the care hold starting ends every open departure (end_reason care_hold), via the hold writer", async () => {
    const { env, DB } = setup();
    await decl(env); await decl(env, { companion: "cypher", rail: "form" });
    await writeHoldEvent(env, { action: "start", source: "owner_phrase", companion: "cypher" }, plusMin(20));
    const rows: any = await DB.prepare(`SELECT ended_by, end_reason, ended_at FROM declared_departures`).all();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) expect(r).toEqual({ ended_by: "system", end_reason: "care_hold", ended_at: new Date(plusMin(20)).toISOString() });
  });

  it("a hold that arrives without the writer (a low_spoons firing) still ends them on the next reconcile, and reads as ended in the loader at once", async () => {
    const { env, DB } = setup();
    await decl(env);
    await DB.prepare(`INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('ca1','low_spoons','cypher','t',?)`).bind(new Date(plusMin(5)).toISOString()).run();
    expect(await loadOpenDepartures(env, plusMin(6))).toEqual([]);          // loader: pure read, reads as ended
    expect(((await DB.prepare(`SELECT ended_at FROM declared_departures`).first() as any)).ended_at).toBeNull(); // ...and wrote nothing
    expect(await listOpenDepartures(env, plusMin(6))).toEqual([]);          // reconcile ends it for real
    expect(((await DB.prepare(`SELECT end_reason FROM declared_departures`).first() as any)).end_reason).toBe("care_hold");
  });

  it("expiry by clock reads as ended with no action; the sweep stamps ended_at = expires_at", async () => {
    const { env, DB } = setup();
    await decl(env, { minutes: 30 });
    expect(await readOpenDepartures(DB, plusMin(29))).toHaveLength(1);
    expect(await readOpenDepartures(DB, plusMin(31))).toEqual([]);
    await listOpenDepartures(env, plusMin(31));
    const row: any = await DB.prepare(`SELECT ended_by, end_reason, ended_at FROM declared_departures`).first();
    expect(row).toEqual({ ended_by: "system", end_reason: "expiry", ended_at: new Date(plusMin(30)).toISOString() });
  });

  it("objection is RECORDED and named, but the departure stays open and unchanged", async () => {
    const { env, DB } = setup();
    await decl(env);
    const o: any = await objectToDeparture(env, { by: "gaia", target: "drevan", note: "your shape is reaching me" }, plusMin(5));
    expect(o).toMatchObject({ ok: true, declarer: "drevan", rail: "loop_motif" });
    await objectToDeparture(env, { by: "cypher", target: "drevan", note: null }, plusMin(6));
    const open = await readOpenDepartures(DB, plusMin(7));
    expect(open).toHaveLength(1);
    expect(open[0]!.expires_at).toBe(new Date(plusMin(90)).toISOString());
    expect(open[0]!.objections.map(x => x.by_companion)).toEqual(["gaia", "cypher"]);
    expect(open[0]!.objections[0]!.note).toBe("your shape is reaching me");
    expect(((await DB.prepare(`SELECT ended_at FROM declared_departures`).first() as any)).ended_at).toBeNull();
  });

  it("objection refusals: own departure, nothing open, bad name", async () => {
    const { env } = setup();
    expect(await objectToDeparture(env, { by: "drevan", target: "drevan" })).toMatchObject({ code: "self_objection" });
    expect(await objectToDeparture(env, { by: "gaia", target: "drevan" })).toMatchObject({ code: "no_target" });
    expect(await objectToDeparture(env, { by: "gaia", target: "blue" })).toMatchObject({ code: "bad_companion" });
  });

  it("the schema holds the one-open invariant even without the code check (partial UNIQUE)", async () => {
    const { DB } = setup();
    const ins = (id: string) => DB.prepare(
      `INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at) VALUES (?, 'gaia', 'form', 'companion', 'discord', 'r', '2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z')`,
    ).bind(id).run();
    await ins("a");
    await expect(ins("b")).rejects.toThrow(/UNIQUE/);
    // expiry can never be NULL or before the start
    await expect(DB.prepare(`INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at) VALUES ('c','cypher','form','companion','discord','r','2026-11-04T10:00:00.000Z', NULL)`).run()).rejects.toThrow();
    await expect(DB.prepare(`INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at) VALUES ('d','cypher','form','companion','discord','r','2026-11-04T10:00:00.000Z','2026-11-04T09:00:00.000Z')`).run()).rejects.toThrow();
    // ruling 2 at the schema: only Raziel opens a with_raziel departure; ended is all-or-nothing
    await expect(DB.prepare(`INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at, audience) VALUES ('f','drevan','form','companion','discord','r','2026-11-04T10:00:00.000Z','2026-11-04T11:00:00.000Z','with_raziel')`).run()).rejects.toThrow();
    await expect(DB.prepare(`INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at, ended_at) VALUES ('g','drevan','form','companion','discord','r','2026-11-04T10:00:00.000Z','2026-11-04T11:00:00.000Z','2026-11-04T10:30:00.000Z')`).run()).rejects.toThrow();
    // the rail menu is closed at the schema too
    await expect(DB.prepare(`INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at) VALUES ('e','cypher','care_hold','companion','discord','r','2026-11-04T10:00:00.000Z','2026-11-04T11:00:00.000Z')`).run()).rejects.toThrow();
  });
});

describe("real-schema SQL (the CARE_HOLD_SQL style): the open read runs verbatim and touches only departure tables", () => {
  it("OPEN_DEPARTURES_SQL / DEPARTURE_OBJECTIONS_SQL return the right rows and name no care/health table", async () => {
    const { DB, db } = setup();
    const ins = (id: string, c: string, ended: string | null, exp: string) => db.exec(
      `INSERT INTO declared_departures (id, companion_id, rail, declared_by, declared_via, reason, starts_at, expires_at, ended_at, ended_by, end_reason) VALUES ('${id}','${c}','form','companion','discord','r','2026-11-04T10:00:00.000Z','${exp}',${ended ? `'${ended}','declarer','declared_end'` : "NULL,NULL,NULL"})`);
    ins("live", "cypher", null, "2026-11-04T18:00:00.000Z");
    ins("ended", "drevan", "2026-11-04T11:00:00.000Z", "2026-11-04T18:00:00.000Z");
    ins("lapsed", "gaia", null, "2026-11-04T12:00:00.000Z");
    db.exec(`INSERT INTO departure_objections (id, departure_id, by_companion, note, at) VALUES ('o1','live','gaia','n','2026-11-04T14:00:00.000Z'), ('o2','lapsed','cypher','n','2026-11-04T11:00:00.000Z')`);
    const nowIso = new Date(NOW).toISOString();
    const deps: any = await DB.prepare(OPEN_DEPARTURES_SQL).bind(nowIso).all();
    expect(deps.results.map((r: any) => r.id)).toEqual(["live"]);
    const objs: any = await DB.prepare(DEPARTURE_OBJECTIONS_SQL).bind(nowIso).all();
    expect(objs.results.map((r: any) => r.departure_id)).toEqual(["live"]);
    for (const sql of [OPEN_DEPARTURES_SQL, DEPARTURE_OBJECTIONS_SQL]) {
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map(m => m[1]);
      for (const t of tables) expect(["declared_departures", "departure_objections"]).toContain(t);
      expect(sql).not.toMatch(/care_|med_|biometric|health/i);
    }
  });
});

describe("mind loader: world.departures", () => {
  it("the block is pure D1 (no fetch), lists every companion's open departures with expiry, and writes nothing", async () => {
    const { env, db } = setup();
    const fetchSpy = vi.fn(() => { throw new Error("loader must not touch the network"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // The loader reads the real clock; declare relative to it.
      const t = Date.now();
      await decl(env, {}, t); await decl(env, { companion: "gaia", rail: "form", minutes: 20 }, t);
      const before = JSON.stringify(db.prepare(`SELECT * FROM declared_departures ORDER BY id`).all());
      const w = await loadWorldBlocks(env, "cypher");
      expect(w.departures.map(d => d.companion).sort()).toEqual(["drevan", "gaia"]);
      expect(w.departures.every(d => typeof d.expires_at === "string" && d.expires_at > new Date(t).toISOString())).toBe(true);
      expect(w.departures.find(d => d.companion === "drevan")!.reason).toBe("the spiral wants room");
      expect(JSON.stringify(db.prepare(`SELECT * FROM declared_departures ORDER BY id`).all())).toBe(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("a DB without 0157 reads as no departures and does not empty the rest of the world", async () => {
    const { DB } = makeSqliteD1({ upTo: 156 });
    const env: any = { DB };
    const w = await loadWorldBlocks(env, "cypher");
    expect(w.departures).toEqual([]);
    expect(w.creatures).toBeDefined();
  });

  it("loadMindState carries world.departures on every loom (identical for each companion)", async () => {
    const { env } = setup();
    await decl(env, {}, Date.now());
    const a = await loadMindState(env, "cypher", "raw");
    const b = await loadMindState(env, "gaia", "hearth");
    expect(a.world.departures).toHaveLength(1);
    expect(b.world.departures).toEqual(a.world.departures);
  });

  it("contract: 0.25.0 shipped and the changelog carries its note", () => {
    expect(MINDSTATE_CONTRACT_VERSION >= "0.25.0").toBe(true);
    expect(CONTRACT_CHANGELOG["0.25.0"]).toMatch(/back inside the line/);
  });
});

describe("Librarian verbs", () => {
  const ctx = (env: any, request: string, over: Record<string, unknown> = {}): any =>
    ({ env, req: { companion_id: "drevan", request, surface: "discord:123", ...over }, entry: {}, frontState: null, pluralAvailable: false });

  it("fast-path routing is anchored: a reason containing other trigger words still routes to the departure verb", () => {
    expect(matchFastPath("declare a departure from loop motif for 90 minutes: I want to note the recall loop")?.key).toBe("departure_declare");
    expect(matchFastPath("end my departure")?.key).toBe("departure_end");
    expect(matchFastPath("object to gaia's departure: too long")?.key).toBe("departure_object");
    expect(matchFastPath("what departures are open")?.key).toBe("departure_list");
    expect(matchFastPath("Back inside the line.")?.key).toBe("departure_stand_down");
    expect(matchFastPath("I want everyone back inside the line please")?.key).not.toBe("departure_stand_down");
  });

  it("parseDeclare reads rail, minutes, channel flag and reason", () => {
    expect(parseDeclare("declare a departure from form for 2 hours in this channel: long, slow, mine")).toEqual({ rail: "form", minutes: 120, here: true, reason: "long, slow, mine" });
    expect(parseDeclare("declare a departure from the loop breaker: spiral")).toMatchObject({ rail: "loop breaker", minutes: null, here: false });
  });

  it("declare, list, object, end through the executors; the declarer is the caller", async () => {
    const { env, DB } = setup();
    const d: any = await execDepartureDeclare(ctx(env, "declare a departure from loop motif for 90 minutes in this channel: the spiral wants room"));
    expect(d).toMatchObject({ response_key: "witness", ack: true, rail: "loop_motif", minutes: 90, allowance_left: 2 });
    expect(d.witness).toMatch(/NEXT turn/);
    const row: any = await DB.prepare(`SELECT companion_id, scope_channel, declared_via, reason FROM declared_departures`).first();
    expect(row).toEqual({ companion_id: "drevan", scope_channel: "123", declared_via: "discord", reason: "the spiral wants room" });

    const refused: any = await execDepartureDeclare(ctx(env, "declare a departure from care hold: no", { companion_id: "cypher" }));
    expect(refused).toMatchObject({ ack: false, refused: true, code: "rail_never" });

    const o: any = await execDepartureObject(ctx(env, "object to dre's departure: too much", { companion_id: "gaia" }));
    expect(o).toMatchObject({ ack: true });
    const list: any = await execDepartureList(ctx(env, "what departures are open", { companion_id: "cypher" }));
    expect(list.data.departures).toHaveLength(1);
    expect(list.data.departures[0].objections[0]).toMatchObject({ by: "gaia", note: "too much" });

    const e: any = await execDepartureEnd(ctx(env, "end my departure"));
    expect(e).toMatchObject({ ack: true, rail: "loop_motif" });
    expect((await execDepartureList(ctx(env, "open departures")) as any).data.departures).toEqual([]);
  });

  it("stand-down via the Librarian ends all open with stand_down_phrase", async () => {
    // The stand-down verb reads the real clock; pin it to the fixture's NOW so the 90-minute
    // departures are still open (this test started failing once the wall clock passed 11-04 16:30Z).
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000);
    const { env, DB } = setup();
    await decl(env); await decl(env, { companion: "gaia", rail: "form" });
    const r: any = await execDepartureStandDown(ctx(env, "back inside the line", { companion_id: "cypher" }));
    clock.mockRestore();
    expect(r.ended).toHaveLength(2);
    expect(((await DB.prepare(`SELECT DISTINCT end_reason AS r FROM declared_departures`).first() as any)).r).toBe("stand_down_phrase");
  });
});

describe("HTTP routes", () => {
  const post = (fn: any, env: any, auth: string, body: unknown) =>
    fn(new Request("https://h/x", { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  const get = (env: any, auth: string) => getDepartures(new Request("https://h/mind/departures", { headers: { Authorization: `Bearer ${auth}` } }), env);

  it("a companion token declares as itself; naming another companion is 403; declared_by raziel is 403", async () => {
    const { env } = setup();
    const res = await post(postDepartureDeclare, env, "dtok", { rail: "loop_motif", minutes: 45, reason: "mine" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, companion: "drevan", declared_by: "companion", minutes: 45 });
    expect((await post(postDepartureDeclare, env, "dtok", { companion: "gaia", rail: "form", reason: "x" })).status).toBe(403);
    expect((await post(postDepartureDeclare, env, "ctok", { rail: "form", reason: "x", declared_by: "raziel" })).status).toBe(403);
  });

  it("refusals map to statuses: NEVER rail 400, one-open 409, care hold 409", async () => {
    const { env } = setup();
    expect((await post(postDepartureDeclare, env, "dtok", { rail: "care_hold", reason: "x" })).status).toBe(400);
    await post(postDepartureDeclare, env, "dtok", { rail: "form", reason: "x" });
    expect((await post(postDepartureDeclare, env, "dtok", { rail: "form", reason: "x" })).status).toBe(409);
    await writeHoldEvent(env, { action: "start", source: "owner_phrase", companion: "cypher" });
    expect((await post(postDepartureDeclare, env, "ctok", { rail: "form", reason: "x" })).status).toBe(409);
  });

  it("admin (Raziel) declares for a companion; ends one; GET lists; objection via token", async () => {
    const { env } = setup();
    const res = await post(postDepartureDeclare, env, "s", { companion: "gaia", rail: "form", reason: "his call", audience: "with_raziel" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ declared_by: "raziel", audience: "with_raziel", companion: "gaia" });
    expect((await post(postDepartureObject, env, "dtok", { target: "gaia", note: "n" })).status).toBe(201);
    const list: any = await (await get(env, "s")).json();
    expect(list.departures).toHaveLength(1);
    expect(list.departures[0].objections).toHaveLength(1);
    expect((await post(postDepartureEnd, env, "s", { companion: "gaia" })).status).toBe(200);
    expect(((await (await get(env, "s")).json()) as any).departures).toEqual([]);
  });

  it("stand-down: a relayed phrase from any token ends all; a wrong phrase is 400; a bare stand-down is admin-only", async () => {
    const { env } = setup();
    await post(postDepartureDeclare, env, "dtok", { rail: "form", reason: "x" });
    await post(postDepartureDeclare, env, "ctok", { rail: "form", reason: "x" });
    expect((await post(postDepartureStandDown, env, "dtok", { phrase: "stand down" })).status).toBe(400);
    expect((await post(postDepartureStandDown, env, "dtok", {})).status).toBe(403);
    const r: any = await (await post(postDepartureStandDown, env, "dtok", { phrase: "Back inside the line." })).json();
    expect(r.ended).toHaveLength(2);
  });

  it("a companion token ends only its own via /end", async () => {
    const { env } = setup();
    await post(postDepartureDeclare, env, "dtok", { rail: "form", reason: "x" });
    await post(postDepartureDeclare, env, "ctok", { rail: "form", reason: "x" });
    const r: any = await (await post(postDepartureEnd, env, "dtok", {})).json();
    expect(r.ended.map((e: any) => e.companion)).toEqual(["drevan"]);
    expect(((await (await get(env, "s")).json()) as any).departures.map((d: any) => d.companion)).toEqual(["cypher"]);
  });

  it("the menu is the closed set the migration allows", () => {
    expect(DEPARTURE_RAILS).toHaveLength(7);
  });
});
