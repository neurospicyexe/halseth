// M5 (docs/PLAN-memory-map-2026-10-28.md), against the real schema: reference lanes read off columns
// that already name another row (concluded_in, in_thread, logged_on), title mentions from notes and
// conclusions (projects included), and people -- only the ones on Raziel's list, matched exactly.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { rebuildGraphDetailed } from "../graph/rebuild.js";
import { addPerson, archivePerson, listPeople } from "../graph/people.js";
import { loadMapNodes } from "../graph/map.js";
import { getMindPeople, postMindPeople } from "../handlers/people.js";

function envWith() {
  const { db, DB } = makeSqliteD1();
  return { db, env: { DB, ADMIN_SECRET: "s" } as any };
}
const edges = (db: any, type: string, dst?: string) =>
  db.prepare(`SELECT src_table, src_id, dst_table, dst_id, writer FROM graph_edges WHERE edge_type = ?${dst ? " AND dst_table = ?" : ""} ORDER BY src_id`)
    .all(...(dst ? [type, dst] : [type]));
const at = "2026-10-20T00:00:00Z";

describe("reference lanes", () => {
  it("concluded_in only for sessions that exist", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, session_type, companion_id, front_state) VALUES ('s1', ?, ?, 'work', 'cypher', 'raziel')").run(at, at);
    db.prepare(`INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, source_sessions) VALUES ('c1', 'cypher', 'a read', ?, '["s1","ghost"]')`).run(at);
    await rebuildGraphDetailed(env);
    expect(edges(db, "concluded_in")).toEqual([{ src_table: "companion_conclusions", src_id: "c1", dst_table: "sessions", dst_id: "s1", writer: "cypher" }]);
  });

  it("in_thread keys the thread by agent and key, and skips a key with no thread row", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO wm_mind_threads (thread_key, agent_id, title, created_at, updated_at, last_touched_at) VALUES ('k1', 'drevan', 'the bird', ?, ?, ?)").run(at, at, at);
    db.prepare("INSERT INTO wm_continuity_notes (note_id, agent_id, thread_key, content, created_at) VALUES ('n1', 'drevan', 'k1', 'x', ?), ('n2', 'drevan', 'nope', 'y', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    expect(edges(db, "in_thread")).toEqual([{ src_table: "wm_continuity_notes", src_id: "n1", dst_table: "wm_mind_threads", dst_id: "drevan:k1", writer: "drevan" }]);
    const nodes = await loadMapNodes(env, [{ table: "wm_mind_threads", id: "drevan:k1" }]);
    expect(nodes.get("wm_mind_threads/drevan:k1")?.label).toBe("the bird");
  });

  it("logged_on links a project log entry to its project; notes that name the project mention it", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_projects (id, companion_id, title, intention, status, created_at) VALUES ('p1', 'gaia', 'The Winged Bastard', 'make it', 'open', ?)").run(at);
    db.prepare("INSERT INTO project_log (id, project_id, companion_id, entry, created_at) VALUES ('l1', 'p1', 'gaia', 'wing done', ?)").run(at);
    db.prepare("INSERT INTO wm_continuity_notes (note_id, agent_id, content, created_at) VALUES ('n1', 'gaia', 'worked on the winged bastard today', ?)").run(at);
    await rebuildGraphDetailed(env);
    expect(edges(db, "logged_on")).toEqual([{ src_table: "project_log", src_id: "l1", dst_table: "companion_projects", dst_id: "p1", writer: "gaia" }]);
    expect(edges(db, "mentions", "companion_projects")).toEqual([{ src_table: "wm_continuity_notes", src_id: "n1", dst_table: "companion_projects", dst_id: "p1", writer: "gaia" }]);
  });
});

describe("people", () => {
  it("nobody is linked until named; then exact, case-sensitive matches only", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Blue came by after school', ?), ('j2', 'drevan', 'the sky went blue', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people")).toEqual([]);

    const r = await addPerson(env, { label: "Blue", kind: "person", added_by: "raziel" });
    expect(r.ok).toBe(true);
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people").map((e: any) => e.src_id)).toEqual(["j1"]);
  });

  it("a spelling two people share links to neither; archiving drops a person's links", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'cypher', 'Hermes said hi', ?), ('j2', 'cypher', 'Magpie fronted', ?)").run(at, at);
    await addPerson(env, { label: "Hermes (A)", match_names: ["Hermes"], added_by: "raziel" });
    await addPerson(env, { label: "Hermes (B)", match_names: ["Hermes"], added_by: "raziel" });
    const magpie = await addPerson(env, { label: "Magpie", kind: "headmate", added_by: "raziel" });
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people").map((e: any) => e.src_id)).toEqual(["j2"]);

    await archivePerson(env, (magpie as any).person.id);
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people")).toEqual([]);
  });

  it("refuses Raziel's own names, and never matches them even as another person's spelling", async () => {
    const { db, env } = envWith();
    expect((await addPerson(env, { label: "Crash", added_by: "raziel" })).ok).toBe(false);
    expect((await addPerson(env, { label: "raziel", added_by: "raziel" })).ok).toBe(false);
    const r: any = await addPerson(env, { label: "Jude", match_names: ["Crash"], added_by: "raziel" });
    expect(r.person.match_names).toEqual([]);
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Crash laughed', ?)").run(at);
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people")).toEqual([]);
  });

  it("refuses a duplicate or too-short name", async () => {
    const { env } = envWith();
    expect((await addPerson(env, { label: "Jo", added_by: "raziel" })).ok).toBe(false);
    await addPerson(env, { label: "Magpie", added_by: "raziel" });
    expect((await addPerson(env, { label: "Magpie", added_by: "raziel" })).ok).toBe(false);
    // The centre (mig 0150) is always first; Magpie was added as a person here.
    expect((await listPeople(env)).map((p) => p.label)).toEqual(["Raziel", "Magpie"]);
  });

  it("the endpoints add with added_by raziel and list with mention counts", async () => {
    const { db, env } = envWith();
    const auth = { Authorization: "Bearer s", "Content-Type": "application/json" };
    const add = await postMindPeople(new Request("https://x/mind/people", { method: "POST", headers: auth, body: JSON.stringify({ label: "Blue", kind: "person" }) }), env);
    expect(add.status).toBe(200);
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'gaia', 'Blue came by', ?)").run(at);
    // A draft (bot speech is born one) is linked by the rebuild but hidden on the map: not counted.
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at, review_state) VALUES ('j2', 'gaia', 'Blue again', ?, 'draft')").run(at);
    await rebuildGraphDetailed(env);
    const list: any = await (await getMindPeople(new Request("https://x/mind/people", { headers: auth }), env)).json();
    expect(list.people).toMatchObject([{ label: "Raziel", kind: "centre" }, { label: "Blue", kind: "person", added_by: "raziel", mentions: 1 }]);
  });
});

describe("graph_people read failure (L-2, 2026-10-29)", () => {
  // A transient D1 error on the people read used to read as "nobody on the list": every
  // mechanical:person / mechanical:front:* edge went stale and was deleted.
  const failingPeople = (env: any, message: string) => ({
    ...env,
    DB: {
      prepare: (sql: string) => {
        if (/FROM graph_people/.test(sql)) return { all: () => Promise.reject(new Error(message)) };
        return env.DB.prepare(sql);
      },
      batch: (stmts: any[]) => env.DB.batch(stmts),
    },
  });

  it("a transient error on the people read deletes nothing", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Blue came by', ?)").run(at);
    await addPerson(env, { label: "Blue", kind: "person", added_by: "raziel" });
    await rebuildGraphDetailed(env);
    const before = edges(db, "mentions", "graph_people");
    expect(before.length).toBe(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rebuildGraphDetailed(failingPeople(env, "D1_ERROR: network connection lost"));
    warn.mockRestore();
    expect(edges(db, "mentions", "graph_people")).toEqual(before);

    // And the next healthy run still converges: archiving now does delete.
    const [p] = (await listPeople(env)).filter((x) => x.label === "Blue");
    await archivePerson(env, p!.id);
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people")).toEqual([]);
  });

  it("a missing graph_people table still reads as an empty list (stale people edges go)", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Blue came by', ?)").run(at);
    await addPerson(env, { label: "Blue", kind: "person", added_by: "raziel" });
    await rebuildGraphDetailed(env);
    expect(edges(db, "mentions", "graph_people").length).toBe(1);
    await rebuildGraphDetailed(failingPeople(env, "D1_ERROR: no such table: graph_people"));
    expect(edges(db, "mentions", "graph_people")).toEqual([]);
  });
});
