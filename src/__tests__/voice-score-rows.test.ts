// GET /mind/voice-scores/:companion_id/rows (2026-11-01): raw rows for the voice drift loop's baseline +
// nightly job. Real SQLite (all migrations), because the handler leans on datetime() normalisation.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getVoiceScoreRows } from "../handlers/self-monitoring.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const ins = db.prepare(`INSERT INTO voice_scores (id, companion_id, score, positive_hits, anti_hits, contamination_hits, message_len, created_at) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?)`);
  // Mixed timestamp formats, as the table really holds them.
  ins.run("a", "drevan", 0.9, '["mk:v1"]', 120, "2026-10-18 01:00:00");
  ins.run("b", "drevan", 0.8, null, 80, "2026-10-20T12:00:00.000Z");
  ins.run("c", "drevan", 0.7, null, 60, "2026-10-20T12:00:00.000Z");
  ins.run("d", "drevan", 0.6, null, 40, "2026-11-02 00:00:00");
  ins.run("e", "gaia", 0.5, null, 20, "2026-10-21 00:00:00");
  return env;
}
const get = (env: any, qs: string, auth = "s", c = "drevan") =>
  getVoiceScoreRows(new Request(`https://h/mind/voice-scores/${c}/rows?${qs}`, { headers: { Authorization: `Bearer ${auth}` } }), env, { companion_id: c });

describe("voice score rows", () => {
  it("returns this companion's rows inside [from, to), oldest first, across timestamp formats, never an id or text", async () => {
    const res = await get(setup(), "from=2026-10-18T00:00:00Z&to=2026-11-01T00:00:00Z");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.rows.map((r: any) => r.score)).toEqual([0.9, 0.8, 0.7]);
    expect(Object.keys(body.rows[0]).sort()).toEqual(["anti_hits", "contamination_hits", "created_at", "message_len", "positive_hits", "score"]);
    expect(body.next_after).toBeUndefined();
  });
  it("pages with next_after, including ties on created_at", async () => {
    const env = setup();
    const p1: any = await (await get(env, "from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=2")).json();
    expect(p1.rows.map((r: any) => r.score)).toEqual([0.9, 0.8]);
    expect(p1.next_after).toBeTruthy();
    const p2: any = await (await get(env, `from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=2&after=${encodeURIComponent(p1.next_after)}`)).json();
    expect(p2.rows.map((r: any) => r.score)).toEqual([0.7]);
    expect(p2.next_after).toBeUndefined();
  });
  it("auth, bad companion, bad dates and bad cursor are refused", async () => {
    const env = setup();
    expect((await get(env, "", "nope")).status).toBe(401);
    expect((await get(env, "", "s", "someone")).status).toBe(400);
    expect((await get(env, "from=yesterday")).status).toBe(400);
    expect((await get(env, "after=nocursor")).status).toBe(400);
  });
});
