// Fixes from the 2026-11-01 review of the build batch (halseth-reviewer, verdict "ship after fixes").
//   W1: the check-in undo must skip bridge rows exactly as the tick does.
//   W2: only the admin token writes bridge rows, and recorded_at is clamped into its day, never future.
//   W3: the stress detail uses Raziel's pronouns (they/them, ruled 2026-10-07).
//   + feeling vocabulary: a companion token reads only its own vocabulary.
//   + "toward <name>:" refuses a sentence-length name instead of writing it.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { UNDO_LATEST_AT_SQL, UNDO_LATEST_NOW_SQL } from "../care/undo.js";
import { STRESS_DETAIL } from "../care/rules.js";
import { handleBiometricsWellnessPut } from "../handlers/biometrics.js";
import { getFeelingVocabulary } from "../handlers/feeling-vocabulary.js";
import { parseRelationalRequest } from "../librarian/executors/webmind.js";

function setup() {
  const { DB, db } = makeSqliteD1() as { DB: any; db: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dre", GAIA_MCP_SECRET: "gai" };
  const put = (day: string, body: unknown, token = "s") => handleBiometricsWellnessPut(
    new Request("http://x/biometrics/wellness/" + day, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env, { day });
  return { DB, db, env, put };
}

describe("W1: undo reads skip bridge rows", () => {
  it("the 'now' and 'then' reads return the hand reading, not a newer bridge row", async () => {
    const { DB, put } = setup();
    await DB.prepare("INSERT INTO biometric_snapshots (id, recorded_at, logged_at, spoons, source) VALUES ('handA', '2026-11-01T13:00:00.000Z', '2026-11-01T13:00:00.000Z', 2, 'hearth'), ('handB', '2026-11-01T13:01:00.000Z', '2026-11-01T13:01:00.000Z', 2, 'hearth')").run();
    expect((await put("2026-11-01", { stress_score: 10, recorded_at: "2026-11-01T14:00:00Z" })).status).toBe(200);
    const now = await DB.prepare(UNDO_LATEST_NOW_SQL).bind("handB").first();
    expect(now).toMatchObject({ spoons: 2, recorded_at: "2026-11-01T13:00:00.000Z" });
    const then = await DB.prepare(UNDO_LATEST_AT_SQL).bind(new Date().toISOString(), "handB").first();
    expect(then).toMatchObject({ spoons: 2, recorded_at: "2026-11-01T13:00:00.000Z" });
  });
});

describe("W2: the bridge write route", () => {
  it("refuses a companion token", async () => {
    const { put } = setup();
    expect((await put("2026-11-01", { stress_score: 90 }, "gai")).status).toBe(403);
    expect((await put("2026-11-01", { stress_score: 90 }, "dre")).status).toBe(403);
  });
  it("clamps a future recorded_at to now", async () => {
    const { DB, put } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const before = Date.now();
    expect((await put(today, { stress_score: 70, recorded_at: future })).status).toBe(200);
    const row = await DB.prepare("SELECT recorded_at FROM biometric_snapshots WHERE id = ?").bind(`wellness_${today}`).first();
    expect(Date.parse(row.recorded_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(row.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
  });
  it("refuses a recorded_at outside that day's window", async () => {
    const { put } = setup();
    expect((await put("2026-10-01", { stress_score: 70, recorded_at: "2026-11-01T12:00:00Z" })).status).toBe(400);
    expect((await put("2026-10-02", { stress_score: 70, recorded_at: "2026-09-30T12:00:00Z" })).status).toBe(400);
  });
  it("a past day with no recorded_at lands inside that day, not today", async () => {
    const { DB, put } = setup();
    expect((await put("2026-10-01", { stress_score: 20 })).status).toBe(200);
    const row = await DB.prepare("SELECT recorded_at FROM biometric_snapshots WHERE id = 'wellness_2026-10-01'").first();
    expect(row.recorded_at < "2026-10-03").toBe(true);
    expect(row.recorded_at >= "2026-10-01").toBe(true);
  });
});

describe("W3: pronouns", () => {
  it("the stress detail never says he/his/him", () => {
    expect(STRESS_DETAIL).not.toMatch(/\b(he|his|him)\b/i);
    expect(STRESS_DETAIL).toMatch(/\btheir\b/);
  });
});

describe("feeling vocabulary read: distinct selves", () => {
  const get = (env: any, token: string, companion?: string) => getFeelingVocabulary(
    new Request(`http://x/mind/feeling-vocabulary${companion ? `?companion_id=${companion}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }), env);
  it("a companion reads its own; never a sibling's; admin reads any", async () => {
    const { env } = setup();
    expect((await get(env, "gai", "gaia")).status).toBe(200);
    expect((await get(env, "gai")).status).toBe(200);
    expect((await get(env, "gai", "drevan")).status).toBe(403);
    expect((await get(env, "s", "drevan")).status).toBe(200);
  });
});

describe("toward <name>: length cap", () => {
  it("a sentence is not a name", () => {
    expect(parseRelationalRequest("note toward the end of the day when everything went quiet: tired")).toBeNull();
    expect(parseRelationalRequest("witness toward Barbossa (Blue): steady")?.toward).toBe("barbossa (blue)");
  });
});
