// Undoing a check-in clears a care hold that check-in started (Raziel, 2026-10-31). Real schema
// (every migration, node:sqlite), the real hourly tick, the real DELETE handler.
//
// The leak: Hearth's undo DELETEs the snapshot, but a low_spoons firing the tick logged from it in
// between stayed and held for 12h. Only the undone reading's own firing is VOIDED (mig 0155, never
// deleted: a gesture_note stays); his "bad night" start, a stated missed dose and another low reading
// keep holding. Never a blanket clear. A deploy ahead of 0155 changes nothing and breaks nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { readCareHold } from "../care/hold.js";
import { runCareTick, FIRED_SQL, PENDING_RULES_SQL } from "../care/tick.js";
import { readPendingCare, PENDING_CARE_SQL } from "../care/pending.js";
import { lowSpoonsJustified, firingsToVoid, undoCheckin, UNDO_CANDIDATES_SQL, VOID_FIRING_SQL } from "../care/undo.js";
import { handleBiometricsDelete } from "../handlers/biometrics.js";
import { getCarePending, getCareRecent } from "../handlers/care.js";

const NOW = Date.parse("2026-10-31T07:00:00.000Z"); // 02:00 CDT
const ago = (h: number, from = NOW) => new Date(from - h * 3_600_000).toISOString();
const H = 3_600_000;

// The DELETE handler and the pending route read the server clock; pin it to NOW so "as of now" is fixed.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

/** A D1 whose 0155 reads (or one chosen statement) fail with a non-schema error, recording what ran. */
function flaky(DB: any, fails: (sql: string) => boolean): { prepared: string[]; DB: any } {
  const prepared: string[] = [];
  const boom = () => Promise.reject(new Error("D1_ERROR: Network connection lost."));
  const wrap = (sql: string, st: any): any => fails(sql)
    ? { __sql: sql, bind: (..._a: unknown[]) => wrap(sql, st), first: boom, all: boom, run: boom }
    : { ...st, __sql: sql, bind: (...a: unknown[]) => wrap(sql, st.bind(...a)) };
  return {
    prepared,
    DB: {
      prepare: (sql: string) => { prepared.push(sql); return wrap(sql, DB.prepare(sql)); },
      batch: async (stmts: any[]) => { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
    },
  };
}

function setup(opts: { upTo?: number } = {}) {
  const { DB } = makeSqliteD1(opts) as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const undo = (id: string) =>
    handleBiometricsDelete(new Request(`http://x/biometrics/${id}`, { method: "DELETE", headers: { Authorization: "Bearer s" } }), env, { id });
  /** A check-in row: recorded_at is the client's tap time, logged_at the server's insert time. */
  const snapshot = (id: string, spoons: number | null, recordedAt: string, loggedAt = recordedAt) =>
    DB.prepare(`INSERT INTO biometric_snapshots (id, recorded_at, logged_at, source, spoons) VALUES (?, ?, ?, 'hearth', ?)`)
      .bind(id, recordedAt, loggedAt, spoons).run();
  const tick = (at: number) => runCareTick(env, at, { force: true });
  /** Live firings: not voided. On a pre-0155 schema there is no column, so every row is live. */
  const live = opts.upTo !== undefined && opts.upTo < 155 ? "" : " WHERE voided_at IS NULL";
  const firings = async () =>
    ((await DB.prepare(`SELECT id, rule, detected_at FROM care_actions${live} ORDER BY detected_at`).all()).results ?? []) as Array<{ id: string; rule: string; detected_at: string }>;
  const allRows = async () =>
    ((await DB.prepare(`SELECT * FROM care_actions ORDER BY detected_at`).all()).results ?? []) as any[];
  return { DB, env, undo, snapshot, tick, firings, allRows };
}

describe("undoing a check-in clears the hold it started", () => {
  it("the tick fired from the check-in between landing and undo: the undo voids the firing and the hold is off", async () => {
    const { DB, undo, snapshot, tick, firings, allRows } = setup();
    await snapshot("chk_low_0001", 1, ago(0.5));
    await tick(NOW - 0.25 * H);
    expect((await firings()).map(f => f.rule)).toEqual(["low_spoons"]);
    expect((await readCareHold(DB, NOW)).care_hold).toBe(true);

    const res = await undo("chk_low_0001");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "chk_low_0001", care_firings_voided: 1 });
    expect(await firings()).toEqual([]);
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: false, care_hold_reason: [], care_hold_since: null });
    // Voided, not deleted: the row stays with a server-clock stamp.
    const rows = await allRows();
    expect(rows.length).toBe(1);
    expect(Number.isFinite(Date.parse(rows[0].voided_at))).toBe(true);
  });

  it("a companion's gesture on the voided firing stays in the record; the audit list shows the stamp", async () => {
    const { DB, env, undo, snapshot, tick, allRows } = setup();
    await snapshot("chk_low_0001", 1, ago(0.5));
    await tick(NOW - 0.25 * H);
    await DB.prepare(`UPDATE care_actions SET acted_at = ?, gesture = 'note', gesture_note = 'sat with him' WHERE rule = 'low_spoons'`).bind(ago(0.2)).run();
    await undo("chk_low_0001");
    const [row] = await allRows();
    expect(row.gesture_note).toBe("sat with him");
    expect(row.voided_at).not.toBeNull();
    expect((await readCareHold(DB, NOW)).care_hold).toBe(false);
    const recent = await (await getCareRecent(new Request("http://x/care/recent"), env)).json() as any;
    expect(recent.care_actions[0].voided_at).toBe(row.voided_at);
  });

  it("a voided firing asks nobody for a gesture: the pending read (orient and the worker poll) skips it", async () => {
    const { DB, env, undo, snapshot, tick } = setup();
    const now = Date.now(); // the pending route decays against the server clock (pinned to NOW)
    await snapshot("chk_low_0001", 1, ago(0.1, now));
    await tick(now - 60_000);
    const companion = (await DB.prepare(`SELECT companion_id FROM care_actions`).first()).companion_id;
    expect(await readPendingCare(DB, companion, ago(48, now))).not.toBeNull();
    await undo("chk_low_0001");
    expect(await readPendingCare(DB, companion, ago(48, now))).toBeNull();
    const res = await getCarePending(new Request("http://x"), env, { companion_id: companion });
    expect(await res.json()).toEqual({ pending: null });
  });

  it("a voided firing is never a candidate again and its stamp is never rewritten", async () => {
    const { DB, snapshot, tick, allRows } = setup();
    await snapshot("chk_low_0001", 1, ago(0.5));
    await tick(NOW - 0.25 * H);
    expect(await undoCheckin(DB, "chk_low_0001", NOW)).toEqual({ found: true, voided: [expect.any(String)] });
    const [row] = await allRows();
    const snap = { id: "chk_low_0001", spoons: 1, recorded_at: ago(0.5), logged_at: ago(0.5) };
    expect(await firingsToVoid(DB, snap, NOW + H)).toEqual([]);
    expect((await DB.prepare(VOID_FIRING_SQL).bind(ago(-1), row.id).run()).meta.changes).toBe(0);
    expect((await allRows())[0].voided_at).toBe(new Date(NOW).toISOString());
  });

  it("a real low reading logged AFTER the firing (held off by its cooldown) keeps the firing live", async () => {
    const { DB, undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_oops", 1, ago(2));
    await tick(NOW - 1.75 * H);
    await snapshot("chk_low_real", 2, ago(1));
    await tick(NOW - 0.75 * H); // cooldown: no second firing
    expect((await firings()).length).toBe(1);
    const res = await undo("chk_low_oops");
    expect(await res.json()).toEqual({ ok: true, id: "chk_low_oops", care_firings_voided: 0 });
    expect((await firings()).length).toBe(1);
    expect((await readCareHold(DB, NOW)).care_hold_reason).toEqual(["low_spoons"]);
  });

  it("the same when the real reading was tapped before the undone one but landed after the firing", async () => {
    const { DB, undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_oops", 1, ago(2));
    await tick(NOW - 1.75 * H);
    await snapshot("chk_low_real", 2, ago(2.5), ago(1)); // offline retry
    await undo("chk_low_oops");
    expect((await firings()).length).toBe(1);
    expect((await readCareHold(DB, NOW)).care_hold).toBe(true);
  });

  it("a reading above the line standing now does not keep the firing", async () => {
    const { DB, undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_oops", 1, ago(2));
    await tick(NOW - 1.75 * H);
    await snapshot("chk_ok_later", 8, ago(1));
    await undo("chk_low_oops");
    expect(await firings()).toEqual([]);
    expect((await readCareHold(DB, NOW)).care_hold).toBe(false);
  });

  it("the voided firing no longer holds the 24h cooldown: a real low reading later fires again", async () => {
    const { undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_0001", 1, ago(3));
    await tick(NOW - 2.5 * H);
    await undo("chk_low_0001");
    await snapshot("chk_low_0002", 2, ago(1));
    await tick(NOW);
    expect((await firings()).map(f => f.detected_at)).toEqual([new Date(NOW).toISOString()]);
  });

  it("his 'bad night' start and a stated missed dose keep holding; only low_spoons leaves the reasons", async () => {
    const { DB, undo, snapshot, tick } = setup();
    await DB.prepare(`INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('ev1', 'start', 'owner_said', 'owner_phrase', 'drevan', ?)`).bind(ago(4)).run();
    await DB.prepare(`INSERT INTO med_answers (slot_key, local_date, answered_at, companion_id, outcome) VALUES ('morning', '2026-10-30', ?, 'drevan', 'missed')`).bind(ago(3)).run();
    await snapshot("chk_low_0001", 0, ago(1));
    await tick(NOW - 0.5 * H);
    expect((await readCareHold(DB, NOW)).care_hold_reason).toEqual(["low_spoons", "meds_said_missed", "owner_said"]);

    await undo("chk_low_0001");
    expect(await readCareHold(DB, NOW)).toEqual({ care_hold: true, care_hold_reason: ["meds_said_missed", "owner_said"], care_hold_since: ago(4) });
    // No clear was written: a clear would have silenced both of those.
    expect((await DB.prepare(`SELECT COUNT(*) AS n FROM care_hold_events WHERE kind = 'clear'`).first()).n).toBe(0);
  });

  it("a different low reading that still stands keeps the firing (and the hold)", async () => {
    const { DB, undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_real", 2, ago(2));
    await snapshot("chk_low_oops", 1, ago(1));
    await tick(NOW - 0.5 * H);
    await undo("chk_low_oops");
    expect((await firings()).length).toBe(1);
    expect((await readCareHold(DB, NOW)).care_hold_reason).toEqual(["low_spoons"]);
  });

  it("the undone reading was superseded by a newer low one before the tick: that firing was never its, it stays", async () => {
    const { undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_oops", 1, ago(2));
    await snapshot("chk_low_real", 2, ago(1));
    await tick(NOW - 0.5 * H);
    await undo("chk_low_oops");
    expect((await firings()).length).toBe(1);
  });

  it("a firing that was already there before the check-in landed is not touched", async () => {
    const { undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_real", 1, ago(5));
    await tick(NOW - 4.5 * H);
    await snapshot("chk_low_oops", 0, ago(1)); // cooldown: the tick does not fire again
    await tick(NOW - 0.5 * H);
    expect((await firings()).length).toBe(1);
    await undo("chk_low_oops");
    expect((await firings()).length).toBe(1);
  });

  it("undoing a reading above the line touches nothing, even with a low_spoons firing in the window", async () => {
    const { undo, snapshot, tick, firings } = setup();
    await snapshot("chk_low_real", 1, ago(3));
    await tick(NOW - 2.5 * H);
    await snapshot("chk_ok_0001", 7, ago(1));
    const res = await undo("chk_ok_0001");
    expect(await res.json()).toEqual({ ok: true, id: "chk_ok_0001", care_firings_voided: 0 });
    expect((await firings()).length).toBe(1);
  });

  it("a retried POST (tapped hours ago, landed just now): the firing after it landed is voided", async () => {
    const { DB, undo, snapshot, tick, firings } = setup();
    // Tapped offline 6h ago, retried when Hearth opened 30 min ago.
    await snapshot("chk_low_late", 1, ago(6), ago(0.5));
    await tick(NOW - 0.25 * H);
    expect((await firings()).length).toBe(1);
    await undo("chk_low_late");
    expect(await firings()).toEqual([]);
    expect((await readCareHold(DB, NOW)).care_hold).toBe(false);
  });

  it("a row the tick had not seen yet (landed after the firing) never claims that firing", async () => {
    const { DB, snapshot, tick, firings } = setup();
    await snapshot("chk_low_real", 1, ago(2));
    await tick(NOW - 1.5 * H);
    // Recorded earlier but inserted after the tick ran; deleting it must not re-judge that firing as its.
    await snapshot("chk_low_late", 0, ago(1.75), ago(1));
    await DB.prepare(`UPDATE biometric_snapshots SET spoons = 9 WHERE id = 'chk_low_real'`).run(); // nothing else justifies it now
    expect(await firingsToVoid(DB, { id: "chk_low_late", spoons: 0, recorded_at: ago(1.75), logged_at: ago(1) }, NOW)).toEqual([]);
    expect((await firings()).length).toBe(1);
  });

  it("an undo that never landed anywhere is still a 404, and a stranger cannot undo", async () => {
    const { env, undo } = setup();
    expect((await undo("chk_missing_01")).status).toBe(404);
    const anon = await handleBiometricsDelete(new Request("http://x/biometrics/x", { method: "DELETE" }), env, { id: "chk_missing_01" });
    expect(anon.status).toBe(401);
  });
});

describe("lowSpoonsJustified mirrors the tick's low_spoons condition", () => {
  const at = "2026-10-31T07:00:00.000Z";
  it("at or below the line and fresh: justified; above the line, no spoons, stale or no row: not", () => {
    expect(lowSpoonsJustified({ spoons: 2, recorded_at: "2026-10-31T06:00:00.000Z" }, at)).toBe(true);
    expect(lowSpoonsJustified({ spoons: 3, recorded_at: "2026-10-31T06:00:00.000Z" }, at)).toBe(false);
    expect(lowSpoonsJustified({ spoons: null, recorded_at: "2026-10-31T06:00:00.000Z" }, at)).toBe(false);
    expect(lowSpoonsJustified({ spoons: 0, recorded_at: "2026-10-30T06:59:00.000Z" }, at)).toBe(false);
    expect(lowSpoonsJustified(null, at)).toBe(false);
    // The tick's own arithmetic (hoursSinceIso): an unparseable time reads as fresh there, so here too,
    // and a space-separated D1 time parses as UTC.
    expect(lowSpoonsJustified({ spoons: 1, recorded_at: "not a time" }, at)).toBe(true);
    expect(lowSpoonsJustified({ spoons: 1, recorded_at: "2026-10-30 07:00:00" }, at)).toBe(true);
    expect(lowSpoonsJustified({ spoons: 1, recorded_at: "2026-10-30 06:59:00" }, at)).toBe(false);
  });
});

describe("deployed before 0155 is applied (no voided_at column)", () => {
  const OLD = { upTo: 154 };

  it("the undo still deletes the snapshot, leaves the firing alone (no delete fallback), and answers 200", async () => {
    const { DB, undo, snapshot, tick, allRows } = setup(OLD);
    await snapshot("chk_low_0001", 1, ago(0.5));
    await tick(NOW - 0.25 * H);
    const res = await undo("chk_low_0001");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "chk_low_0001", care_firings_voided: 0 });
    expect((await allRows()).length).toBe(1);
    expect((await DB.prepare(`SELECT COUNT(*) AS n FROM biometric_snapshots`).first()).n).toBe(0);
    // Behaves as before this change: the firing still holds.
    expect((await readCareHold(DB, NOW)).care_hold_reason).toEqual(["low_spoons"]);
  });

  it("every reader falls back: hold, tick cooldown + pending, the pending-gesture read and the audit list", async () => {
    const { DB, env, snapshot, tick, firings } = setup(OLD);
    await snapshot("chk_low_0001", 1, ago(3));
    await tick(NOW - 2.5 * H);
    await snapshot("chk_low_0002", 0, ago(1));
    await tick(NOW); // cooldown read via the fallback: no second firing
    expect((await firings()).length).toBe(1);
    expect((await readCareHold(DB, NOW)).care_hold).toBe(true);
    const companion = (await DB.prepare(`SELECT companion_id FROM care_actions`).first()).companion_id;
    expect(await readPendingCare(DB, companion, ago(48))).not.toBeNull();
    const recent = await (await getCareRecent(new Request("http://x/care/recent"), env)).json() as any;
    expect(recent.care_actions.length).toBe(1);
    expect("voided_at" in recent.care_actions[0]).toBe(false);
  });

  it("the 0155 texts really need the column (so the fallback is what runs), and run on the full schema", async () => {
    const old = setup(OLD).DB;
    const cur = setup().DB;
    const cases: Array<[string, unknown[]]> = [
      [FIRED_SQL, []], [PENDING_RULES_SQL, [ago(48)]], [PENDING_CARE_SQL, ["cypher", ago(48)]],
      [UNDO_CANDIDATES_SQL, [ago(1), ago(0)]], [VOID_FIRING_SQL, [ago(0), "x"]],
    ];
    for (const [sql, binds] of cases) {
      await expect(old.prepare(sql).bind(...binds).run()).rejects.toThrow(/voided_at/);
      await expect(cur.prepare(sql).bind(...binds).run()).resolves.toBeDefined();
    }
  });
});

describe("a failed read or write is not a schema gap: no fallback, no half-done undo", () => {
  const is0155 = (sql: string) => /voided_at/.test(sql);

  async function firedState() {
    const t = setup();
    await t.snapshot("chk_low_0001", 1, ago(0.5));
    await t.tick(NOW - 0.25 * H);
    return t;
  }

  it("the hold read rethrows instead of running the pre-0155 text (which would count a voided firing)", async () => {
    const { DB } = await firedState();
    const f = flaky(DB, is0155);
    await expect(readCareHold(f.DB, NOW)).rejects.toThrow(/Network/);
    expect(f.prepared.length).toBe(1);
  });

  it("the pending read, the tick and the audit list rethrow too", async () => {
    const { DB, env } = await firedState();
    const f = flaky(DB, is0155);
    await expect(readPendingCare(f.DB, "cypher", ago(48))).rejects.toThrow(/Network/);
    expect(f.prepared.some(s => /care_actions/.test(s) && !/voided_at/.test(s))).toBe(false);
    await expect(runCareTick({ ...env, DB: f.DB }, NOW, { force: true })).rejects.toThrow(/Network/);
    await expect(getCareRecent(new Request("http://x/care/recent"), { ...env, DB: f.DB })).rejects.toThrow(/Network/);
  });

  it("the undo answers 500 and changes nothing when the candidate read fails", async () => {
    const { DB, env, firings } = await firedState();
    const f = flaky(DB, is0155);
    const res = await handleBiometricsDelete(new Request("http://x", { method: "DELETE", headers: { Authorization: "Bearer s" } }), { ...env, DB: f.DB }, { id: "chk_low_0001" });
    expect(res.status).toBe(500);
    expect((await DB.prepare(`SELECT COUNT(*) AS n FROM biometric_snapshots`).first()).n).toBe(1);
    expect((await firings()).length).toBe(1);
  });

  it("the undo answers 500 and keeps the snapshot when the void write fails, so Hearth's retry redoes both", async () => {
    const { DB, env, undo, firings } = await firedState();
    const f = flaky(DB, sql => /^\s*UPDATE care_actions SET voided_at/.test(sql));
    const res = await handleBiometricsDelete(new Request("http://x", { method: "DELETE", headers: { Authorization: "Bearer s" } }), { ...env, DB: f.DB }, { id: "chk_low_0001" });
    expect(res.status).toBe(500);
    expect((await DB.prepare(`SELECT COUNT(*) AS n FROM biometric_snapshots`).first()).n).toBe(1);
    // The retry against a healthy D1 does the whole undo.
    expect(await (await undo("chk_low_0001")).json()).toEqual({ ok: true, id: "chk_low_0001", care_firings_voided: 1 });
    expect(await firings()).toEqual([]);
  });
});
