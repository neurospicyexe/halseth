// B8, the wellness bridge (halseth half): the stress_elevated rule, the per-day upsert, and the
// guarantee that machine rows never masquerade as a hand-entered check-in anywhere a check-in is read.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  evaluateCareRules, assignCompanion, STRESS_ELEVATED_MIN, STRESS_FRESH_HOURS, RULE_COOLDOWN_HOURS, CARE_HOLD_ACTION_RULES,
  type CareSignals,
} from "../care/rules.js";
import { runCareTick, STRESS_ROW_SQL } from "../care/tick.js";
import { readOwnerLastSeen } from "../care/owner-activity.js";
import { readCareHold } from "../care/hold.js";
import { handleBiometricsWellnessPut, handleBiometricsLatest, handleBiometricsList } from "../handlers/biometrics.js";

const quiet: CareSignals = {
  spoons: null, mood: null, meds_taken: null, biometrics_age_hours: null, meds_logged_age_hours: null,
  owner_silence_hours: null, owner_last_source: null, last_fired_hours: {},
};

describe("stress_elevated rule", () => {
  const hot = { ...quiet, stress_score: STRESS_ELEVATED_MIN, stress_age_hours: 3 };
  it("fires at the line with fresh data, and the detail carries no figures", () => {
    const out = evaluateCareRules(hot);
    expect(out.map(f => f.rule)).toEqual(["stress_elevated"]);
    expect(out[0]!.detail).not.toMatch(/\d/);
  });
  it("silent below the line, on stale data, and on absent data", () => {
    expect(evaluateCareRules({ ...hot, stress_score: STRESS_ELEVATED_MIN - 1 })).toEqual([]);
    expect(evaluateCareRules({ ...hot, stress_age_hours: STRESS_FRESH_HOURS + 1 })).toEqual([]);
    expect(evaluateCareRules({ ...hot, stress_score: null })).toEqual([]);
    expect(evaluateCareRules({ ...hot, stress_age_hours: null })).toEqual([]);
    expect(evaluateCareRules(quiet)).toEqual([]);
  });
  it("24h cooldown, re-arms after", () => {
    expect(evaluateCareRules({ ...hot, last_fired_hours: { stress_elevated: RULE_COOLDOWN_HOURS.stress_elevated - 1 } })).toEqual([]);
    expect(evaluateCareRules({ ...hot, last_fired_hours: { stress_elevated: RULE_COOLDOWN_HOURS.stress_elevated + 1 } })).toHaveLength(1);
  });
  it("is always Gaia's, every day, never rotated", () => {
    for (let d = 0; d < 9; d++) expect(assignCompanion("stress_elevated", d)).toBe("gaia");
  });
  it("does not enter the care hold", () => {
    expect(CARE_HOLD_ACTION_RULES).not.toContain("stress_elevated");
  });
});

function setup(opts: { upTo?: number } = {}) {
  const { DB, db } = makeSqliteD1(opts) as { DB: any; db: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const req = (method: string, body?: unknown, url = "http://x/biometrics") =>
    new Request(url, { method, headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const put = (day: string, body: unknown) => handleBiometricsWellnessPut(req("PUT", body), env, { day });
  return { DB, db, env, req, put };
}

describe("PUT /biometrics/wellness/:day", () => {
  it("upserts one row per day, converges on re-run, keeps a field a later run could not read", async () => {
    const { DB, put } = setup();
    expect((await put("2026-11-01", { hrv_resting: 41.2, resting_hr: 58, sleep_hours: 7.1, steps: 2000, stress_score: 20, recorded_at: "2026-11-01T14:00:00Z" })).status).toBe(200);
    await put("2026-11-01", { hrv_resting: 40.0, resting_hr: 59, steps: 3000, stress_score: 25, recorded_at: "2026-11-01T21:00:00Z" });
    const rows = await DB.prepare("SELECT * FROM biometric_snapshots WHERE source = 'wellness'").all();
    expect(rows.results).toHaveLength(1);
    const r = rows.results[0];
    expect(r.id).toBe("wellness_2026-11-01");
    expect(r.hrv_resting).toBe(40);
    expect(r.sleep_hours).toBe(7.1);
    expect(r.recorded_at).toBe("2026-11-01T21:00:00.000Z");
    expect(r.spoons).toBeNull();
    expect(r.mood).toBeNull();
  });
  it("rejects a bad day; out-of-range values become null, never a clamp", async () => {
    const { DB, put } = setup();
    expect((await put("2026-13-45", {})).status).toBe(400);
    expect((await put("nope", {})).status).toBe(400);
    await put("2026-10-30", { hrv_resting: 9999, resting_hr: 60 });
    const r = await DB.prepare("SELECT * FROM biometric_snapshots WHERE id = 'wellness_2026-10-30'").first();
    expect(r.hrv_resting).toBeNull();
    expect(r.resting_hr).toBe(60);
  });
  it("requires auth", async () => {
    const { env } = setup();
    const res = await handleBiometricsWellnessPut(new Request("http://x", { method: "PUT", body: "{}" }), env, { day: "2026-11-01" });
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

describe("machine rows never read as a check-in", () => {
  async function seed() {
    const s = setup();
    const t = new Date(Date.now() - 5 * 3600e3).toISOString();
    await s.DB.prepare(`INSERT INTO biometric_snapshots (id, recorded_at, logged_at, source, spoons, mood) VALUES ('h1', ?, ?, 'hearth', 2, 'low')`).bind(t, t).run();
    await s.put("2026-11-01", { hrv_resting: 20, resting_hr: 85, stress_score: 90, recorded_at: new Date().toISOString() });
    return s;
  }
  it("Hearth's latest/list skip them; ?source=wellness reads them", async () => {
    const { env, req } = await seed();
    expect(((await (await handleBiometricsLatest(req("GET"), env)).json()) as any).id).toBe("h1");
    expect(((await (await handleBiometricsList(req("GET"), env)).json()) as any[]).map(r => r.id)).toEqual(["h1"]);
    const w = (await (await handleBiometricsList(req("GET", undefined, "http://x/biometrics?source=wellness"), env)).json()) as any[];
    expect(w.map(r => r.id)).toEqual(["wellness_2026-11-01"]);
  });
  it("a bridge write is not owner activity", async () => {
    const { DB, put, env } = setup();
    await DB.prepare(`DELETE FROM biometric_snapshots`).run();
    await put("2026-11-01", { steps: 10 });
    const seen = await readOwnerLastSeen(env);
    expect(seen?.source).not.toBe("biometrics");
  });
  it("the tick still reads his spoons through a newer bridge row, and fires stress_elevated to Gaia", async () => {
    const { DB, env } = await seed();
    await runCareTick(env, Date.now(), { force: true });
    const rows = (await DB.prepare("SELECT rule, companion_id, detail FROM care_actions ORDER BY rule").all()).results as any[];
    expect(rows.map(r => r.rule)).toEqual(["low_spoons", "stress_elevated"]);
    const s = rows.find(r => r.rule === "stress_elevated");
    expect(s.companion_id).toBe("gaia");
    expect(s.detail).not.toMatch(/\d/);
    // The hold derives from low_spoons only: stress adds no second derivation.
    expect((await readCareHold(DB)).care_hold_reason).toEqual(["low_spoons"]);
  });
  it("a stalled watch (old wearable day) does not fire; the scored-row read is real SQL", async () => {
    const { DB, env, put } = setup();
    await put("2026-10-20", { stress_score: 95, recorded_at: "2026-10-21T04:59:59Z" });
    expect((await DB.prepare(STRESS_ROW_SQL).first())?.stress_score).toBe(95);
    await runCareTick(env, Date.now(), { force: true });
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM care_actions").first()).n).toBe(0);
  });
  it("pre-0162 schema: the tick skips the stress firing and does not throw", async () => {
    const { DB, env, put } = setup({ upTo: 161 });
    await put("2026-11-01", { stress_score: 95, recorded_at: new Date().toISOString() });
    await expect(runCareTick(env, Date.now(), { force: true })).resolves.toBeDefined();
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM care_actions").first()).n).toBe(0);
  });
  it("0162 keeps existing care_actions rows, voided_at included", async () => {
    const { DB, db } = setup({ upTo: 161 });
    await DB.prepare(`INSERT INTO care_actions (id, rule, companion_id, detail, detected_at, voided_at) VALUES ('a','low_spoons','cypher','d','2026-10-30T00:00:00Z','2026-10-30T01:00:00Z')`).run();
    db.exec(fs.readFileSync(path.join(process.cwd(), "migrations", "0162_care_stress_elevated.sql"), "utf8"));
    const r = await DB.prepare("SELECT * FROM care_actions WHERE id = 'a'").first();
    expect(r.voided_at).toBe("2026-10-30T01:00:00Z");
    await DB.prepare(`INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('b','stress_elevated','gaia','d','2026-10-30T00:00:00Z')`).run();
  });
});
