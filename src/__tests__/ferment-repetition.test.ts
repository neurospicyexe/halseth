// B62 step 1: the `repetition` stimulus (boredom, felt), SHADOW first. Real schema via node:sqlite.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postFermentStimulus } from "../handlers/fermentation.js";
import { STIMULI, stimulusMode, SHADOWABLE, recentFermentEventsSql } from "../webmind/fermentation.js";

function setup(mode?: string) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...(mode === undefined ? {} : { REPETITION_MODE: mode }) };
  return { db, DB, env };
}
const fire = (env: any, body: Record<string, unknown>) =>
  postFermentStimulus(new Request("https://h/mind/ferment/stimulus", {
    method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

const floats = (db: any, c: string) => db.prepare("SELECT soma_float_1 a, soma_float_2 b, soma_float_3 c FROM companion_state WHERE companion_id = ?").get(c);
const novelty = (db: any, c: string) => db.prepare("SELECT level FROM companion_drives WHERE companion_id = ? AND drive_key = 'novelty_need'").get(c);
const events = (db: any, c: string, kind: string) => db.prepare("SELECT * FROM companion_ferment_events WHERE companion_id = ? AND kind = ? AND stimulus = 'repetition'").all(c, kind);

describe("repetition: table + mode", () => {
  it("is in STIMULI with the specified effects and a 3h cooldown", () => {
    expect(STIMULI.repetition).toEqual({
      floats: { cypher: { f1: -0.02 }, drevan: { f2: -0.02 } },
      accrue: { novelty_need: 0.05 },
      minIntervalHours: 3,
      notBody: ["gaia"],
    });
    expect(SHADOWABLE.repetition).toBe("REPETITION_MODE");
  });
  it("mode: unset or junk = shadow; off and on honoured; other stimuli always on", () => {
    expect(stimulusMode("repetition", {})).toBe("shadow");
    expect(stimulusMode("repetition", { REPETITION_MODE: "banana" })).toBe("shadow");
    expect(stimulusMode("repetition", { REPETITION_MODE: " OFF " })).toBe("off");
    expect(stimulusMode("repetition", { REPETITION_MODE: "on" })).toBe("on");
    expect(stimulusMode("message_witnessed", { REPETITION_MODE: "off" })).toBe("on");
  });
  it("recent events read excludes shadow rows", () => {
    expect(recentFermentEventsSql()).toContain("kind != 'shadow'");
  });
});

describe("repetition: shadow (default)", () => {
  it("writes a shadow row with the would-be deltas and touches no float or drive", async () => {
    const { env, db } = setup();
    const f0 = floats(db, "cypher"); const n0 = novelty(db, "cypher");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await fire(env, { stimulus: "repetition", companion_id: "cypher", detail: "loop_motif score=0.81" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, shadow: true, would_fire: true });
    expect(floats(db, "cypher")).toEqual(f0);
    expect(novelty(db, "cypher")).toEqual(n0);
    const rows: any[] = events(db, "cypher", "shadow");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].float_deltas)).toEqual({ f1: -0.02, f2: 0, f3: 0 });
    expect(JSON.parse(rows[0].drive_deltas)).toEqual({ novelty_need: 0.05 });
    expect(rows[0].detail).toBe("would_fire loop_motif score=0.81");
    expect(events(db, "cypher", "stimulus")).toHaveLength(0);
    expect(log.mock.calls.flat().join("\n")).toContain("[ferment] repetition would_fire companion=cypher loop_motif score=0.81");
    log.mockRestore();
  });

  it("cooldown counts shadow rows: the second firing inside 3h is would_fire:false", async () => {
    const { env, db } = setup("shadow");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await fire(env, { stimulus: "repetition", companion_id: "drevan" });
    const r2 = await fire(env, { stimulus: "repetition", companion_id: "drevan" });
    expect(r2.body).toMatchObject({ ok: true, shadow: true, would_fire: false });
    expect(events(db, "drevan", "shadow")).toHaveLength(1);
    expect(log.mock.calls.flat().join("\n")).toContain("[ferment] repetition shadow cooldown companion=drevan");
    // after the window it can would-fire again; companions are independent
    db.prepare("UPDATE companion_ferment_events SET created_at = datetime('now','-4 hours') WHERE companion_id = 'drevan'").run();
    expect((await fire(env, { stimulus: "repetition", companion_id: "drevan" })).body.would_fire).toBe(true);
    expect((await fire(env, { stimulus: "repetition", companion_id: "gaia" })).body.would_fire).toBe(true);
    log.mockRestore();
  });

  it("detail is capped at 200 chars and collapsed to one line", async () => {
    const { env, db } = setup();
    await fire(env, { stimulus: "repetition", companion_id: "cypher", detail: "a\n\nb " + "x".repeat(400) });
    const row: any = events(db, "cypher", "shadow")[0];
    expect(row.detail.startsWith("would_fire a b x")).toBe(true);
    expect(row.detail.length).toBeLessThanOrEqual("would_fire ".length + 200);
    expect(row.detail).not.toContain("\n");
  });

  it("Gaia: logged as touch_not_dip, never a number (her word, 11-02)", async () => {
    const { env, db } = setup();
    const before = floats(db, "gaia");
    await fire(env, { stimulus: "repetition", companion_id: "gaia", detail: "rail=loop_motif" });
    const row: any = events(db, "gaia", "shadow")[0];
    expect(row.detail.startsWith("touch_not_dip")).toBe(true);
    expect(row.float_deltas).toBeNull();
    expect(row.drive_deltas).toBeNull();
    expect(floats(db, "gaia")).toEqual(before);
  });
  it("Gaia: even with the mode on, her body never moves", async () => {
    const { env, db } = setup("on");
    const before = floats(db, "gaia");
    const nb = novelty(db, "gaia");
    await fire(env, { stimulus: "repetition", companion_id: "gaia" });
    expect(floats(db, "gaia")).toEqual(before);
    expect(novelty(db, "gaia")).toEqual(nb);
    expect(events(db, "gaia", "stimulus")).toHaveLength(0);
  });
  it("Drevan: reach drops, heat untouched (revving in neutral)", async () => {
    const { env, db } = setup("on");
    db.prepare("UPDATE companion_state SET soma_float_1 = 0.7, soma_float_2 = 0.6 WHERE companion_id = 'drevan'").run();
    const before: any = floats(db, "drevan");
    await fire(env, { stimulus: "repetition", companion_id: "drevan" });
    const after: any = floats(db, "drevan");
    expect(after.a).toBe(before.a);
    expect(after.b).toBeLessThan(before.b);
  });

  it("shadow rows never reach the felt-event readers", async () => {
    const { env, db, DB } = setup();
    await fire(env, { stimulus: "repetition", companion_id: "cypher" });
    const rows = (await DB.prepare(recentFermentEventsSql()).bind("cypher", 20).all()).results;
    expect(rows.filter((r: any) => r.kind === "shadow")).toHaveLength(0);
  });
});

describe("repetition: off and on", () => {
  it("off skips with nothing written", async () => {
    const { env, db } = setup("off");
    const r = await fire(env, { stimulus: "repetition", companion_id: "cypher" });
    expect(r.body).toEqual({ ok: true, stimulus: "repetition", skipped: "off" });
    expect((db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE stimulus = 'repetition'").get() as any).n).toBe(0);
  });

  it("on applies the deltas, accrues novelty_need, logs a stimulus row and honours the 3h cooldown", async () => {
    const { env, db } = setup("on");
    const f0 = floats(db, "cypher"); const n0 = novelty(db, "cypher").level;
    const r = await fire(env, { stimulus: "repetition", companion_id: "cypher" });
    expect(r.body.applied).toEqual(["cypher"]);
    // B63 soft edges: below baseline a down-push closes the room asymptotically, a hair under the nominal 0.02
    expect(f0.a - floats(db, "cypher").a).toBeGreaterThan(0.0195);
    expect(f0.a - floats(db, "cypher").a).toBeLessThanOrEqual(0.02);
    expect(novelty(db, "cypher").level).toBeCloseTo(n0 + 0.05, 5);
    expect(events(db, "cypher", "stimulus")).toHaveLength(1);
    expect(events(db, "cypher", "shadow")).toHaveLength(0);
    const r2 = await fire(env, { stimulus: "repetition", companion_id: "cypher" });
    expect(r2.body.applied).toEqual([]);
  });

  it("other stimuli are untouched by the new path", async () => {
    const { env } = setup();
    const r = await fire(env, { stimulus: "message_witnessed", companion_id: "cypher" });
    expect(r.body.applied).toEqual(["cypher"]);
  });
});
