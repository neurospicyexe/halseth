// Watchalong (migration 0142) -- the clock, the create/patch rules, and THE CUT.
//
// The cut is the property that matters: GET /active must never hand a bot a cue whose start is past
// the computed playhead, or the triad "knows" what happens next in a film they are watching for the
// first time. These run against real SQLite with every migration applied (helpers/sqlite-d1), so the
// `<=` boundary, CHECK constraints and FK are the real ones.

import { describe, it, expect } from "vitest";
import {
  computePlayhead, parseStoredTime, postWatchalong, patchWatchalong, getWatchalongActive, MAX_CUES,
} from "../handlers/watchalong.js";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import type { Env } from "../types.js";

const SECRET = "test-admin-secret";
const T0 = Date.parse("2026-10-03T02:00:00.000Z");

function setup() {
  const d1 = makeSqliteD1();
  const batchSizes: number[] = [];
  const realBatch = d1.DB.batch;
  d1.DB.batch = async (stmts: unknown[]) => { batchSizes.push(stmts.length); return realBatch(stmts as never); };
  const env = { DB: d1.DB, ADMIN_SECRET: SECRET } as unknown as Env;
  return { ...d1, env, batchSizes };
}

function req(method: string, path: string, body?: unknown, auth = true): Request {
  return new Request(`https://x${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) },
  });
}

const cue = (start_sec: number, text: string, kind = "line", end_sec = start_sec + 2) => ({ start_sec, end_sec, kind, text });

function film(extra: Record<string, unknown> = {}) {
  return {
    title: "Skinamarink", channel_id: "chan-1", source: "attachment", source_ref: "skinamarink.srt",
    cues: [cue(0, "[static hum]", "sound"), cue(10, "Where's Dad?"), cue(20, "♪ lullaby ♪", "music"), cue(30, "I'm scared."), cue(40, "[door creaks]", "sound", 45)],
    ...extra,
  };
}

async function create(env: Env, body: unknown = film(), now = T0) {
  const res = await postWatchalong(req("POST", "/mind/watchalong", body), env, now);
  return { res, body: await res.json() as Record<string, any> };
}
async function patch(env: Env, id: string, body: unknown, now: number) {
  const res = await patchWatchalong(req("PATCH", `/mind/watchalong/${id}`, body), env, id, now);
  return { res, body: await res.json() as Record<string, any> };
}
async function active(env: Env, qs: string, now: number) {
  const res = await getWatchalongActive(req("GET", `/mind/watchalong/active?${qs}`), env, now);
  return { res, body: await res.json() as Record<string, any> };
}

describe("computePlayhead -- the one clock", () => {
  const base = { playhead_sec: 100, playhead_set_at: new Date(T0).toISOString(), duration_sec: 5000 };

  it("playing advances with wall time", () => {
    expect(computePlayhead({ ...base, status: "playing" }, T0 + 30_000)).toBe(130);
  });
  it("paused and ended hold", () => {
    expect(computePlayhead({ ...base, status: "paused" }, T0 + 30_000)).toBe(100);
    expect(computePlayhead({ ...base, status: "ended" }, T0 + 30_000)).toBe(100);
  });
  it("clamps at duration and at 0", () => {
    expect(computePlayhead({ ...base, status: "playing" }, T0 + 10_000_000)).toBe(5000);
    expect(computePlayhead({ ...base, status: "paused", playhead_sec: -5 }, T0)).toBe(0);
  });
  it("no upper clamp when duration is unknown", () => {
    expect(computePlayhead({ ...base, status: "playing", duration_sec: null }, T0 + 10_000_000)).toBe(10_100);
  });
  it("a future set point (clock skew) never rewinds; garbage counts as zero elapsed", () => {
    expect(computePlayhead({ ...base, status: "playing" }, T0 - 60_000)).toBe(100);
    expect(computePlayhead({ ...base, status: "playing", playhead_set_at: "nope" }, T0 + 60_000)).toBe(100);
  });
  it("reads SQLite's datetime('now') form as UTC, not local time", () => {
    expect(parseStoredTime("2026-10-03 02:00:00")).toBe(T0);
    expect(computePlayhead({ ...base, status: "playing", playhead_set_at: "2026-10-03 02:00:00" }, T0 + 5_000)).toBe(105);
  });
});

describe("POST /mind/watchalong", () => {
  it("rejects without auth", async () => {
    const { env } = setup();
    const res = await postWatchalong(req("POST", "/mind/watchalong", film(), false), env, T0);
    expect(res.status).toBe(401);
  });

  it("creates a paused session at 0; duration defaults to the last cue end", async () => {
    const { env, db } = setup();
    const { res, body } = await create(env);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ cue_count: 5, duration_sec: 45, shelf_id: null });
    const row = db.prepare("SELECT status, playhead_sec, duration_sec FROM watchalong_sessions WHERE id = ?").get(body["id"]) as any;
    expect(row).toMatchObject({ status: "paused", playhead_sec: 0, duration_sec: 45 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchalong_cues WHERE session_id = ?").get(body["id"]) as any).n).toBe(5);
  });

  it("an explicit duration wins over the last cue end", async () => {
    const { env } = setup();
    expect((await create(env, film({ duration_sec: 6000 }))).body["duration_sec"]).toBe(6000);
  });

  it.each([
    ["bad kind", film({ cues: [cue(0, "x", "dialogue")] })],
    ["negative time", film({ cues: [cue(-1, "x")] })],
    ["non-finite time", { ...film(), cues: [{ start_sec: "10", end_sec: 12, kind: "line", text: "x" }] }],
    ["empty cues", film({ cues: [] })],
    ["empty text", film({ cues: [cue(0, "   ")] })],
    ["missing title", film({ title: "" })],
    ["title too long", film({ title: "x".repeat(201) })],
    ["missing channel", film({ channel_id: "" })],
    ["bad source", film({ source: "netflix" })],
    ["too many cues", film({ cues: Array.from({ length: MAX_CUES + 1 }, (_, i) => cue(i, `l${i}`)) })],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    const { env, db } = setup();
    const { res } = await create(env, body);
    expect(res.status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchalong_sessions").get() as any).n).toBe(0);
  });

  it("caps cue text at 500 chars, trims it, and coerces end<start to a zero-length cue", async () => {
    const { env, db } = setup();
    const { body } = await create(env, film({ cues: [{ start_sec: 10, end_sec: 5, kind: "line", text: `  ${"a".repeat(800)}  `, speaker: "KEVIN" }] }));
    const c = db.prepare("SELECT * FROM watchalong_cues WHERE session_id = ?").get(body["id"]) as any;
    expect(c.text.length).toBe(500);
    expect(c.end_sec).toBe(10);
    expect(c.speaker).toBe("KEVIN");
  });

  it("6000 cues land in batches of at most 100 statements", async () => {
    const { env, db, batchSizes } = setup();
    const cues = Array.from({ length: MAX_CUES }, (_, i) => cue(i, `line ${i}`));
    const { res, body } = await create(env, film({ cues }));
    expect(res.status).toBe(201);
    expect(body["cue_count"]).toBe(MAX_CUES);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchalong_cues").get() as any).n).toBe(MAX_CUES);
  });

  it("ends any prior live session in the SAME channel, and only that channel", async () => {
    const { env, db } = setup();
    const a = (await create(env, film({ channel_id: "chan-1" }), T0)).body["id"];
    const other = (await create(env, film({ channel_id: "chan-2" }), T0)).body["id"];
    const b = (await create(env, film({ channel_id: "chan-1", title: "The Thing" }), T0 + 1000)).body["id"];
    const st = (id: string) => db.prepare("SELECT status, ended_at FROM watchalong_sessions WHERE id = ?").get(id) as any;
    expect(st(a).status).toBe("ended");
    expect(st(a).ended_at).toBe(new Date(T0 + 1000).toISOString());
    expect(st(b).status).toBe("paused");
    expect(st(other).status).toBe("paused");
    expect((await active(env, "channel_id=chan-1", T0 + 2000)).body["session"]["id"]).toBe(b);
  });

  it("matches the watch shelf by title, case-insensitively", async () => {
    const { env, db } = setup();
    db.prepare("INSERT INTO watch_shelf (id, title, kind, status) VALUES ('shelf1', 'Skinamarink', 'movie', 'watching')").run();
    expect((await create(env, film({ title: "SKINAMARINK" }))).body["shelf_id"]).toBe("shelf1");
  });
});

describe("PATCH /mind/watchalong/:id", () => {
  it("seek + play starts the clock from the seek point", async () => {
    const { env } = setup();
    const { body: c } = await create(env, film({ duration_sec: 6000 }));
    const { res, body } = await patch(env, c["id"], { status: "playing", at_sec: 2832 }, T0 + 5000);
    expect(res.status).toBe(200);
    expect(body["session"]).toMatchObject({ status: "playing", playhead_sec: 2832 });
    expect((await active(env, "channel_id=chan-1", T0 + 65_000)).body["session"]["playhead_sec"]).toBe(2892);
  });

  it("pause materialises the running playhead (freezes where the film actually is)", async () => {
    const { env } = setup();
    const { body: c } = await create(env, film({ duration_sec: 6000 }));
    await patch(env, c["id"], { status: "playing", at_sec: 100 }, T0);
    const { body } = await patch(env, c["id"], { status: "paused" }, T0 + 90_000);
    expect(body["session"]).toMatchObject({ status: "paused", playhead_sec: 190 });
    expect((await active(env, "channel_id=chan-1", T0 + 999_000)).body["session"]["playhead_sec"]).toBe(190);
  });

  it("seek clamps to [0, duration]", async () => {
    const { env } = setup();
    const { body: c } = await create(env);
    expect((await patch(env, c["id"], { at_sec: 9999 }, T0)).body["session"]["playhead_sec"]).toBe(45);
    expect((await patch(env, c["id"], { at_sec: -20 }, T0)).body["session"]["playhead_sec"]).toBe(0);
  });

  it("ended sets ended_at; a second patch is 409; it is no longer active", async () => {
    const { env } = setup();
    const { body: c } = await create(env);
    const { body } = await patch(env, c["id"], { status: "ended" }, T0 + 1000);
    expect(body["session"]).toMatchObject({ status: "ended", ended_at: new Date(T0 + 1000).toISOString() });
    expect((await patch(env, c["id"], { status: "playing" }, T0 + 2000)).res.status).toBe(409);
    expect((await active(env, "channel_id=chan-1", T0 + 3000)).body).toEqual({ session: null, cues: [], skipped: 0 });
  });

  it("404 for an unknown id; 400 for a bad status, non-finite at_sec, or an empty body", async () => {
    const { env } = setup();
    expect((await patch(env, "nope", { status: "playing" }, T0)).res.status).toBe(404);
    const { body: c } = await create(env);
    expect((await patch(env, c["id"], { status: "rewinding" }, T0)).res.status).toBe(400);
    expect((await patch(env, c["id"], { at_sec: "47:12" }, T0)).res.status).toBe(400);
    expect((await patch(env, c["id"], {}, T0)).res.status).toBe(400);
  });
});

describe("GET /mind/watchalong/active -- the cut", () => {
  it("null session when the channel has none", async () => {
    const { env } = setup();
    expect((await active(env, "channel_id=empty", T0)).body).toEqual({ session: null, cues: [], skipped: 0 });
  });

  it("400 without channel_id", async () => {
    const { env } = setup();
    expect((await active(env, "", T0)).res.status).toBe(400);
  });

  it("never returns a cue past the playhead; the boundary cue (start == playhead) is included", async () => {
    const { env } = setup();
    const { body: c } = await create(env);
    await patch(env, c["id"], { status: "playing", at_sec: 0 }, T0);
    const { body } = await active(env, "channel_id=chan-1", T0 + 20_000);
    expect(body["session"]).toMatchObject({ id: c["id"], title: "Skinamarink", status: "playing", playhead_sec: 20, duration_sec: 45, cue_count: 5, source: "attachment" });
    expect(body["cues"].map((x: any) => x.start_sec)).toEqual([0, 10, 20]);
    for (const x of body["cues"]) expect(x.start_sec).toBeLessThanOrEqual(20);
    expect(body["cues"][0]).toEqual({ idx: 0, start_sec: 0, end_sec: 2, kind: "sound", speaker: null, text: "[static hum]" });
    expect(body["skipped"]).toBe(0);
  });

  it("paused at 0 shows only cues at 0; a paused film never leaks ahead however long it sits", async () => {
    const { env } = setup();
    await create(env);
    const { body } = await active(env, "channel_id=chan-1", T0 + 3_600_000);
    expect(body["cues"].map((x: any) => x.start_sec)).toEqual([0]);
  });

  it("since_sec is exclusive: only the delta since the last delivery", async () => {
    const { env } = setup();
    const { body: c } = await create(env);
    await patch(env, c["id"], { status: "paused", at_sec: 45 }, T0);
    const { body } = await active(env, "channel_id=chan-1&since_sec=10", T0);
    expect(body["cues"].map((x: any) => x.start_sec)).toEqual([20, 30, 40]);
    expect((await active(env, "channel_id=chan-1&since_sec=40", T0)).body["cues"]).toEqual([]);
  });

  it("max_cues keeps the LAST N in range and reports how many were skipped", async () => {
    const { env } = setup();
    const { body: c } = await create(env);
    await patch(env, c["id"], { status: "paused", at_sec: 45 }, T0);
    const { body } = await active(env, "channel_id=chan-1&max_cues=2", T0);
    expect(body["cues"].map((x: any) => x.start_sec)).toEqual([30, 40]);
    expect(body["skipped"]).toBe(3);
  });

  it("max_cues defaults to 80 and caps at 300", async () => {
    const { env } = setup();
    const cues = Array.from({ length: 400 }, (_, i) => cue(i, `l${i}`));
    const { body: c } = await create(env, film({ cues }));
    await patch(env, c["id"], { status: "paused", at_sec: 1000 }, T0);
    const def = (await active(env, "channel_id=chan-1", T0)).body;
    expect(def["cues"]).toHaveLength(80);
    expect(def["skipped"]).toBe(320);
    expect(def["cues"].at(-1).start_sec).toBe(399);
    const big = (await active(env, "channel_id=chan-1&max_cues=5000", T0)).body;
    expect(big["cues"]).toHaveLength(300);
    expect(big["skipped"]).toBe(100);
  });
});
