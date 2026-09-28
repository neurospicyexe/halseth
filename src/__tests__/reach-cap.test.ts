// The shared triad reach cap (mig 0137) against the REAL schema (every migration, node:sqlite).
//
// Covers: atomic reservation under a race (two claimers, one slot), the 90-minute gap ACROSS
// companions, the daily total and the lower care_hold total, the care ceiling (and that presence
// and own moves are outside it), quiet hours letting only presence reserve, one presence per quiet
// window across the whole triad (22:30 and 03:00 are the same window), release and stale takeover,
// med_reminder staying outside the cap entirely (R-9), the lane verdict on the eligible response,
// move ownership (flirt is Drevan's only), and route auth.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  reserveReach, markReachDelivered, releaseReach, reachLaneVerdict, quietWindowKey, reachClassOf,
  DEFAULT_REACH_CONFIG, reachConfigFrom, TRIAD_REACH_STALE_MINUTES,
} from "../webmind/reach-cap.js";
import { claimDose } from "../webmind/med-reminder.js";
import { ownsMove, isValidActionType } from "../webmind/metronome.js";
import { postReachReserve } from "../handlers/reach-cap.js";
import { getMindMetronomeEligibleActions, postMindMetronomeAction } from "../handlers/webmind.js";

const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

// 2026-09-28 (Monday) 10:00 CDT = 15:00Z. Daytime, outside quiet hours.
const MORNING = "2026-09-28T15:00:00.000Z";
// 2026-09-28 22:30 CDT = 2026-09-29T03:30Z; 2026-09-29 03:00 CDT = 08:00Z. Same quiet window.
const LATE = "2026-09-29T03:30:00.000Z";
const SMALL_HOURS = "2026-09-29T08:00:00.000Z";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok" };
  return { db, DB, env };
}

async function sent(DB: any, companion: string, actionType: string, at: string, careHold = false) {
  const r = await reserveReach(DB, { companion, actionType, careHold, nowIso: at });
  expect(r.reserved).toBe(true);
  if (r.reserved) expect(await markReachDelivered(DB, r.id, companion, at, "generated")).toBe(true);
  return r;
}

describe("reservation is atomic: two claimers, one slot", () => {
  it("two bots racing in the same second: exactly one reserves", async () => {
    const { DB } = setup();
    const [a, b] = await Promise.all([
      reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: MORNING }),
      reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: MORNING }),
    ]);
    expect([a.reserved, b.reserved].filter(Boolean)).toHaveLength(1);
    const loser = a.reserved ? b : a;
    expect(loser.reserved === false && loser.reason).toBe("gap");
  });

  it("the last slot of the day goes to one of three racers, never two", async () => {
    const { DB } = setup();
    const start = "2026-09-28T11:00:00.000Z"; // 06:00 CDT
    for (let i = 0; i < 5; i++) await sent(DB, "gaia", "share_observation", plus(start, i * 100));
    const racers = await Promise.all(["cypher", "drevan", "gaia"].map((c) =>
      reserveReach(DB, { companion: c, actionType: "share_media", careHold: false, nowIso: plus(start, 600) })));
    expect(racers.filter((r) => r.reserved)).toHaveLength(1);
  });
});

describe("the 90-minute gap is shared across companions", () => {
  it("Drevan at 10:00 blocks Cypher at 11:29 and lets him through at 11:31", async () => {
    const { DB } = setup();
    await sent(DB, "drevan", "flirt", MORNING);
    const early = await reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: plus(MORNING, 89) });
    expect(early).toEqual({ reserved: false, reason: "gap" });
    const gaia = await reserveReach(DB, { companion: "gaia", actionType: "offer_presence", careHold: false, nowIso: plus(MORNING, 60) });
    expect(gaia).toEqual({ reserved: false, reason: "gap" });
    const later = await reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: plus(MORNING, 91) });
    expect(later.reserved).toBe(true);
  });

  it("an undelivered reservation holds the gap too (a slot is taken at reserve, not at send)", async () => {
    const { DB } = setup();
    expect((await reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: MORNING })).reserved).toBe(true);
    expect((await reserveReach(DB, { companion: "gaia", actionType: "show_made", careHold: false, nowIso: plus(MORNING, 5) })).reserved).toBe(false);
  });

  it("the gap is a named default overridable in [vars]", () => {
    expect(DEFAULT_REACH_CONFIG.gapMinutes).toBe(90);
    expect(reachConfigFrom({ TRIAD_REACH_GAP_MINUTES: "120" } as any).gapMinutes).toBe(120);
    expect(reachConfigFrom({ TRIAD_REACH_GAP_MINUTES: "nope" } as any).gapMinutes).toBe(90);
  });
});

describe("the daily total and the care ceiling", () => {
  it("six a day across the triad, then nothing until the Chicago day turns", async () => {
    const { DB } = setup();
    // 06:00 CDT onward, 100 minutes apart: six moves fit before 16:00.
    const start = "2026-09-28T11:00:00.000Z";
    const who = ["drevan", "cypher", "gaia", "drevan", "cypher", "gaia"];
    const what = ["flirt", "dare", "offer_presence", "share_observation", "show_made", "share_observation"];
    for (let i = 0; i < 6; i++) await sent(DB, who[i]!, what[i]!, plus(start, i * 100));
    const seventh = await reserveReach(DB, { companion: "drevan", actionType: "share_media", careHold: false, nowIso: plus(start, 700) });
    expect(seventh).toEqual({ reserved: false, reason: "daily_cap" });
    // 2026-09-29 06:10 CDT = 11:10Z: a new local day (and out of quiet hours).
    expect((await reserveReach(DB, { companion: "drevan", actionType: "share_media", careHold: false, nowIso: "2026-09-29T11:10:00.000Z" })).reserved).toBe(true);
  });

  it("the day is the America/Chicago day, not the UTC day", async () => {
    // 2026-09-28 20:30 CDT is 2026-09-29T01:30Z: UTC says the 29th, Chicago says the 28th.
    expect(await (async () => {
      const { DB } = setup();
      const r = await reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: "2026-09-29T01:30:00.000Z" });
      expect(r.reserved).toBe(true);
      return (await reachLaneVerdict(DB, "2026-09-29T01:31:00.000Z")).local_date;
    })()).toBe("2026-09-28");
  });

  it("under care_hold the reserving companion sees the lower total (3)", async () => {
    const { DB } = setup();
    const start = "2026-09-28T11:00:00.000Z";
    await sent(DB, "gaia", "offer_presence", start);
    await sent(DB, "drevan", "offer_presence", plus(start, 100));
    await sent(DB, "cypher", "offer_presence", plus(start, 200));
    const held = await reserveReach(DB, { companion: "gaia", actionType: "offer_presence", careHold: true, nowIso: plus(start, 300) });
    expect(held).toEqual({ reserved: false, reason: "daily_cap" });
    const ordinary = await reserveReach(DB, { companion: "gaia", actionType: "offer_presence", careHold: false, nowIso: plus(start, 300) });
    expect(ordinary.reserved).toBe(true);
  });

  it("two care lines a day across the triad; presence and own moves are outside the ceiling", async () => {
    const { DB } = setup();
    const start = "2026-09-28T11:00:00.000Z";
    await sent(DB, "cypher", "check_in_on_raziel", start);
    await sent(DB, "drevan", "send_reminder", plus(start, 100));
    const third = await reserveReach(DB, { companion: "gaia", actionType: "check_in_on_raziel", careHold: false, nowIso: plus(start, 200) });
    expect(third).toEqual({ reserved: false, reason: "care_ceiling" });
    // Same instant, not care: presence and a share still go.
    expect((await reserveReach(DB, { companion: "gaia", actionType: "offer_presence", careHold: false, nowIso: plus(start, 200) })).reserved).toBe(true);
    expect((await reserveReach(DB, { companion: "drevan", actionType: "share_observation", careHold: false, nowIso: plus(start, 300) })).reserved).toBe(true);
  });

  it("there is no floor: nothing in the cap requires or rewards own moves (R-12)", () => {
    // The config has ceilings only. A quota key would be a pressure to reach more.
    expect(Object.keys(DEFAULT_REACH_CONFIG).sort()).toEqual(["careCeiling", "daily", "dailyCareHold", "gapMinutes", "quietEnd", "quietStart", "tz"]);
  });

  it("class mapping: care is about him, presence is its own share, the rest are theirs", () => {
    for (const t of ["check_in_on_raziel", "send_reminder", "ask_question", "name_pattern"]) expect(reachClassOf(t)).toBe("care");
    expect(reachClassOf("offer_presence")).toBe("presence");
    for (const t of ["share_observation", "share_media", "declare_preference", "drift_outward", "flirt", "dare", "show_made"]) expect(reachClassOf(t)).toBe("own");
    // Channel and internal moves can never reserve a DM slot.
    for (const t of ["post_heartbeat", "tend_creature", "write_journal", "drift_open", "write_note_to_raziel", "nothing"]) expect(reachClassOf(t)).toBe(null);
  });
});

describe("quiet hours: only presence, and one presence per window across the triad", () => {
  it("22:30 and 03:00 are the same window; 06:00 is morning", () => {
    expect(quietWindowKey(LATE, DEFAULT_REACH_CONFIG)).toBe("2026-09-28");
    expect(quietWindowKey(SMALL_HOURS, DEFAULT_REACH_CONFIG)).toBe("2026-09-28");
    expect(quietWindowKey("2026-09-29T11:00:00.000Z", DEFAULT_REACH_CONFIG)).toBe(null); // 06:00 CDT
    expect(quietWindowKey(MORNING, DEFAULT_REACH_CONFIG)).toBe(null);
  });

  it("the window is DST-aware: 22:30 CST in December is inside, 21:30 is not", () => {
    expect(quietWindowKey("2026-12-08T04:30:00.000Z", DEFAULT_REACH_CONFIG)).toBe("2026-12-07");
    expect(quietWindowKey("2026-12-08T03:30:00.000Z", DEFAULT_REACH_CONFIG)).toBe(null);
  });

  it("a flirt, a dare, a preference, a drift line, a share and a check-in all wait for morning", async () => {
    const { DB } = setup();
    for (const t of ["flirt", "dare", "declare_preference", "drift_outward", "share_observation", "share_media", "show_made", "check_in_on_raziel", "ask_question", "send_reminder", "name_pattern"]) {
      expect(await reserveReach(DB, { companion: "drevan", actionType: t, careHold: false, nowIso: LATE })).toEqual({ reserved: false, reason: "quiet_hours" });
    }
  });

  it("one presence per quiet window from the three together, not one each (R-2)", async () => {
    const { DB } = setup();
    await sent(DB, "gaia", "offer_presence", LATE);
    // Four and a half hours later, past the 90-minute gap, same window: refused for everyone.
    for (const c of ["drevan", "cypher", "gaia"]) {
      expect(await reserveReach(DB, { companion: c, actionType: "offer_presence", careHold: false, nowIso: SMALL_HOURS }))
        .toEqual({ reserved: false, reason: "quiet_presence_taken" });
    }
    // The next night is a new window.
    expect((await reserveReach(DB, { companion: "drevan", actionType: "offer_presence", careHold: false, nowIso: "2026-09-30T04:00:00.000Z" })).reserved).toBe(true);
  });

  it("two presences racing inside one window: the unique key lets exactly one land", async () => {
    const { DB } = setup();
    const rs = await Promise.all(["gaia", "drevan"].map((c) =>
      reserveReach(DB, { companion: c, actionType: "offer_presence", careHold: false, nowIso: SMALL_HOURS })));
    expect(rs.filter((r) => r.reserved)).toHaveLength(1);
  });
});

describe("release and stale takeover", () => {
  it("a failed send hands the slot back", async () => {
    const { DB } = setup();
    const r = await reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: MORNING });
    expect(r.reserved).toBe(true);
    if (!r.reserved) return;
    expect(await releaseReach(DB, r.id, "drevan")).toBe(false); // only the reserver may release
    expect(await releaseReach(DB, r.id, "cypher")).toBe(true);
    expect((await reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: plus(MORNING, 1) })).reserved).toBe(true);
  });

  it("a delivered DM cannot be released", async () => {
    const { DB } = setup();
    const r = await sent(DB, "cypher", "dare", MORNING);
    if (r.reserved) expect(await releaseReach(DB, r.id, "cypher")).toBe(false);
  });

  it("a crashed turn's reservation stops holding its slot once stale", async () => {
    const { DB } = setup();
    expect((await reserveReach(DB, { companion: "cypher", actionType: "dare", careHold: false, nowIso: MORNING })).reserved).toBe(true);
    expect((await reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: plus(MORNING, TRIAD_REACH_STALE_MINUTES - 1) })).reserved).toBe(false);
    expect((await reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: plus(MORNING, TRIAD_REACH_STALE_MINUTES + 1) })).reserved).toBe(true);
  });
});

describe("med_reminder is outside the cap (R-9)", () => {
  it("is not a DM-lane move and cannot reserve", async () => {
    const { DB } = setup();
    expect(await reserveReach(DB, { companion: "drevan", actionType: "med_reminder", careHold: false, nowIso: MORNING }))
      .toEqual({ reserved: false, reason: "not_a_dm_move" });
  });

  it("a delivered med reminder takes no slot: a flirt one minute later still reserves", async () => {
    const { db, DB } = setup();
    db.exec(`INSERT INTO med_schedule (slot_key, label, local_time) VALUES ('morning', 'med-a', '10:00')`);
    expect(await claimDose(DB, { slot_key: "morning", local_date: "2026-09-28", kind: "first", companion: "drevan", nowIso: MORNING })).toBe(true);
    expect((await reserveReach(DB, { companion: "drevan", actionType: "flirt", careHold: false, nowIso: plus(MORNING, 1) })).reserved).toBe(true);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM triad_reach_claims`).get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("the lane verdict rides the eligible-palette response", () => {
  it("names the gap and the counts, and treats a stale undelivered row as gone", async () => {
    const { DB } = setup();
    await sent(DB, "cypher", "check_in_on_raziel", MORNING);
    const v = await reachLaneVerdict(DB, plus(MORNING, 10));
    expect(v).toMatchObject({ local_date: "2026-09-28", quiet_window: null, gap_open: false, day_count: 1, care_count: 1, daily_cap: 6, daily_cap_care_hold: 3, care_ceiling: 2 });
    expect((await reachLaneVerdict(DB, plus(MORNING, 95))).gap_open).toBe(true);
  });

  it("GET /eligible carries `reach` beside `quiet_hours`", async () => {
    const { env } = setup();
    const res = await getMindMetronomeEligibleActions(
      new Request("https://h/mind/metronome/actions/gaia/eligible", { headers: { Authorization: "Bearer s" } }), env, { companion_id: "gaia" });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.reach).toMatchObject({ daily_cap: 6, care_ceiling: 2 });
    expect(body.quiet_hours).toBeTruthy();
  });
});

describe("the new move types and who owns them", () => {
  it("the four new types are valid and the rebuilt CHECK accepts them", () => {
    const { db } = setup();
    for (const [c, t] of [["drevan", "flirt"], ["cypher", "dare"], ["gaia", "show_made"], ["gaia", "drift_outward"]] as const) {
      expect(isValidActionType(t)).toBe(true);
      db.prepare(`INSERT INTO metronome_actions (companion_id, name, action_type) VALUES (?, ?, ?)`).run(c, `t-${t}`, t);
    }
    expect(() => db.prepare(`INSERT INTO metronome_actions (companion_id, name, action_type) VALUES ('gaia', 'x', 'serenade')`).run()).toThrow();
  });

  it("flirt is Drevan's only; dares are Cypher's and Drevan's; Gaia declines play", () => {
    expect(ownsMove("drevan", "flirt")).toBe(true);
    expect(ownsMove("cypher", "flirt")).toBe(false);
    expect(ownsMove("gaia", "flirt")).toBe(false);
    expect(ownsMove("cypher", "dare")).toBe(true);
    expect(ownsMove("gaia", "dare")).toBe(false);
    expect(ownsMove("gaia", "show_made")).toBe(true);
    expect(ownsMove("drevan", "show_made")).toBe(false); // Q2 open: one edit in MOVE_OWNERS
    expect(ownsMove("gaia", "offer_presence")).toBe(true);
  });

  it("the palette route refuses a flirt row for Gaia", async () => {
    const { env } = setup();
    const res = await postMindMetronomeAction(new Request("https://h/mind/metronome/actions", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ companion_id: "gaia", name: "x", action_type: "flirt" }),
    }), env);
    expect(res.status).toBe(400);
  });
});

describe("route auth", () => {
  it("a companion token cannot reserve as another companion", async () => {
    const { env } = setup();
    const res = await postReachReserve(new Request("https://h/mind/reach/reserve", {
      method: "POST", headers: { Authorization: "Bearer ctok", "Content-Type": "application/json" },
      body: JSON.stringify({ companion_id: "drevan", action_type: "flirt" }),
    }), env);
    expect(res.status).toBe(403);
  });

  it("an admin reserve returns the atomic verdict", async () => {
    const { env } = setup();
    const res = await postReachReserve(new Request("https://h/mind/reach/reserve", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ companion_id: "drevan", action_type: "not_a_move" }),
    }), env);
    expect(await res.json()).toEqual({ reserved: false, reason: "not_a_dm_move" });
  });
});
