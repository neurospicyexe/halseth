// Companion page rundown: what changed since Raziel last looked at a companion's page, door counts,
// and a 7-day trace of the three SOMA floats. Plus the "looked" write that advances the cutoff.
import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedJournal, seedSession } from "./helpers/sqlite-d1.js";
import { getRazielCompanion, postRazielCompanionLooked, buildTrace } from "../handlers/raziel-companion.js";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
// SQLite's own "YYYY-MM-DD HH:MM:SS" (UTC), the format datetime('now') writes.
const sqliteAgo = (days: number) => ago(days).replace("T", " ").slice(0, 19);

function setup() {
  const { DB, db } = makeSqliteD1() as { DB: any; db: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const req = (path: string, method = "GET", auth = true) =>
    new Request(`http://x${path}`, { method, headers: auth ? { Authorization: "Bearer s" } : {} });
  const get = async (id: string) => {
    const res = await getRazielCompanion(req(`/raziel/companion/${id}`), env, { id });
    return { status: res.status, body: (await res.json()) as any };
  };
  const looked = async (id: string) => {
    const res = await postRazielCompanionLooked(req(`/raziel/companion/${id}/looked`, "POST"), env, { id });
    return { status: res.status, body: (await res.json()) as any };
  };
  const setLooked = (id: string, at: string) =>
    db.prepare("INSERT INTO raziel_reads (item_kind, item_id, read_at) VALUES ('companion_page', ?, ?)").run(id, at);
  return { DB, db, env, req, get, looked, setLooked };
}

describe("raziel companion rundown", () => {
  it("rejects unknown companion", async () => {
    const s = setup();
    const g = await s.get("blue");
    expect(g.status).toBe(400);
    expect(g.body).toEqual({ error: "unknown companion" });
    const p = await s.looked("blue");
    expect(p.status).toBe(400);
    expect(p.body).toEqual({ error: "unknown companion" });
    // Case matters: Hearth lowercases before calling.
    expect((await s.get("Cypher")).status).toBe(400);
  });

  it("requires auth", async () => {
    const s = setup();
    expect((await getRazielCompanion(s.req("/raziel/companion/cypher", "GET", false), s.env, { id: "cypher" })).status).toBe(401);
    expect((await postRazielCompanionLooked(s.req("/raziel/companion/cypher/looked", "POST", false), s.env, { id: "cypher" })).status).toBe(401);
  });

  it("first visit counts the last 7 days", async () => {
    const s = setup();
    seedJournal(s.db, { id: "j_recent", agent: "cypher", created_at: ago(2) });
    seedJournal(s.db, { id: "j_old", agent: "cypher", created_at: ago(10) });
    seedJournal(s.db, { id: "j_other", agent: "gaia", created_at: ago(1) });
    const { status, body } = await s.get("cypher");
    expect(status).toBe(200);
    expect(body.companion_id).toBe("cypher");
    expect(body.since_basis).toBe("week");
    expect(body.last_looked_at).toBeNull();
    expect(body.since.journal).toBe(1);
    expect(body.doors.journal).toBe(1);
  });

  it("counts since last looked across timestamp formats", async () => {
    const s = setup();
    s.setLooked("cypher", "2026-10-30 12:00:00");
    seedJournal(s.db, { id: "j_after", agent: "cypher", created_at: "2026-10-30T12:01:00.000Z" });
    seedJournal(s.db, { id: "j_before", agent: "cypher", created_at: "2026-10-30T11:59:00.000Z" });
    const { body } = await s.get("cypher");
    expect(body.since_basis).toBe("last_looked");
    expect(body.last_looked_at).toBe("2026-10-30 12:00:00");
    expect(body.since.journal).toBe(1);
    expect(body.doors.journal).toBe(1);
  });

  it("letters are not journal", async () => {
    const s = setup();
    seedJournal(s.db, { id: "j_letter", agent: "cypher", created_at: ago(1), tags: JSON.stringify(["letter"]) } as any);
    seedJournal(s.db, { id: "j_plain", agent: "cypher", created_at: ago(1), tags: null } as any);
    seedJournal(s.db, { id: "j_tagged", agent: "cypher", created_at: ago(1), tags: JSON.stringify(["dream"]) } as any);
    let { body } = await s.get("cypher");
    expect(body.since.journal).toBe(2);
    expect(body.since.letters).toBe(1);
    expect(body.doors.letters_unread).toBe(1);
    s.db.prepare("INSERT INTO raziel_reads (item_kind, item_id, read_at) VALUES ('letter', 'j_letter', datetime('now'))").run();
    ({ body } = await s.get("cypher"));
    expect(body.doors.letters_unread).toBe(0);
    expect(body.since.letters).toBe(1);
  });

  it("journal counts only the substantive, non-clerk lane", async () => {
    const s = setup();
    seedJournal(s.db, { id: "j_speech", agent: "cypher", created_at: ago(1), source: "discord_speech" } as any);
    seedJournal(s.db, { id: "j_swarm", agent: "cypher", created_at: ago(1), source: "discord_swarm" } as any);
    seedJournal(s.db, { id: "j_clerk", agent: "cypher", created_at: ago(1), source: "synthesis-gap-detector" } as any);
    seedJournal(s.db, { id: "j_null", agent: "cypher", created_at: ago(1), source: null } as any);
    seedJournal(s.db, { id: "j_close", agent: "cypher", created_at: ago(1), source: "session_close" } as any);
    const { body } = await s.get("cypher");
    expect(body.since.journal).toBe(2);
    expect(body.doors.journal).toBe(2);
  });

  it("last_real_thing skips archaeology closes and other companions", async () => {
    const s = setup();
    // One handover per session (UNIQUE session_id).
    for (const [sid, cid] of [["s1", "cypher"], ["s2", "gaia"], ["s3", "cypher"], ["s4", "cypher"], ["s5", "cypher"]] as const) {
      seedSession(s.db, { id: sid, companion_id: cid });
    }
    const hp = (id: string, session: string, at: string, lrt: string | null, kind: string | null) =>
      s.db.prepare(
        "INSERT INTO handover_packets (id, session_id, created_at, spine, motion_state, last_real_thing, close_kind) VALUES (?, ?, ?, 'spine', 'at_rest', ?, ?)",
      ).run(id, session, at, lrt, kind);
    hp("h1", "s1", "2026-10-30T10:00:00.000Z", "reconstructed thing", "reconstructed");
    hp("h2", "s2", "2026-10-30 09:00:00", "gaia thing", null);
    hp("h3", "s3", "2026-10-30T08:00:00.000Z", "the real thing", null);
    hp("h4", "s4", "2026-10-30 07:59:00", "older thing", null);
    hp("h5", "s5", "2026-10-30T09:30:00.000Z", "   ", null);
    const { body } = await s.get("cypher");
    expect(body.last_real_thing).toEqual({ text: "the real thing", at: "2026-10-30T08:00:00.000Z" });
    expect((await s.get("drevan")).body.last_real_thing).toBeNull();
  });

  it("sol counts only Sol", async () => {
    const s = setup();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE name = 'Sol'").get() as { id: string };
    s.db.prepare("INSERT INTO creatures (id, name) VALUES ('cr_other', 'Moth')").run();
    const ci = (id: string, creature: string, actor: string, at: string) =>
      s.db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, created_at) VALUES (?, ?, ?, 'feed', ?)")
        .run(id, creature, actor, at);
    ci("ci1", sol.id, "cypher", sqliteAgo(1));
    ci("ci2", "cr_other", "cypher", sqliteAgo(1));
    ci("ci3", sol.id, "gaia", sqliteAgo(1));
    ci("ci4", sol.id, "cypher", sqliteAgo(9));
    expect((await s.get("cypher")).body.since.sol).toBe(1);
  });

  it("made counts successful images only", async () => {
    const s = setup();
    const call = (id: string, tool: string, status: string, ref: string | null) =>
      s.db.prepare("INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, result_ref, created_at) VALUES (?, 'cypher', ?, 'a', ?, ?, ?)")
        .run(id, tool, status, ref, sqliteAgo(1));
    call("t1", "generate_image", "success", "r2/key1");
    call("t2", "generate_image", "failed", null);
    call("t3", "web_search", "success", "ref");
    call("t4", "generate_image", "success", null);
    expect((await s.get("cypher")).body.doors.made).toBe(1);
  });

  it("counts the remaining sources since the cutoff", async () => {
    const s = setup();
    const at = sqliteAgo(1);
    const old = sqliteAgo(9);
    s.db.prepare("INSERT INTO books (id, title, file_key) VALUES ('b1', 'A Book', 'k')").run();
    // Mig 0040 seeds one relational-state row per companion at datetime('now'); start from empty.
    s.db.prepare("DELETE FROM companion_relational_state").run();
    for (const [i, t] of [at, old].entries()) {
      s.db.prepare("INSERT INTO book_annotations (book_id, author, created_at) VALUES ('b1', 'cypher', ?)").run(t);
      s.db.prepare("INSERT INTO autonomy_runs (id, companion_id, run_type, status, created_at) VALUES (?, 'cypher', 'explore', ?, ?)").run(`ar${i}`, i ? "completed" : "failed", t);
      s.db.prepare("INSERT INTO growth_journal (companion_id, entry_type, content, created_at) VALUES ('cypher', 'insight', 'c', ?)").run(t);
      s.db.prepare("INSERT INTO growth_patterns (companion_id, pattern_text, created_at) VALUES ('cypher', 'p', ?)").run(t);
      s.db.prepare("INSERT INTO growth_markers (companion_id, marker_type, description, created_at) VALUES ('cypher', 'm', 'd', ?)").run(t);
      s.db.prepare("INSERT INTO feelings (id, companion_id, emotion, created_at) VALUES (?, 'cypher', 'calm', ?)").run(`f${i}`, t);
      s.db.prepare("INSERT INTO companion_relational_state (id, companion_id, toward, state_text, noted_at) VALUES (?, 'cypher', 'raziel', 's', ?)").run(`rs${i}`, t);
      s.db.prepare("INSERT INTO companion_projects (id, companion_id, title, intention, created_at) VALUES (?, 'cypher', 't', 'i', ?)").run(`pr${i}`, t);
    }
    // Both relational_deltas row shapes (legacy companion_id, and MCP-logged agent + delta_text).
    const delta = (id: string, cid: string, agent: string | null, text: string | null, t: string) =>
      s.db.prepare("INSERT INTO relational_deltas (id, companion_id, subject_id, delta_type, payload_json, created_at, agent, delta_text) VALUES (?, ?, 'raziel', 'x', '{}', ?, ?, ?)")
        .run(id, cid, t, agent, text);
    delta("d1", "cypher", null, null, ago(1));
    delta("d2", "", "cypher", "moved", ago(1));
    delta("d3", "", "cypher", null, ago(1));
    delta("d4", "cypher", null, null, ago(9));
    // An old project worked on recently counts toward "up to".
    s.db.prepare("UPDATE companion_projects SET last_worked_at = ? WHERE id = 'pr1'").run(ago(1));

    const { body } = await s.get("cypher");
    expect(body.since.book_notes).toBe(1);
    expect(body.since.autonomy).toBe(1);
    expect(body.doors.growth).toBe(3);
    expect(body.doors.feelings).toBe(4); // feeling + relational state + 2 deltas
    expect(body.doors.upto).toBe(3); // 1 run + 2 projects (one new, one worked on)
  });

  it("handler trace has seven points per float, nulls when current is null", async () => {
    const s = setup();
    s.db.prepare("INSERT OR IGNORE INTO companion_state (companion_id) VALUES ('cypher')").run();
    s.db.prepare("UPDATE companion_state SET soma_float_1 = 0.6, soma_float_2 = NULL, soma_float_3 = 0.2 WHERE companion_id = 'cypher'").run();
    s.db.prepare(
      "INSERT INTO companion_soma_events (id, companion_id, float_key, delta, kind, writer, created_at) VALUES ('e1', 'cypher', 'soma_float_1', 0.1, 'tick', 'w', ?)",
    ).run(ago(0.01));
    const { body } = await s.get("cypher");
    for (const k of ["soma_float_1", "soma_float_2", "soma_float_3"]) expect(body.trace[k]).toHaveLength(7);
    expect(body.trace.soma_float_1[6]).toBe(0.6);
    expect(body.trace.soma_float_2).toEqual([null, null, null, null, null, null, null]);
    expect(body.trace.soma_float_3[6]).toBe(0.2);
  });

  it("looked upserts and advances", async () => {
    const s = setup();
    const a = await s.looked("gaia");
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    expect(typeof a.body.looked_at).toBe("string");
    s.db.prepare("UPDATE raziel_reads SET read_at = '2026-01-01 00:00:00' WHERE item_kind = 'companion_page' AND item_id = 'gaia'").run();
    const b = await s.looked("gaia");
    expect(b.body.looked_at > "2026-01-01 00:00:00").toBe(true);
    const rows = s.db.prepare("SELECT read_at FROM raziel_reads WHERE item_kind = 'companion_page' AND item_id = 'gaia'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at).toBe(b.body.looked_at);
    const g = await s.get("gaia");
    expect(g.body.since_basis).toBe("last_looked");
    expect(g.body.last_looked_at).toBe(b.body.looked_at);
  });
});

describe("buildTrace", () => {
  const nowMs = Date.parse("2026-10-30T15:00:00Z");
  const ev = (float_key: string, delta: number | null, before_value: number | null, after_value: number | null, created_at: string) =>
    ({ float_key, delta, before_value, after_value, created_at });

  it("walks deltas back from current", () => {
    const t = buildTrace(
      { soma_float_1: 0.6, soma_float_2: null, soma_float_3: 0.5 },
      [
        ev("soma_float_1", 0.1, null, null, "2026-10-30T09:00:00.000Z"),
        ev("soma_float_1", -0.2, null, null, "2026-10-27 12:00:00"),
        ev("soma_float_1", null, 0.3, 0.5, "2026-10-28T08:00:00Z"),
        ev("soma_float_2", 0.4, null, null, "2026-10-29T08:00:00Z"),
      ],
      nowMs,
    );
    expect(t.soma_float_1).toEqual([0.5, 0.5, 0.5, 0.3, 0.5, 0.5, 0.6]);
    expect(t.soma_float_2).toEqual([null, null, null, null, null, null, null]);
    expect(t.soma_float_3).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    for (const k of ["soma_float_1", "soma_float_2", "soma_float_3"] as const) expect(t[k]).toHaveLength(7);
  });

  it("ignores events before the window and with no usable delta", () => {
    const t = buildTrace(
      { soma_float_1: 0.6, soma_float_2: 0.6, soma_float_3: 0.6 },
      [
        ev("soma_float_1", 0.3, null, null, "2026-10-24T23:59:00Z"),
        ev("soma_float_2", null, 0.2, null, "2026-10-30T01:00:00Z"),
      ],
      nowMs,
    );
    expect(t.soma_float_1).toEqual([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
    expect(t.soma_float_2).toEqual([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
  });

  it("clamps to [0, 1]", () => {
    const t = buildTrace(
      { soma_float_1: 0.9, soma_float_2: 0.1, soma_float_3: null },
      [
        ev("soma_float_1", -0.5, null, null, "2026-10-29T12:00:00Z"),
        ev("soma_float_2", 0.5, null, null, "2026-10-29T12:00:00Z"),
      ],
      nowMs,
    );
    expect(t.soma_float_1).toEqual([1, 1, 1, 1, 1, 0.9, 0.9]);
    expect(t.soma_float_2).toEqual([0, 0, 0, 0, 0, 0.1, 0.1]);
  });
});
