// med_reminder (mig 0136) against the REAL schema (every migration, node:sqlite). Labels are fake
// (med-a/med-b/med-c) and so are the clock times (07:10 / 21:40 / Wednesday 16:20): real medication
// names and dose times never enter a tracked file.
//
// Covers: DST-aware local parts on both sides of the 2026-11-01 transition, due resolution for the
// primary and the fallback companion, the Wednesday weekly slot and its active_from, the late window,
// atomic claims (two claimers, restart, stale takeover), the single follow-up (fires once when
// unanswered, never when answered, never twice, never chasing a late first), answer recording
// (most recently reminded dose, only to the companion who reminded, never past the next occurrence),
// "today's state" (absence is null, never not-taken; yesterday's night dose before noon), and the
// route auth.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { localPartsIn } from "../webmind/metronome.js";
import {
  resolveDue, claimDose, markDelivered, releaseClaim, recordAnswer, recordAnswers, medState,
  addDays, weekdayOf, nextOccurrenceDate, MED_CLAIM_STALE_SECONDS,
} from "../webmind/med-reminder.js";
import { getMedDue, postMedClaim, postMedAnswer, getMedToday } from "../handlers/med-reminder.js";
import { MED_DM_TAKEN_SQL } from "../care/tick.js";

const TZ = "America/Chicago";

function setup(opts: { seed?: boolean } = {}) {
  const { db, DB } = makeSqliteD1();
  if (opts.seed !== false) {
    db.exec(`
      INSERT INTO med_schedule (slot_key, label, local_time, weekday_mask, followup_minutes) VALUES ('morning', 'med-a', '07:10', 127, 30);
      INSERT INTO med_schedule (slot_key, label, local_time, weekday_mask, followup_minutes) VALUES ('night',   'med-b', '21:40', 127, 30);
      INSERT INTO med_schedule (slot_key, label, local_time, weekday_mask, followup_minutes, active_from) VALUES ('weekly', 'med-c', '16:20', 8, 30, '2026-09-30');
    `);
  }
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok" };
  return { db, DB, env };
}

/** A UTC instant `minutes` after `iso`. */
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

// 2026-09-28 (Monday) 21:40 CDT = 2026-09-29T02:40Z.  2026-12-07 (Monday) 21:40 CST = 2026-12-08T03:40Z.
const NIGHT_CDT = "2026-09-29T02:40:00.000Z";
const NIGHT_CST = "2026-12-08T03:40:00.000Z";

async function deliver(DB: any, slot: string, date: string, kind: "first" | "followup", companion: string, at: string) {
  expect(await claimDose(DB, { slot_key: slot, local_date: date, kind, companion, nowIso: at })).toBe(true);
  expect(await markDelivered(DB, { slot_key: slot, local_date: date, kind, companion, nowIso: at, path: "generated" })).toBe(true);
}

describe("localPartsIn: the zone's own DST rules, never an offset", () => {
  it("reads 21:40 on the right local date in CDT and in CST", () => {
    expect(localPartsIn(NIGHT_CDT, TZ)).toEqual({ date: "2026-09-28", hour: 21, minute: 40, weekday: 1 });
    expect(localPartsIn(NIGHT_CST, TZ)).toEqual({ date: "2026-12-07", hour: 21, minute: 40, weekday: 1 });
  });
  it("the same UTC wall time is an hour apart locally across the transition", () => {
    expect(localPartsIn("2026-10-31T01:30:00Z", TZ)?.hour).toBe(20); // Oct 30, CDT
    expect(localPartsIn("2026-11-02T01:30:00Z", TZ)?.hour).toBe(19); // Nov 1, CST
  });
  it("midnight is 00, not 24; a bad zone is null", () => {
    expect(localPartsIn("2026-07-15T05:00:00Z", TZ)?.hour).toBe(0);
    expect(localPartsIn(NIGHT_CDT, "Not/AZone")).toBe(null);
  });
  it("calendar helpers do not depend on a clock", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-09-30")).toBe(3); // Wednesday
  });
});

describe("resolveDue: who sends, and when", () => {
  it("Drevan (primary) is due at the slot time, on both sides of DST", async () => {
    const { DB } = setup();
    expect(await resolveDue(DB, "drevan", NIGHT_CDT)).toEqual([
      { slot_key: "night", local_date: "2026-09-28", kind: "first", label: "med-b", local_time: "21:40" },
    ]);
    expect((await resolveDue(DB, "drevan", NIGHT_CST)).map(d => [d.slot_key, d.local_date])).toEqual([["night", "2026-12-07"]]);
  });

  it("the CDT UTC instant is 20:40 in December: nothing is due an hour early (the fixed-offset bug)", async () => {
    const { DB } = setup();
    expect(await resolveDue(DB, "drevan", "2026-12-08T02:40:00.000Z")).toEqual([]);
  });

  it("the night of the transition itself (2026-11-01) resolves to 21:40 CST", async () => {
    const { DB } = setup();
    expect(await resolveDue(DB, "drevan", "2026-11-02T02:40:00.000Z")).toEqual([]);          // 20:40 CST
    expect((await resolveDue(DB, "drevan", "2026-11-02T03:40:00.000Z")).map(d => d.local_date)).toEqual(["2026-11-01"]);
  });

  it("Cypher (fallback) waits the delay, then fires only while unclaimed", async () => {
    const { DB } = setup();
    expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, 1))).toEqual([]);
    expect((await resolveDue(DB, "cypher", plus(NIGHT_CDT, 2))).map(d => d.kind)).toEqual(["first"]);
    // Drevan claimed in time: Cypher never sees it.
    const { DB: DB2 } = setup();
    expect(await claimDose(DB2, { slot_key: "night", local_date: "2026-09-28", kind: "first", companion: "drevan", nowIso: NIGHT_CDT })).toBe(true);
    expect(await resolveDue(DB2, "cypher", plus(NIGHT_CDT, 3))).toEqual([]);
  });

  it("Gaia is on no row, so nothing is ever due for her", async () => {
    const { DB } = setup();
    expect(await resolveDue(DB, "gaia", plus(NIGHT_CDT, 5))).toEqual([]);
  });

  it("expires unsent past the late window (an outage never makes a night reminder three hours late)", async () => {
    const { DB } = setup();
    expect((await resolveDue(DB, "drevan", plus(NIGHT_CDT, 179))).length).toBe(1);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 180))).toEqual([]);
  });

  it("the weekly slot fires on Wednesday only, and not before active_from", async () => {
    const { DB } = setup();
    const wed = "2026-09-30T21:20:00.000Z"; // Wed 16:20 CDT
    expect((await resolveDue(DB, "drevan", wed)).map(d => d.slot_key)).toEqual(["weekly"]);
    expect(await resolveDue(DB, "drevan", "2026-09-29T21:20:00.000Z")).toEqual([]); // Tuesday
    expect(await resolveDue(DB, "drevan", "2026-09-23T21:20:00.000Z")).toEqual([]); // a Wednesday before 09-30
    expect((await resolveDue(DB, "drevan", "2026-12-02T22:20:00.000Z")).map(d => d.slot_key)).toEqual(["weekly"]); // Wed 16:20 CST
  });

  it("a weekday mask change needs no migration (weekends off for the morning slot)", async () => {
    const { db, DB } = setup();
    db.exec(`UPDATE med_schedule SET weekday_mask = 62 WHERE slot_key = 'morning'`); // Mon..Fri
    expect(await resolveDue(DB, "drevan", "2026-10-03T12:10:00.000Z")).toEqual([]); // Sat 07:10 CDT
    expect((await resolveDue(DB, "drevan", "2026-10-05T12:10:00.000Z")).map(d => d.slot_key)).toEqual(["morning"]); // Mon
  });
});

describe("claims: exactly one sender", () => {
  it("two claimers racing produce one win", async () => {
    const { DB } = setup();
    const base = { slot_key: "night", local_date: "2026-09-28", kind: "first" as const, nowIso: plus(NIGHT_CDT, 2) };
    const [a, b] = await Promise.all([claimDose(DB, { ...base, companion: "drevan" }), claimDose(DB, { ...base, companion: "cypher" })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("a restart after delivery does not resend (for either bot)", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 1))).toEqual([]);
    expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, 5))).toEqual([]);
    expect(await claimDose(DB, { slot_key: "night", local_date: "2026-09-28", kind: "first", companion: "drevan", nowIso: plus(NIGHT_CDT, 1) })).toBe(false);
  });

  it("a claim that crashed before sending is taken over only once it is stale", async () => {
    const { DB } = setup();
    const c = { slot_key: "night", local_date: "2026-09-28", kind: "first" as const };
    expect(await claimDose(DB, { ...c, companion: "drevan", nowIso: NIGHT_CDT })).toBe(true);
    const fresh = plus(NIGHT_CDT, 3);
    expect(await resolveDue(DB, "cypher", fresh)).toEqual([]);
    expect(await claimDose(DB, { ...c, companion: "cypher", nowIso: fresh })).toBe(false);
    const stale = plus(NIGHT_CDT, MED_CLAIM_STALE_SECONDS / 60 + 1);
    expect((await resolveDue(DB, "cypher", stale)).map(d => d.kind)).toEqual(["first"]);
    expect(await claimDose(DB, { ...c, companion: "cypher", nowIso: stale })).toBe(true);
    expect(await claimDose(DB, { ...c, companion: "drevan", nowIso: stale })).toBe(false);
  });

  it("a released claim (failed send) is immediately claimable by the other bot", async () => {
    const { DB } = setup();
    const c = { slot_key: "night", local_date: "2026-09-28", kind: "first" as const };
    expect(await claimDose(DB, { ...c, companion: "drevan", nowIso: NIGHT_CDT })).toBe(true);
    expect(await releaseClaim(DB, { ...c, companion: "drevan" })).toBe(true);
    expect((await resolveDue(DB, "cypher", plus(NIGHT_CDT, 2))).length).toBe(1);
  });
});

describe("the follow-up: once, only unanswered", () => {
  const D = "2026-09-28";

  it("fires once at +30 for the first's sender, Cypher only after the delay", async () => {
    const { DB } = setup();
    await deliver(DB, "night", D, "first", "drevan", NIGHT_CDT);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 29))).toEqual([]);
    expect((await resolveDue(DB, "drevan", plus(NIGHT_CDT, 30))).map(d => d.kind)).toEqual(["followup"]);
    expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, 31))).toEqual([]);
    expect((await resolveDue(DB, "cypher", plus(NIGHT_CDT, 32))).map(d => d.kind)).toEqual(["followup"]);
  });

  it("never twice", async () => {
    const { DB } = setup();
    await deliver(DB, "night", D, "first", "drevan", NIGHT_CDT);
    await deliver(DB, "night", D, "followup", "drevan", plus(NIGHT_CDT, 30));
    for (const m of [31, 60, 120, 200]) {
      expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, m))).toEqual([]);
      expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, m))).toEqual([]);
    }
    expect(await claimDose(DB, { slot_key: "night", local_date: D, kind: "followup", companion: "cypher", nowIso: plus(NIGHT_CDT, 40) })).toBe(false);
  });

  it("never when he answered, and an answer landing before the claim cancels it atomically", async () => {
    const { DB } = setup();
    await deliver(DB, "night", D, "first", "drevan", NIGHT_CDT);
    expect(await recordAnswer(DB, "drevan", plus(NIGHT_CDT, 10))).not.toBe(null);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 30))).toEqual([]);
    expect(await claimDose(DB, { slot_key: "night", local_date: D, kind: "followup", companion: "drevan", nowIso: plus(NIGHT_CDT, 30) })).toBe(false);
  });

  it("never without a delivered first (a claimed-but-unsent first is not a reminder)", async () => {
    const { DB } = setup();
    expect(await claimDose(DB, { slot_key: "night", local_date: D, kind: "first", companion: "drevan", nowIso: NIGHT_CDT })).toBe(true);
    expect(await claimDose(DB, { slot_key: "night", local_date: D, kind: "followup", companion: "drevan", nowIso: plus(NIGHT_CDT, 30) })).toBe(false);
  });

  it("a late first is not chased by an immediate second message", async () => {
    const { DB } = setup();
    await deliver(DB, "night", D, "first", "cypher", plus(NIGHT_CDT, 25));
    expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, 31))).toEqual([]);
    expect((await resolveDue(DB, "cypher", plus(NIGHT_CDT, 55))).map(d => d.kind)).toEqual(["followup"]);
  });

  it("no follow-up at all when the row sets none", async () => {
    const { db, DB } = setup();
    db.exec(`UPDATE med_schedule SET followup_minutes = NULL WHERE slot_key = 'night'`);
    await deliver(DB, "night", D, "first", "drevan", NIGHT_CDT);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 45))).toEqual([]);
  });
});

describe("recordAnswer: the only thing ever recorded", () => {
  it("nothing to answer means nothing recorded", async () => {
    const { db, DB } = setup();
    expect(await recordAnswer(DB, "drevan", NIGHT_CDT)).toBe(null);
    expect((db.prepare("SELECT COUNT(*) AS n FROM med_answers").get() as { n: number }).n).toBe(0);
  });

  it("records the answer with its local time, to the companion who asked", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    const r = await recordAnswer(DB, "drevan", plus(NIGHT_CDT, 11));
    expect(r).toMatchObject({ slot_key: "night", local_date: "2026-09-28", answered_local: "21:51" });
  });

  it("a fast yes that lands before the delivery mark still counts (bounded on claimed_at)", async () => {
    const { DB } = setup();
    const c = { slot_key: "night", local_date: "2026-09-28", kind: "first" as const, companion: "drevan" };
    expect(await claimDose(DB, { ...c, nowIso: NIGHT_CDT })).toBe(true);
    expect(await markDelivered(DB, { ...c, nowIso: new Date(Date.parse(NIGHT_CDT) + 3_000).toISOString(), path: "generated" })).toBe(true);
    const r = await recordAnswer(DB, "drevan", new Date(Date.parse(NIGHT_CDT) + 1_000).toISOString());
    expect(r?.slot_key).toBe("night");
  });

  it("an answer to a companion who did not remind him records nothing", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    expect(await recordAnswer(DB, "cypher", plus(NIGHT_CDT, 5))).toBe(null);
  });

  it("with two doses open, the most recently reminded one takes the answer", async () => {
    const { DB } = setup();
    const wed = "2026-09-30T21:20:00.000Z"; // weekly, Wed 16:20 CDT
    const morning = "2026-09-30T12:10:00.000Z"; // Wed 07:10 CDT
    await deliver(DB, "morning", "2026-09-30", "first", "drevan", morning);
    await deliver(DB, "weekly", "2026-09-30", "first", "drevan", wed);
    expect((await recordAnswer(DB, "drevan", plus(wed, 3)))?.slot_key).toBe("weekly");
    expect((await recordAnswer(DB, "drevan", plus(wed, 4)))?.slot_key).toBe("morning");
    expect(await recordAnswer(DB, "drevan", plus(wed, 5))).toBe(null);
  });

  it("never answers a dose whose next occurrence has already come", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    // The next night's dose time has passed: "yes" now is not about the 09-28 dose.
    expect(await recordAnswer(DB, "drevan", plus(NIGHT_CDT, 24 * 60 + 5))).toBe(null);
  });

  it("nextOccurrenceDate honours the mask and active_from", () => {
    expect(nextOccurrenceDate({ weekday_mask: 8, active_from: null }, "2026-09-30")).toBe("2026-10-07");
    expect(nextOccurrenceDate({ weekday_mask: 127, active_from: null }, "2026-09-30")).toBe("2026-10-01");
  });
});

describe("medState: absence is never not-taken", () => {
  it("a due dose with no answer is null, an answered one carries the local time", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    let s = await medState(DB, plus(NIGHT_CDT, 5));
    expect(s.map(e => [e.slot_key, e.day, e.answered_local])).toEqual([["morning", "today", null], ["night", "today", null]]);
    await recordAnswer(DB, "drevan", plus(NIGHT_CDT, 9));
    s = await medState(DB, plus(NIGHT_CDT, 10));
    expect(s.find(e => e.slot_key === "night")).toMatchObject({ answered_local: "21:49", answered_to: "drevan" });
  });

  it("before noon it carries last night's dose; after noon it does not", async () => {
    const { DB } = setup();
    const morningAfter = "2026-09-29T13:00:00.000Z"; // 08:00 CDT
    expect((await medState(DB, morningAfter)).map(e => [e.slot_key, e.day])).toEqual([["night", "yesterday"], ["morning", "today"]]);
    const afternoon = "2026-09-29T18:00:00.000Z"; // 13:00 CDT
    expect((await medState(DB, afternoon)).map(e => [e.slot_key, e.day])).toEqual([["morning", "today"]]);
  });

  it("a dose whose time has not come yet is not listed", async () => {
    const { DB } = setup();
    expect(await medState(DB, "2026-09-29T10:00:00.000Z")).toEqual([
      expect.objectContaining({ slot_key: "night", day: "yesterday" }),
    ]); // 05:00 CDT: morning (07:10) not yet due
  });
});

describe("routes", () => {
  const req = (url: string, init: RequestInit & { token?: string } = {}) =>
    new Request(url, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) } });

  it("refuses without auth", async () => {
    const { env } = setup();
    const res = await getMedDue(req("https://h/mind/med/due/drevan"), env, { companion_id: "drevan" });
    expect(res.status).toBe(401);
  });

  it("a companion token cannot act as another companion", async () => {
    const { env } = setup();
    const res = await getMedDue(req("https://h/mind/med/due/drevan", { token: "ctok" }), env, { companion_id: "drevan" });
    expect(res.status).toBe(403);
    const claim = await postMedClaim(req("https://h/mind/med/claim", {
      method: "POST", token: "ctok",
      body: JSON.stringify({ slot_key: "night", local_date: "2026-09-28", kind: "first", companion_id: "drevan" }),
    }), env);
    expect(claim.status).toBe(403);
  });

  it("due honours ?now=, claim validates its body, answer stores no content", async () => {
    const { env, db } = setup();
    const due = await getMedDue(req(`https://h/mind/med/due/drevan?now=${NIGHT_CDT}`, { token: "s" }), env, { companion_id: "drevan" });
    expect(((await due.json()) as { due: unknown[] }).due).toHaveLength(1);
    const bad = await postMedClaim(req("https://h/mind/med/claim", { method: "POST", token: "s", body: JSON.stringify({ slot_key: "night", local_date: "09/28", kind: "first", companion_id: "drevan" }) }), env);
    expect(bad.status).toBe(400);
    const ans = await postMedAnswer(req("https://h/mind/med/answer", { method: "POST", token: "s", body: JSON.stringify({ companion_id: "drevan", answered_at: NIGHT_CDT, content: "yes" }) }), env);
    expect(ans.status).toBe(200);
    const cols = (db.prepare("PRAGMA table_info(med_answers)").all() as Array<{ name: string }>).map(c => c.name);
    // CHANGED 2026-10-01 (mig 0141): `outcome` joins the list (taken | missed, the stated-miss
    // ruling). The point of this assertion is unchanged: still no free-text column, so what he
    // said can never be stored, only what it meant.
    expect(cols.sort()).toEqual(["answered_at", "companion_id", "created_at", "local_date", "outcome", "slot_key"]);
    const today = await getMedToday(req(`https://h/mind/med/today?now=${NIGHT_CDT}`, { token: "s" }), env);
    expect(((await today.json()) as { doses: unknown[] }).doses.length).toBeGreaterThan(0);
  });
});

// ── 0141: named doses and stated misses (Raziel's ruling 2026-10-01) ─────────────────────────────
// A miss is recorded only when he says it; silence records nothing. Named answers record THAT dose.

describe("recordAnswers: named doses, both, stated misses", () => {
  const MON = "2026-09-28";
  const MORNING = "2026-09-28T12:10:00.000Z"; // Mon 07:10 CDT
  const rows = (db: any) => db.prepare("SELECT slot_key, local_date, outcome, companion_id FROM med_answers ORDER BY slot_key").all();

  async function bothOpen(DB: any) {
    await deliver(DB, "morning", MON, "first", "drevan", MORNING);
    await deliver(DB, "night", MON, "first", "drevan", NIGHT_CDT);
  }

  it("a named slot records THAT dose, not the most recently reminded one", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    const [r] = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: "morning", outcome: "taken" }]);
    expect(r!.recorded.map(x => [x.slot_key, x.outcome])).toEqual([["morning", "taken"]]);
    expect(rows(db)).toEqual([{ slot_key: "morning", local_date: MON, outcome: "taken", companion_id: "drevan" }]);
  });

  it("'*' (both / all of them) records every open reminded dose", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    const [r] = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: "*", outcome: "taken" }]);
    expect(r!.recorded.map(x => x.slot_key).sort()).toEqual(["morning", "night"]);
    expect(rows(db).map((x: any) => x.outcome)).toEqual(["taken", "taken"]);
  });

  it("a mixed answer records each dose with its own outcome", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [
      { slot_key: "night", outcome: "taken" }, { slot_key: "morning", outcome: "missed" },
    ]);
    expect(rows(db).map((x: any) => [x.slot_key, x.outcome])).toEqual([["morning", "missed"], ["night", "taken"]]);
  });

  it("an unnamed miss lands on the most recently reminded open dose, like an unnamed yes", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    const [r] = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: null, outcome: "missed" }]);
    expect(r!.recorded[0]).toMatchObject({ slot_key: "night", outcome: "missed", answered_local: "21:45" });
    expect(rows(db)).toHaveLength(1);
  });

  it("a named slot still honours the window: past the next occurrence it records nothing", async () => {
    const { db, DB } = setup();
    await deliver(DB, "morning", MON, "first", "drevan", MORNING);
    const [r] = await recordAnswers(DB, "drevan", plus(MORNING, 24 * 60 + 1), [{ slot_key: "morning", outcome: "missed" }]);
    expect(r).toMatchObject({ recorded: [], skipped: "no_open_dose" });
    expect(rows(db)).toEqual([]);
  });

  it("a named slot he was not reminded about by this companion records nothing", async () => {
    const { db, DB } = setup();
    await deliver(DB, "night", MON, "first", "drevan", NIGHT_CDT);
    const [r] = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: "morning", outcome: "taken" }]);
    expect(r!.skipped).toBe("no_open_dose");
    expect((await recordAnswers(DB, "cypher", plus(NIGHT_CDT, 5), [{ slot_key: "night", outcome: "missed" }]))[0]!.skipped).toBe("no_open_dose");
    expect(rows(db)).toEqual([]);
  });

  it("an unknown slot key is skipped, and does not stop a good entry beside it", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    const res = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [
      { slot_key: "lunch", outcome: "taken" }, { slot_key: "night", outcome: "taken" },
    ]);
    expect(res.map(r => r.skipped ?? "ok")).toEqual(["unknown_slot", "ok"]);
    expect(rows(db).map((x: any) => x.slot_key)).toEqual(["night"]);
  });

  it("contradictions record nothing for the entries involved (a false record is worse than none)", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    const res = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [
      { slot_key: "night", outcome: "taken" }, { slot_key: "night", outcome: "missed" }, { slot_key: "morning", outcome: "taken" },
    ]);
    expect(res.map(r => r.skipped ?? "ok")).toEqual(["conflict", "conflict", "ok"]);
    expect(rows(db).map((x: any) => x.slot_key)).toEqual(["morning"]);
    const star = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 6), [{ slot_key: "*", outcome: "taken" }, { slot_key: "night", outcome: "missed" }]);
    expect(star.map(r => r.skipped)).toEqual(["conflict", "conflict"]);
    const unnamed = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 7), [{ slot_key: null, outcome: "taken" }, { slot_key: null, outcome: "missed" }]);
    expect(unnamed.map(r => r.skipped)).toEqual(["conflict", "conflict"]);
    expect(rows(db).map((x: any) => x.slot_key)).toEqual(["morning"]);
  });

  it("a named entry is placed before an unnamed one, so the unnamed word never steals it", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: null, outcome: "taken" }, { slot_key: "night", outcome: "missed" }]);
    expect(rows(db).map((x: any) => [x.slot_key, x.outcome])).toEqual([["morning", "taken"], ["night", "missed"]]);
  });

  it("a later 'taken' replaces a stated miss (he said forgot, then took it); a taken is never turned into a miss", async () => {
    const { db, DB } = setup();
    await deliver(DB, "night", MON, "first", "drevan", NIGHT_CDT);
    await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: null, outcome: "missed" }]);
    expect(await recordAnswer(DB, "drevan", plus(NIGHT_CDT, 20))).toMatchObject({ slot_key: "night", outcome: "taken", answered_local: "22:00" });
    expect(rows(db)).toEqual([{ slot_key: "night", local_date: MON, outcome: "taken", companion_id: "drevan" }]);
    const [again] = await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 25), [{ slot_key: "night", outcome: "missed" }]);
    expect(again!.skipped).toBe("no_open_dose");
    expect(rows(db)[0].outcome).toBe("taken");
  });

  it("silence records nothing: no answer, no row, for either outcome", async () => {
    const { db, DB } = setup();
    await bothOpen(DB);
    await resolveDue(DB, "drevan", plus(NIGHT_CDT, 60));
    await medState(DB, plus(NIGHT_CDT, 60));
    expect(rows(db)).toEqual([]);
  });

  it("the CHECK refuses any outcome but taken / missed", () => {
    const { db } = setup();
    expect(() => db.exec(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id, outcome) VALUES ('night','2026-09-28','x','drevan','late')`)).toThrow();
  });
});

describe("a stated miss is an answer: the follow-up does not nag after it", () => {
  it("deliver first, he says he missed it, +30 finds nothing due and the claim is refused", async () => {
    const { DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 10), [{ slot_key: "night", outcome: "missed" }]);
    expect(await resolveDue(DB, "drevan", plus(NIGHT_CDT, 30))).toEqual([]);
    expect(await resolveDue(DB, "cypher", plus(NIGHT_CDT, 35))).toEqual([]);
    expect(await claimDose(DB, { slot_key: "night", local_date: "2026-09-28", kind: "followup", companion: "drevan", nowIso: plus(NIGHT_CDT, 30) })).toBe(false);
  });
});

describe("medState carries the outcome, and answered_local stays taken-only", () => {
  it("taken, stated miss and no answer are three distinct states", async () => {
    const { DB } = setup();
    await deliver(DB, "morning", "2026-09-28", "first", "drevan", "2026-09-28T12:10:00.000Z");
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    let s = await medState(DB, plus(NIGHT_CDT, 3));
    expect(s.map(e => [e.slot_key, e.outcome, e.told_local, e.answered_local])).toEqual([["morning", null, null, null], ["night", null, null, null]]);
    await recordAnswers(DB, "drevan", plus(NIGHT_CDT, 5), [{ slot_key: "morning", outcome: "missed" }, { slot_key: "night", outcome: "taken" }]);
    s = await medState(DB, plus(NIGHT_CDT, 6));
    expect(s.find(e => e.slot_key === "morning")).toMatchObject({ outcome: "missed", told_local: "21:45", told_to: "drevan", answered_local: null, answered_to: null });
    expect(s.find(e => e.slot_key === "night")).toMatchObject({ outcome: "taken", told_local: "21:45", answered_local: "21:45", answered_to: "drevan" });
  });
});

describe("care rules: only a 'taken' row confirms meds (a stated miss reads exactly like no answer)", () => {
  it("MED_DM_TAKEN_SQL against the real schema ignores a missed row and sees a taken one", () => {
    const { db } = setup();
    db.exec(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id, outcome) VALUES ('morning','2026-09-28','2026-09-28T12:20:00.000Z','drevan','missed')`);
    expect((db.prepare(MED_DM_TAKEN_SQL).get() as { at: string | null }).at).toBe(null);
    db.exec(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id) VALUES ('night','2026-09-27','2026-09-28T02:45:00.000Z','drevan')`);
    expect((db.prepare(MED_DM_TAKEN_SQL).get() as { at: string | null }).at).toBe("2026-09-28T02:45:00.000Z");
  });
});

describe("POST /mind/med/answer with answers[]", () => {
  const req = (body: unknown) => new Request("https://h/mind/med/answer", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer s" }, body: JSON.stringify(body),
  });

  it("without answers the response shape is the pre-0141 one (an older bot build keeps working)", async () => {
    const { env, DB } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    const res = await postMedAnswer(req({ companion_id: "drevan", answered_at: plus(NIGHT_CDT, 4) }), env);
    const j = await res.json() as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["recorded"]);
    expect(j.recorded).toMatchObject({ slot_key: "night", local_date: "2026-09-28" });
  });

  it("records each valid entry, reports invalid and unknown ones as skipped", async () => {
    const { env, DB, db } = setup();
    await deliver(DB, "morning", "2026-09-28", "first", "drevan", "2026-09-28T12:10:00.000Z");
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    const res = await postMedAnswer(req({ companion_id: "drevan", answered_at: plus(NIGHT_CDT, 4), answers: [
      { slot_key: "night", outcome: "taken" },
      { slot_key: "morning", outcome: "missed" },
      { slot_key: "lunch", outcome: "taken" },
      { slot_key: "night", outcome: "maybe" },
      { slot_key: "DROP TABLE", outcome: "taken" },
    ] }), env);
    expect(res.status).toBe(200);
    const j = await res.json() as { results: Array<{ recorded: unknown[]; skipped?: string }> };
    expect(j.results.map(r => r.skipped ?? "ok")).toEqual(["ok", "ok", "unknown_slot", "invalid", "invalid"]);
    expect(db.prepare("SELECT slot_key, outcome FROM med_answers ORDER BY slot_key").all()).toEqual([
      { slot_key: "morning", outcome: "missed" }, { slot_key: "night", outcome: "taken" },
    ]);
  });

  it("refuses a non-array answers and an oversized one", async () => {
    const { env } = setup();
    expect((await postMedAnswer(req({ companion_id: "drevan", answers: "yes" }), env)).status).toBe(400);
    expect((await postMedAnswer(req({ companion_id: "drevan", answers: Array(7).fill({ outcome: "taken" }) }), env)).status).toBe(400);
  });

  it("an empty answers array records nothing", async () => {
    const { env, DB, db } = setup();
    await deliver(DB, "night", "2026-09-28", "first", "drevan", NIGHT_CDT);
    const res = await postMedAnswer(req({ companion_id: "drevan", answered_at: plus(NIGHT_CDT, 4), answers: [] }), env);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM med_answers").get() as { n: number }).n).toBe(0);
  });
});
