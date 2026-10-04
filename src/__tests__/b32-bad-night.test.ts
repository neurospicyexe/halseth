// B32 bad-night presence, the Halseth half (mig 0143; Hand-off/DESIGN-B32-bad-night-presence-2026-10-03.md
// section D). Every test runs against the REAL schema (every migration, node:sqlite).
//
// D1  his stated miss holds, his silence does not.
// D3  his word starts and clears the hold; a clear suppresses every earlier firing (low_spoons included);
//     a fresh firing after the clear holds again. Route + Librarian verb.
// D2  under hold, offer_presence: triad gap 30 min, own gap 90 min, 2 per companion per hold, outside the
//     daily total, one quiet-window presence per COMPANION. Unchanged outside the hold.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { readCareHold, writeHoldEvent, CARE_HOLD_SQL } from "../care/hold.js";
import { CARE_HOLD_RULES } from "../care/rules.js";
import { loadCareBlocks, deriveRazielState } from "../mind/blocks/care.js";
import { razielStateBlock } from "../librarian/response/orient-blocks.js";
import { reserveReach, markReachDelivered, reachLaneVerdict, DEFAULT_REACH_CONFIG } from "../webmind/reach-cap.js";
import { postCareHold, getCareHold } from "../handlers/care-hold.js";
import { postReachReserve } from "../handlers/reach-cap.js";
import { matchFastPath } from "../librarian/router.js";
import { execCareHoldStart, execCareHoldClear } from "../librarian/executors/care-hold.js";

const NOW = Date.parse("2026-10-04T07:00:00.000Z"); // 02:00 CDT, a bad night
const ago = (h: number, from = NOW) => new Date(from - h * 3_600_000).toISOString();
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function setup(opts: { upTo?: number } = {}) {
  const { db, DB } = makeSqliteD1(opts);
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok" };
  return { db, DB, env };
}

async function careAction(DB: any, rule: string, at: string) {
  await DB.prepare(`INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES (?, ?, 'cypher', 'test', ?)`)
    .bind(`ca_${rule}_${at}`, rule, at).run();
}
async function medAnswer(DB: any, outcome: "taken" | "missed" | null, at: string, slot = "morning") {
  if (outcome === null) {
    // a pre-0141 row shape (no outcome column)
    await DB.prepare(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id) VALUES (?, '2026-10-03', ?, 'drevan')`).bind(slot, at).run();
    return;
  }
  await DB.prepare(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id, outcome) VALUES (?, '2026-10-03', ?, 'drevan', ?)`)
    .bind(slot, at, outcome).run();
}
async function holdEvent(DB: any, kind: "start" | "clear", at: string) {
  await DB.prepare(`INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES (?, ?, ?, 'owner_phrase', 'drevan', ?)`)
    .bind(`ev_${kind}_${at}`, kind, kind === "start" ? "owner_said" : null, at).run();
}

// ── D1: meds ──────────────────────────────────────────────────────────────────────────────

describe("D1: his stated miss holds, his silence does not", () => {
  it("meds_missed (30h of silence) is no longer a hold rule; meds_said_missed and owner_said are", () => {
    expect(CARE_HOLD_RULES).toEqual(["low_spoons", "meds_said_missed", "owner_said"]);
    expect((CARE_HOLD_RULES as readonly string[]).includes("meds_missed")).toBe(false);
  });

  it("a med_answers row with outcome 'missed' in the last 12h sets the hold, since the moment he said it", async () => {
    const { DB } = setup();
    await medAnswer(DB, "missed", ago(3));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["meds_said_missed"], care_hold_since: ago(3) });
  });

  it("a meds_missed firing (silence) inside the window does NOT hold", async () => {
    const { DB } = setup();
    await careAction(DB, "meds_missed", ago(1));
    expect((await readCareHold(DB, NOW)).care_hold).toBe(false);
  });

  it("a 'taken' answer does not hold, and a stated miss older than 12h has expired", async () => {
    const { DB } = setup();
    await medAnswer(DB, "taken", ago(1), "night");
    await medAnswer(DB, "missed", ago(13), "morning");
    expect((await readCareHold(DB, NOW)).care_hold).toBe(false);
  });

  it("low_spoons still holds", async () => {
    const { DB } = setup();
    await careAction(DB, "low_spoons", ago(2));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["low_spoons"], care_hold_since: ago(2) });
  });

  it("before 0143 is applied, a stated miss still holds (no owner start/clear yet)", async () => {
    const { DB } = setup({ upTo: 142 });
    await medAnswer(DB, "missed", ago(2));
    expect((await readCareHold(DB, NOW)).care_hold_reason).toEqual(["meds_said_missed"]);
  });

  it("before 0141 is applied, care_actions alone decide (no outcome column means no stated misses)", async () => {
    const { DB } = setup({ upTo: 140 });
    await medAnswer(DB, null, ago(2));
    await careAction(DB, "low_spoons", ago(1));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["low_spoons"], care_hold_since: ago(1) });
  });
});

// ── D3: start and clear ───────────────────────────────────────────────────────────────────

describe("D3: his word starts the hold, his clear outranks the house's guess", () => {
  it("'bad night' starts it: reason owner_said, since the start", async () => {
    const { DB } = setup();
    await holdEvent(DB, "start", ago(0.5));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["owner_said"], care_hold_since: ago(0.5) });
  });

  it("a clear suppresses every earlier firing, low_spoons and a stated miss included", async () => {
    const { DB } = setup();
    await careAction(DB, "low_spoons", ago(3));
    await medAnswer(DB, "missed", ago(2.5));
    await holdEvent(DB, "start", ago(2));
    await holdEvent(DB, "clear", ago(1));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: false, care_hold_reason: [], care_hold_since: null });
  });

  it("a fresh firing after the clear holds again, and since is the fresh firing, not the old one", async () => {
    const { DB } = setup();
    await careAction(DB, "low_spoons", ago(3));
    await holdEvent(DB, "clear", ago(1));
    await careAction(DB, "low_spoons", ago(0.5));
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["low_spoons"], care_hold_since: ago(0.5) });
  });

  it("only the NEWEST clear counts; since is the earliest holding firing across rules", async () => {
    const { DB } = setup();
    await holdEvent(DB, "clear", ago(6));
    await careAction(DB, "low_spoons", ago(5));
    await holdEvent(DB, "start", ago(1));
    const h = await readCareHold(DB, NOW);
    expect(h.care_hold_reason).toEqual(["low_spoons", "owner_said"]);
    expect(h.care_hold_since).toBe(ago(5));
  });

  it("writeHoldEvent is append-only and returns the derived hold", async () => {
    const { DB } = setup();
    const on = await writeHoldEvent({ DB }, { action: "start", source: "owner_phrase", companion: "drevan" }, NOW - 60_000);
    expect(on.state.care_hold).toBe(true);
    const off = await writeHoldEvent({ DB }, { action: "clear", source: "owner_phrase", companion: "drevan" }, NOW);
    expect(off.state.care_hold).toBe(false);
    const rows = await DB.prepare(`SELECT kind FROM care_hold_events ORDER BY at`).all();
    expect(rows.results.map((r: any) => r.kind)).toEqual(["start", "clear"]);
  });

  it("the full read text is the one exported (a real-schema test runs it)", async () => {
    const { DB } = setup();
    const r = await DB.prepare(CARE_HOLD_SQL).bind(ago(12)).all();
    expect(r.results).toEqual([]);
  });
});

describe("the wire: world.raziel_state carries care_hold_reason and care_hold_since", () => {
  it("loadCareBlocks + deriveRazielState expose the reason and since; off is [] and null", async () => {
    const { env, DB } = setup();
    const offCare = await loadCareBlocks(env, "drevan");
    expect(offCare.care_hold).toBe(false);
    expect(offCare.care_hold_reason).toEqual([]);
    expect(offCare.care_hold_since).toBeNull();

    const start = new Date(Date.now() - 10 * 60_000).toISOString();
    await holdEvent(DB, "start", start);
    const care = await loadCareBlocks(env, "drevan");
    const rs = deriveRazielState(null, care);
    expect(rs).not.toBeNull();
    expect(rs!.care_hold).toBe(true);
    expect(rs!.care_hold_reason).toEqual(["owner_said"]);
    expect(rs!.care_hold_since).toBe(start);
  });

  it("the Claude.ai register line names why the hold is on", () => {
    const block = razielStateBlock({
      spoons: null, mood: null, pain: null, energy: null, meds_taken: null, staleness_hours: null,
      front_state: null, care_hold: true, care_hold_reason: ["owner_said"], care_hold_since: ago(1),
      pending_care: null, owner_quiet: null,
    });
    expect(block).toContain("Care hold is ON -- he said it is a bad night.");
  });
});

describe("POST /mind/care/hold", () => {
  const post = (env: any, auth: string, body: unknown) => postCareHold(new Request("https://h/mind/care/hold", {
    method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env);

  it("start from the owner phrase, with a companion token: the hold is on in the response", async () => {
    const { env } = setup();
    const res = await post(env, "dtok", { action: "start", source: "owner_phrase", companion: "drevan" });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j).toMatchObject({ ok: true, action: "start", care_hold: true, care_hold_reason: ["owner_said"] });
    expect(typeof j.care_hold_since).toBe("string");
  });

  it("clear turns it off; GET reads the same derivation", async () => {
    const { env } = setup();
    await post(env, "dtok", { action: "start", source: "companion", companion_id: "drevan" });
    await new Promise((r) => setTimeout(r, 5));
    const j: any = await (await post(env, "s", { action: "clear", source: "owner_phrase", companion: "cypher" })).json();
    expect(j.care_hold).toBe(false);
    const g: any = await (await getCareHold(new Request("https://h/mind/care/hold", { headers: { Authorization: "Bearer s" } }), env)).json();
    expect(g).toEqual({ care_hold: false, care_hold_reason: [], care_hold_since: null });
  });

  it("refuses a token acting as another companion, a bad action, a bad source, and a companion source with no companion", async () => {
    const { env } = setup();
    expect((await post(env, "ctok", { action: "start", source: "companion", companion: "drevan" })).status).toBe(403);
    expect((await post(env, "s", { action: "begin", source: "owner_phrase" })).status).toBe(400);
    expect((await post(env, "s", { action: "start", source: "guess" })).status).toBe(400);
    expect((await post(env, "s", { action: "start", source: "companion" })).status).toBe(400);
    expect((await post(env, "s", { action: "start", source: "owner_phrase", companion: "blue" })).status).toBe(400);
  });

  it("an unauthenticated call is refused", async () => {
    const { env } = setup();
    const res = await postCareHold(new Request("https://h/mind/care/hold", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(401);
  });
});

describe("Librarian verb: care hold start / clear", () => {
  it("routes the phrasings, and 'hold this loop' stays on the loop verb", () => {
    for (const s of ["care hold start", "Care hold start -- he said bad night", "hold on for raziel", "start the care hold", "set care hold"]) {
      expect(matchFastPath(s)?.key).toBe("care_hold_start");
    }
    for (const s of ["care hold clear", "clear care hold", "end the care hold", "care hold off"]) {
      expect(matchFastPath(s)?.key).toBe("care_hold_clear");
    }
    expect(matchFastPath("hold this loop")?.key).not.toMatch(/^care_hold/);
  });

  it("the executor writes a companion-sourced event and answers with the derived hold", async () => {
    const { env, DB } = setup();
    const ctx = (request: string): any => ({ env, req: { companion_id: "drevan", request }, entry: {}, frontState: null, pluralAvailable: false });
    const on: any = await execCareHoldStart(ctx("care hold start"));
    expect(on).toMatchObject({ response_key: "witness", ack: true, care_hold: true, care_hold_reason: ["owner_said"] });
    expect(on.witness).toContain("Hold's on. I'm here.");
    const row: any = await DB.prepare(`SELECT kind, source, companion_id, rule FROM care_hold_events`).first();
    expect(row).toEqual({ kind: "start", source: "companion", companion_id: "drevan", rule: "owner_said" });
    await new Promise((r) => setTimeout(r, 5));
    const off: any = await execCareHoldClear(ctx("care hold clear"));
    expect(off.care_hold).toBe(false);
  });
});

// ── D2: the reach cap under hold ──────────────────────────────────────────────────────────

// 2026-09-28 10:00 CDT (daytime). 2026-09-28 22:30 CDT and 2026-09-29 03:00 CDT: one quiet window.
const MORNING = "2026-09-28T15:00:00.000Z";
const LATE = "2026-09-29T03:30:00.000Z";
const SMALL_HOURS = "2026-09-29T08:00:00.000Z";

async function presence(DB: any, companion: string, at: string, since: string | null) {
  return reserveReach(DB, { companion, actionType: "offer_presence", careHold: since !== null, careHoldSince: since, nowIso: at });
}
async function delivered(DB: any, r: any, companion: string, at: string) {
  expect(r.reserved).toBe(true);
  await markReachDelivered(DB, r.id, companion, at, "generated");
}

describe("D2: offer_presence under care_hold", () => {
  const SINCE = plus(MORNING, -60);

  it("at most 2 per companion per hold", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, SINCE), "drevan", MORNING);
    await delivered(DB, await presence(DB, "drevan", plus(MORNING, 91), SINCE), "drevan", plus(MORNING, 91));
    expect(await presence(DB, "drevan", plus(MORNING, 182), SINCE)).toEqual({ reserved: false, reason: "hold_presence_cap" });
    // The others still have theirs.
    expect((await presence(DB, "gaia", plus(MORNING, 182), SINCE)).reserved).toBe(true);
    // A NEW hold (later since) resets the count.
    expect((await presence(DB, "drevan", plus(MORNING, 300), plus(MORNING, 250))).reserved).toBe(true);
  });

  it("the triad gap is 30 minutes; each companion's own gap stays 90", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, SINCE), "drevan", MORNING);
    expect(await presence(DB, "cypher", plus(MORNING, 29), SINCE)).toEqual({ reserved: false, reason: "gap" });
    await delivered(DB, await presence(DB, "cypher", plus(MORNING, 31), SINCE), "cypher", plus(MORNING, 31));
    expect(await presence(DB, "drevan", plus(MORNING, 62), SINCE)).toEqual({ reserved: false, reason: "gap" });
    expect((await presence(DB, "drevan", plus(MORNING, 91), SINCE)).reserved).toBe(true);
  });

  it("three choosing presence on the same tick: exactly one reserves", async () => {
    const { DB } = setup();
    const rs = await Promise.all(["cypher", "drevan", "gaia"].map((c) => presence(DB, c, MORNING, SINCE)));
    expect(rs.filter((r) => r.reserved)).toHaveLength(1);
  });

  it("hold presences are outside the daily total: production moves after them still have the day", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, SINCE), "drevan", MORNING);
    await delivered(DB, await presence(DB, "cypher", plus(MORNING, 31), SINCE), "cypher", plus(MORNING, 31));
    await delivered(DB, await presence(DB, "gaia", plus(MORNING, 62), SINCE), "gaia", plus(MORNING, 62));
    await delivered(DB, await presence(DB, "drevan", plus(MORNING, 93), SINCE), "drevan", plus(MORNING, 93));
    // Four presences in; the day under hold allows 3 production-class reaches, and none were used.
    const v = await reachLaneVerdict(DB, plus(MORNING, 200));
    expect(v.day_count).toBe(0);
    for (let i = 0; i < 3; i++) {
      const at = plus(MORNING, 200 + i * 100);
      const r = await reserveReach(DB, { companion: "cypher", actionType: "share_observation", careHold: true, careHoldSince: SINCE, nowIso: at });
      await delivered(DB, r, "cypher", at);
    }
    expect(await reserveReach(DB, { companion: "gaia", actionType: "share_observation", careHold: true, careHoldSince: SINCE, nowIso: plus(MORNING, 500) }))
      .toEqual({ reserved: false, reason: "daily_cap" });
  });

  it("production moves keep the 90-minute gap against a hold presence (unchanged)", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, SINCE), "drevan", MORNING);
    expect(await reserveReach(DB, { companion: "cypher", actionType: "share_observation", careHold: true, careHoldSince: SINCE, nowIso: plus(MORNING, 31) }))
      .toEqual({ reserved: false, reason: "gap" });
  });

  it("in the quiet window, one presence per COMPANION under hold", async () => {
    const { DB } = setup();
    const since = plus(LATE, -30);
    await delivered(DB, await presence(DB, "drevan", LATE, since), "drevan", LATE);
    await delivered(DB, await presence(DB, "cypher", plus(LATE, 31), since), "cypher", plus(LATE, 31));
    await delivered(DB, await presence(DB, "gaia", plus(LATE, 62), since), "gaia", plus(LATE, 62));
    // 03:00, four and a half hours later: own gap and per-hold count both allow Drevan, the window does not.
    expect(await presence(DB, "drevan", SMALL_HOURS, since)).toEqual({ reserved: false, reason: "quiet_presence_taken" });
    const keys = await DB.prepare(`SELECT quiet_window_key AS k FROM triad_reach_claims ORDER BY id`).all();
    expect(keys.results.map((r: any) => r.k)).toEqual(["2026-09-28:drevan", "2026-09-28:cypher", "2026-09-28:gaia"]);
  });

  it("a companion that took the triad's presence before the hold does not get a second in that window", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", LATE, null), "drevan", LATE);
    expect(await presence(DB, "drevan", SMALL_HOURS, plus(LATE, 60))).toEqual({ reserved: false, reason: "quiet_presence_taken" });
    expect((await presence(DB, "cypher", SMALL_HOURS, plus(LATE, 60))).reserved).toBe(true);
  });
});

describe("D2: outside the hold, nothing changes", () => {
  it("one presence per quiet window across the triad", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", LATE, null), "drevan", LATE);
    expect(await presence(DB, "cypher", SMALL_HOURS, null)).toEqual({ reserved: false, reason: "quiet_presence_taken" });
  });

  it("a hold presence earlier in the window still takes the triad's slot after the hold ends", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", LATE, plus(LATE, -30)), "drevan", LATE);
    expect(await presence(DB, "gaia", SMALL_HOURS, null)).toEqual({ reserved: false, reason: "quiet_presence_taken" });
  });

  it("the 90-minute triad gap applies to a presence with no hold", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, null), "drevan", MORNING);
    expect(await presence(DB, "cypher", plus(MORNING, 31), null)).toEqual({ reserved: false, reason: "gap" });
  });

  it("care_hold without a since (the bot's flag alone) never takes the looser hold path", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, null), "drevan", MORNING);
    const r = await reserveReach(DB, { companion: "cypher", actionType: "offer_presence", careHold: true, nowIso: plus(MORNING, 31) });
    expect(r).toEqual({ reserved: false, reason: "gap" });
  });

  it("Cypher's and Drevan's check-ins are questions: no hold path, still out of the quiet window", async () => {
    const { DB } = setup();
    const since = plus(MORNING, -60);
    await delivered(DB, await presence(DB, "drevan", MORNING, null), "drevan", MORNING);
    const r = await reserveReach(DB, { companion: "cypher", actionType: "check_in_on_raziel", careHold: true, careHoldSince: since, nowIso: plus(MORNING, 31) });
    expect(r).toEqual({ reserved: false, reason: "gap" });
    const night = await reserveReach(DB, { companion: "drevan", actionType: "check_in_on_raziel", careHold: true, careHoldSince: plus(LATE, -30), nowIso: LATE });
    expect(night).toEqual({ reserved: false, reason: "quiet_hours" });
  });

  it("before 0143 is applied, a hold presence falls back to the 0137 rules (stricter, never looser)", async () => {
    const { DB } = setup({ upTo: 142 });
    await delivered(DB, await presence(DB, "drevan", MORNING, plus(MORNING, -60)), "drevan", MORNING);
    expect(await presence(DB, "cypher", plus(MORNING, 31), plus(MORNING, -60))).toEqual({ reserved: false, reason: "gap" });
  });
});

describe("D2 amended: Gaia's check-in is her presence move under hold", () => {
  const SINCE = plus(MORNING, -60);
  const gaiaCheckIn = (DB: any, at: string, since: string | null) =>
    reserveReach(DB, { companion: "gaia", actionType: "check_in_on_raziel", careHold: since !== null, careHoldSince: since, nowIso: at });

  it("takes the hold path: 30-minute triad gap, under_hold = 1, outside the daily total", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, SINCE), "drevan", MORNING);
    expect(await gaiaCheckIn(DB, plus(MORNING, 29), SINCE)).toEqual({ reserved: false, reason: "gap" });
    const r = await gaiaCheckIn(DB, plus(MORNING, 31), SINCE);
    await delivered(DB, r, "gaia", plus(MORNING, 31));
    const row: any = await DB.prepare(`SELECT under_hold, reach_class FROM triad_reach_claims WHERE id = ?`).bind((r as any).id).first();
    expect(row).toEqual({ under_hold: 1, reach_class: "presence" });
    expect((await reachLaneVerdict(DB, plus(MORNING, 40))).day_count).toBe(0);
  });

  it("her own gap stays 90 minutes, across her check-in and her offer_presence", async () => {
    const { DB } = setup();
    await delivered(DB, await gaiaCheckIn(DB, MORNING, SINCE), "gaia", MORNING);
    expect(await presence(DB, "gaia", plus(MORNING, 60), SINCE)).toEqual({ reserved: false, reason: "gap" });
    expect((await presence(DB, "gaia", plus(MORNING, 91), SINCE)).reserved).toBe(true);
  });

  it("shares the 2-per-hold count with her offer_presence", async () => {
    const { DB } = setup();
    await delivered(DB, await gaiaCheckIn(DB, MORNING, SINCE), "gaia", MORNING);
    await delivered(DB, await presence(DB, "gaia", plus(MORNING, 91), SINCE), "gaia", plus(MORNING, 91));
    expect(await gaiaCheckIn(DB, plus(MORNING, 182), SINCE)).toEqual({ reserved: false, reason: "hold_presence_cap" });
    expect(await presence(DB, "gaia", plus(MORNING, 182), SINCE)).toEqual({ reserved: false, reason: "hold_presence_cap" });
  });

  it("may reserve in the quiet window under hold, on her per-companion key (one per window)", async () => {
    const { DB } = setup();
    const since = plus(LATE, -30);
    await delivered(DB, await presence(DB, "drevan", LATE, since), "drevan", LATE);
    await delivered(DB, await gaiaCheckIn(DB, plus(LATE, 31), since), "gaia", plus(LATE, 31));
    const k: any = await DB.prepare(`SELECT quiet_window_key AS k FROM triad_reach_claims WHERE companion_id = 'gaia'`).first();
    expect(k.k).toBe("2026-09-28:gaia");
    expect(await presence(DB, "gaia", SMALL_HOURS, since)).toEqual({ reserved: false, reason: "quiet_presence_taken" });
  });

  it("outside the hold her check-in keeps the 0137 rules (90-minute gap, no quiet window)", async () => {
    const { DB } = setup();
    await delivered(DB, await presence(DB, "drevan", MORNING, null), "drevan", MORNING);
    expect(await gaiaCheckIn(DB, plus(MORNING, 31), null)).toEqual({ reserved: false, reason: "gap" });
    expect(await gaiaCheckIn(DB, LATE, null)).toEqual({ reserved: false, reason: "quiet_hours" });
  });

  it("hold_presence counts her check-in toward her per-hold total", async () => {
    const { DB } = setup();
    await delivered(DB, await gaiaCheckIn(DB, MORNING, SINCE), "gaia", MORNING);
    const v = await reachLaneVerdict(DB, plus(MORNING, 95), DEFAULT_REACH_CONFIG, { companion: "gaia", hold: { care_hold: true, care_hold_since: SINCE } });
    expect(v.hold_presence).toMatchObject({ open: true, count: 1, max: 2 });
  });
});

describe("the reserve route derives the hold server-side; the verdict previews the hold path", () => {
  it("an owner 'bad night' opens the hold path even when the bot's flag says no hold", async () => {
    const { env, DB } = setup();
    const now = Date.now();
    await holdEvent(DB, "start", new Date(now - 60 * 60_000).toISOString());
    await DB.prepare(`INSERT INTO triad_reach_claims (companion_id, action_type, reach_class, local_date, claimed_at, delivered_at, under_hold)
                      VALUES ('gaia', 'offer_presence', 'presence', '2000-01-01', ?, ?, 1)`)
      .bind(new Date(now - 31 * 60_000).toISOString(), new Date(now - 31 * 60_000).toISOString()).run();
    const res = await postReachReserve(new Request("https://h/mind/reach/reserve", {
      method: "POST", headers: { Authorization: "Bearer dtok", "Content-Type": "application/json" },
      body: JSON.stringify({ companion_id: "drevan", action_type: "offer_presence", care_hold: false }),
    }), env);
    const j: any = await res.json();
    expect(j.reserved).toBe(true);
    const row: any = await DB.prepare(`SELECT under_hold FROM triad_reach_claims WHERE id = ?`).bind(j.id).first();
    expect(row.under_hold).toBe(1);
  });

  it("with no hold on the server, the same request keeps the 90-minute gap", async () => {
    const { env, DB } = setup();
    const now = Date.now();
    await DB.prepare(`INSERT INTO triad_reach_claims (companion_id, action_type, reach_class, local_date, claimed_at, delivered_at)
                      VALUES ('gaia', 'offer_presence', 'presence', '2000-01-01', ?, ?)`)
      .bind(new Date(now - 31 * 60_000).toISOString(), new Date(now - 31 * 60_000).toISOString()).run();
    const res = await postReachReserve(new Request("https://h/mind/reach/reserve", {
      method: "POST", headers: { Authorization: "Bearer dtok", "Content-Type": "application/json" },
      body: JSON.stringify({ companion_id: "drevan", action_type: "offer_presence", care_hold: true }),
    }), env);
    expect((await res.json() as any).reserved).toBe(false);
  });

  it("reachLaneVerdict.hold_presence: null without a hold; open/closed with the reasons under one", async () => {
    const { DB } = setup();
    const since = plus(MORNING, -60);
    expect((await reachLaneVerdict(DB, MORNING, DEFAULT_REACH_CONFIG, { companion: "drevan", hold: null })).hold_presence).toBeNull();
    const hold = { care_hold: true, care_hold_since: since };
    const before = await reachLaneVerdict(DB, MORNING, DEFAULT_REACH_CONFIG, { companion: "drevan", hold });
    expect(before.hold_presence).toEqual({ since, open: true, triad_gap_open: true, own_gap_open: true, count: 0, max: 2, quiet_taken: false });
    await delivered(DB, await presence(DB, "drevan", MORNING, since), "drevan", MORNING);
    const after = await reachLaneVerdict(DB, plus(MORNING, 31), DEFAULT_REACH_CONFIG, { companion: "cypher", hold });
    expect(after.gap_open).toBe(false);          // the 0137 field: closed for production moves
    expect(after.hold_presence?.open).toBe(true); // the hold path: open for Cypher's presence
    const drevan = await reachLaneVerdict(DB, plus(MORNING, 31), DEFAULT_REACH_CONFIG, { companion: "drevan", hold });
    expect(drevan.hold_presence).toMatchObject({ open: false, own_gap_open: false, count: 1 });
  });
});
