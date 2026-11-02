// The map keep-off list (mig 0152, graph/keep-off.ts). Drevan's FERPA point: a child's name that is not
// a sprout, or Raziel's school, must never become a dot -- by design, not by remembering to redact.
// Real schema, real statements: the guarantee is which rows come back from the one labeler.
//
// Pinned down here:
//   - a listed term hides its rows from the map, from linking, and from the [Linked] labeler;
//   - whole word, case-insensitive: "Ava" hides "ava" and "Ava's" but not "Avalon";
//   - the row itself is untouched; archiving the term brings it straight back;
//   - an unreadable list fails CLOSED (no nodes), never open;
//   - only Raziel's admin token reads or edits the list.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { buildMap, loadMapNodes } from "../graph/map.js";
import { makeLink } from "../graph/links.js";
import { loadNeighborhoodNodes } from "../graph/labels.js";
import { addKeepOff, archiveKeepOff, keepOffMatcher } from "../graph/keep-off.js";
import { getMindKeepOff, postMindKeepOff } from "../handlers/keep-off.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "admin-tok", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dre-tok" };
  return { db: db as any, env };
}
function journal(db: any, id: string, text: string, agent = "drevan") {
  db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text, review_state, archived) VALUES (?, ?, ?, ?, 'kept', 0)")
    .run(id, "2026-10-20T00:00:00Z", agent, text);
}
function edge(db: any, src: string, dst: string) {
  const [st, si] = src.split("/");
  const [dt, di] = dst.split("/");
  db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES (?, ?, ?, ?, 'mentions', 'drevan', 'mechanical', ?)")
    .run(st, si, dt, di, "2026-10-20T00:00:00Z");
}
const keys = async (env: any, refs: Array<[string, string]>) =>
  [...(await loadMapNodes(env, refs.map(([table, id]) => ({ table, id })))).keys()].sort();

describe("keep-off list", () => {
  it("a listed name hides its row from the map; the row itself is untouched", async () => {
    const { db, env } = setup();
    journal(db, "j1", "Picked Ava up from practice with her mom, long day.");
    journal(db, "j2", "The hens ran the yard all afternoon.");
    edge(db, "companion_journal/j1", "companion_journal/j2");
    await addKeepOff(env, { term: "Ava", by: "raziel" });
    expect(await keys(env, [["companion_journal", "j1"], ["companion_journal", "j2"]])).toEqual(["companion_journal/j2"]);
    const m = await buildMap(env, { reader: "raziel", center: { table: "companion_journal", id: "j2" } });
    expect(m.nodes.map((n) => n.key)).not.toContain("companion_journal/j1");
    expect(m.edges).toHaveLength(0);
    expect(db.prepare("SELECT note_text FROM companion_journal WHERE id = 'j1'").get().note_text).toMatch(/Ava/);
  });

  it("whole word, any case: hides 'ava' and \"Ava's\", never 'Avalon'", async () => {
    const { db, env } = setup();
    journal(db, "a", "talked to ava today");
    journal(db, "b", "Ava's drawing was on the fridge");
    journal(db, "c", "Avalon, the book, finally finished");
    await addKeepOff(env, { term: "Ava", by: "raziel" });
    expect(await keys(env, [["companion_journal", "a"], ["companion_journal", "b"], ["companion_journal", "c"]])).toEqual(["companion_journal/c"]);
  });

  it("a held-back row can be neither linked nor named at boot", async () => {
    const { db, env } = setup();
    journal(db, "j1", "Ava's school pickup ran late.");
    journal(db, "j2", "A quiet morning.");
    await addKeepOff(env, { term: "Ava", by: "raziel" });
    const r = await makeLink(env, { writer: "drevan", src: { kind: "journal", id: "j1" }, dst: { kind: "journal", id: "j2" }, via: "librarian" });
    expect(r.ok).toBe(false);
    const q = await makeLink(env, { writer: "drevan", src: { kind: "journal", quote: "school pickup" }, dst: { kind: "journal", id: "j2" }, via: "librarian" });
    expect(q.ok).toBe(false);
    const named = await loadNeighborhoodNodes(env, [{ src_table: "companion_journal", src_id: "j1", dst_table: "companion_journal", dst_id: "j2" }] as any);
    expect([...named.keys()]).toEqual(["companion_journal/j2"]);
  });

  it("archiving the term brings the row straight back", async () => {
    const { db, env } = setup();
    journal(db, "j1", "Ava came over with her dad.");
    const t: any = await addKeepOff(env, { term: "ava", by: "raziel" });
    expect(await keys(env, [["companion_journal", "j1"]])).toEqual([]);
    expect(await archiveKeepOff(env, t.row.id)).toBe(true);
    expect(await keys(env, [["companion_journal", "j1"]])).toEqual(["companion_journal/j1"]);
  });

  it("an empty list filters nothing; a duplicate term is a no-op; bad lengths are refused", async () => {
    const { env } = setup();
    expect(await keepOffMatcher(env)).toBeNull();
    expect((await addKeepOff(env, { term: "Ava", by: "raziel" }) as any).changed).toBe(true);
    expect((await addKeepOff(env, { term: "AVA", by: "raziel" }) as any).changed).toBe(false);
    expect((await addKeepOff(env, { term: "A", by: "raziel" })).ok).toBe(false);
  });

  it("fails closed: an unreadable list yields no nodes", async () => {
    const { db, env } = setup();
    journal(db, "j1", "A quiet morning.");
    db.exec("DROP TABLE map_keep_off");
    expect(await keys(env, [["companion_journal", "j1"]])).toEqual([]);
  });

  it("only Raziel's admin token reads or edits the list", async () => {
    const { env } = setup();
    const req = (tok: string, body?: unknown) => new Request("https://h/mind/keep-off", {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const tok of ["dre-tok", "m"]) {
      expect((await getMindKeepOff(req(tok), env)).status).toBe(403);
      expect((await postMindKeepOff(req(tok, { term: "Ava" }), env)).status).toBe(403);
    }
    expect((await postMindKeepOff(req("admin-tok", { term: "Ava" }), env)).status).toBe(200);
    const list = await (await getMindKeepOff(req("admin-tok"), env)).json() as any;
    expect(list.terms.map((t: any) => t.term)).toEqual(["Ava"]);
  });
});
