// Needs you: one list of everything waiting on Raziel (open questions, ratifiable growth, live guardian flags, untriaged basin pressure).
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getRazielNeeds, getRazielNeedsCount } from "../handlers/raziel-needs.js";

function setup() {
  const { DB } = makeSqliteD1() as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const req = (path: string, auth = true) =>
    new Request(`http://x${path}`, { headers: auth ? { Authorization: "Bearer s" } : {} });
  const list = async (qs = "") => (await getRazielNeeds(req(`/raziel/needs${qs}`), env, {})).json() as Promise<any>;
  const count = async () => (await getRazielNeedsCount(req("/raziel/needs/count"), env, {})).json() as Promise<any>;
  const question = (id: string, status: string, at = "2026-10-01 10:00:00", ctx: string | null = "ctx") =>
    DB.prepare("INSERT INTO companion_questions (id, companion_id, question, context, status, created_at) VALUES (?, 'cypher', ?, ?, ?, ?)")
      .bind(id, `why ${id}?`, ctx, status, at).run();
  const growth = (id: string, source: string, review: string, tags: string[], at = "2026-10-01 10:00:00") =>
    DB.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, source, tags_json, review_status, created_at) VALUES (?, 'drevan', 'insight', ?, ?, ?, ?, ?)")
      .bind(id, `content ${id}`, source, JSON.stringify(tags), review, at).run();
  const flag = (id: string, status: string, companion: string | null, at = "2026-10-01 10:00:00", severity = "warning") =>
    DB.prepare("INSERT INTO guardian_flags (id, companion_id, flag_type, severity, summary, dedup_key, status, created_at) VALUES (?, ?, 'voice_drift', ?, ?, ?, ?, ?)")
      .bind(id, companion, severity, `summary ${id}`, `dk-${id}`, status, at).run();
  const basin = (id: string, type: string, confirmed: number, dismissed: string | null, worst: string | null, at = "2026-10-01 10:00:00") =>
    DB.prepare("INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, worst_basin, notes, recorded_at, dismissed_at) VALUES (?, 'gaia', 0.42, ?, ?, ?, 'a note', ?, ?)")
      .bind(id, type, confirmed, worst, at, dismissed).run();
  return { env, req, list, count, question, growth, flag, basin };
}

describe("raziel needs", () => {
  it("401 without bearer", async () => {
    const { env, req } = setup();
    expect((await getRazielNeeds(req("/raziel/needs", false), env, {})).status).toBe(401);
    expect((await getRazielNeedsCount(req("/raziel/needs/count", false), env, {})).status).toBe(401);
  });

  it("includes only open questions", async () => {
    const s = setup();
    await s.question("q_open", "open");
    await s.question("q_ans", "answered");
    await s.question("q_dis", "dismissed");
    const r = await s.list();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: "question", id: "q_open", key: "question:q_open", companion_id: "cypher", title: "why q_open?", detail: "ctx" });
    expect(r.counts.question).toBe(1);
  });

  it("growth uses the ratifiable predicate", async () => {
    const s = setup();
    await s.growth("g1", "autonomous", "pending", []);
    await s.growth("g2", "reflection", "pending", []);
    await s.growth("g3", "reflection", "pending", ["needs-raziel"]);
    await s.growth("g4", "autonomous", "accepted", []);
    const r = await s.list();
    expect(r.items.map((i: any) => i.id).sort()).toEqual(["g1", "g3"]);
    expect(r.items[0]).toMatchObject({ kind: "growth", title: expect.stringMatching(/^content /), detail: "insight" });
    expect(r.counts.growth).toBe(2);
  });

  it("guardian counts open and surfaced, not acknowledged or resolved", async () => {
    const s = setup();
    await s.flag("f1", "open", "gaia");
    await s.flag("f2", "surfaced", null, "2026-10-02 10:00:00", "red");
    await s.flag("f3", "acknowledged", "gaia");
    await s.flag("f4", "resolved", "gaia");
    const r = await s.list();
    expect(r.items.map((i: any) => i.id)).toEqual(["f2", "f1"]);
    expect(r.items[0]).toMatchObject({ kind: "guardian", companion_id: null, severity: "red", title: "summary f2", detail: "voice_drift" });
    expect(r.counts.guardian).toBe(2);
  });

  it("basin lists only untriaged pressure", async () => {
    const s = setup();
    await s.basin("b1", "pressure", 0, null, "warmth", "2026-10-03 11:00:00");
    await s.basin("b2", "growth", 0, null, "x");
    await s.basin("b3", "pressure", 1, null, "x");
    await s.basin("b4", "pressure", 0, "2026-10-04 00:00:00", "x");
    await s.basin("b5", "pressure", 0, null, null, "2026-10-02 11:00:00");
    const r = await s.list();
    expect(r.items.map((i: any) => i.id)).toEqual(["b1", "b5"]);
    expect(r.items[0]).toMatchObject({ kind: "basin", created_at: "2026-10-03 11:00:00", drift_score: 0.42, title: "warmth", detail: "a note" });
    expect(r.items[1].title).toBeNull();
    expect(r.counts.basin).toBe(2);
  });

  it("newest first across kinds and limit slices the list but not the counts", async () => {
    const s = setup();
    await s.question("q1", "open", "2026-10-01 10:00:00");
    await s.growth("g1", "autonomous", "pending", [], "2026-10-02 10:00:00");
    await s.flag("f1", "open", "gaia", "2026-10-03 10:00:00");
    await s.basin("b1", "pressure", 0, null, "w", "2026-10-04 10:00:00");
    const r = await s.list("?limit=2");
    expect(r.items.map((i: any) => i.key)).toEqual(["basin:b1", "guardian:f1"]);
    expect(r.counts).toEqual({ total: 4, question: 1, growth: 1, guardian: 1, basin: 1 });
  });

  it("count route matches list counts", async () => {
    const s = setup();
    await s.question("q1", "open");
    await s.flag("f1", "open", null);
    await s.basin("b1", "pressure", 0, null, null);
    expect(await s.count()).toEqual((await s.list()).counts);
  });
});
