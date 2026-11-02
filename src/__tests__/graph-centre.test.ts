// One centre (mig 0150, Raziel 2026-10-29): Raziel (also Crash) is a single node; system names are
// Raziel fronting, never separate people; the centre links from rows ABOUT Raziel, not every mention.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { rebuildGraphDetailed } from "../graph/rebuild.js";
import { addPerson, archivePerson, CENTRE_ID, listPeople } from "../graph/people.js";
import { neighborhoodBlock } from "../librarian/response/orient-blocks.js";
import { isLabeledTable } from "../graph/labels.js";
import { getMindPeople } from "../handlers/people.js";

const at = "2026-10-20T00:00:00Z";
function envWith() {
  const { db, DB } = makeSqliteD1();
  // mig 0040 seeds boot-continuity stances toward Raziel; each test states its own rows.
  db.prepare("DELETE FROM companion_relational_state").run();
  return { db, env: { DB, ADMIN_SECRET: "s" } as any };
}
const peopleEdges = (db: any) =>
  db.prepare("SELECT src_table, src_id, dst_id, edge_type, provenance FROM graph_edges WHERE dst_table = 'graph_people' ORDER BY src_table, src_id").all();

describe("the centre", () => {
  it("exists once, first on the list, and cannot be archived", async () => {
    const { env } = envWith();
    const people = await listPeople(env);
    expect(people[0]).toMatchObject({ id: CENTRE_ID, label: "Raziel", kind: "centre", match_names: ["Crash"] });
    expect(await archivePerson(env, CENTRE_ID)).toBe(false);
    expect((await addPerson(env, { label: "Crash", added_by: "raziel" })).ok).toBe(false);
  });

  it("is never linked by Raziel's own names", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Raziel and Crash both laughed', ?)").run(at);
    await rebuildGraphDetailed(env);
    expect(peopleEdges(db)).toEqual([]);
  });

  it("links from active facts and from stances toward Raziel or Crash, by whoever holds them", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO architect_facts (id, fact, category, status, companion_id, created_at, updated_at) VALUES ('f1', 'PDA: show the board', 'how', 'active', 'drevan', ?, ?), ('f2', 'old fact', 'how', 'retired', 'cypher', ?, ?)").run(at, at, at, at);
    db.prepare("INSERT INTO companion_relational_state (id, companion_id, toward, state_text, noted_at) VALUES ('r1', 'gaia', 'Crash', 'steady', ?), ('r2', 'gaia', 'sol', 'fond', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    expect(peopleEdges(db)).toEqual([
      { src_table: "architect_facts", src_id: "f1", dst_id: CENTRE_ID, edge_type: "about", provenance: "mechanical" },
      { src_table: "companion_relational_state", src_id: "r1", dst_id: CENTRE_ID, edge_type: "toward", provenance: "mechanical" },
    ]);
  });
});

describe("system names are Raziel", () => {
  it("a self name links to the centre with the front kept, never to a node of its own", async () => {
    const { db, env } = envWith();
    await addPerson(env, { label: "Magpie", match_names: ["Magpie M."], kind: "self", added_by: "raziel" });
    await addPerson(env, { label: "Jude", kind: "headmate", added_by: "raziel" }); // 0149's word, read as self
    await addPerson(env, { label: "Blue", kind: "person", added_by: "raziel" });
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Magpie and Jude on the couch with Blue', ?), ('j2', 'gaia', 'Magpie M. fronted', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    const blue = (await listPeople(env)).find((p) => p.label === "Blue")!;
    expect(peopleEdges(db)).toEqual([
      { src_table: "companion_journal", src_id: "j1", dst_id: blue.id, edge_type: "mentions", provenance: "mechanical:person" },
      { src_table: "companion_journal", src_id: "j1", dst_id: CENTRE_ID, edge_type: "mentions", provenance: "mechanical:front:Jude,Magpie" },
      { src_table: "companion_journal", src_id: "j2", dst_id: CENTRE_ID, edge_type: "mentions", provenance: "mechanical:front:Magpie" },
    ]);

    const list: any = await (await getMindPeople(new Request("https://x/mind/people", { headers: { Authorization: "Bearer s" } }), env)).json();
    const by = Object.fromEntries(list.people.map((p: any) => [p.label, p.mentions]));
    expect(by).toEqual({ Raziel: 2, Blue: 1, Jude: 1, Magpie: 2 });
  });

  it("the boot says it in words a literal model cannot misread", () => {
    const out = neighborhoodBlock([{
      src_table: "companion_journal", src_id: "j1", dst_table: "graph_people", dst_id: CENTRE_ID,
      edge_type: "mentions", writer: "drevan", provenance: "mechanical:front:Magpie", created_at: "2026-09-24T00:00:00Z", hop: 1,
    }], {
      seeds: ["companion_journal/j1"],
      nodes: new Map([["companion_journal/j1", { label: "couch night" }], [`graph_people/${CENTRE_ID}`, { label: "Raziel" }]]),
      isLabeledTable,
    });
    expect(out).toBe('\n[Linked]\n• "couch night" -- with Raziel, fronting as Magpie (drevan 09-24)');
    expect(out).not.toMatch(/mentions:? Magpie/);
  });
});
