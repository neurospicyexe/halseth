// The memory map read (graph/map.ts, M1 of docs/PLAN-memory-map-2026-10-28.md). Real schema: the
// guarantees are about which ROWS come back, so they run real SQL.
//   - every node has a name, never a bare id; the writer rides on every edge;
//   - a draft / archived / superseded row is DROPPED with its edges (graph_edges does point at drafts);
//   - the sealed lane never appears; `follows` chains stay out unless a float move is the center;
//   - reading writes nothing.

import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedNote } from "./helpers/sqlite-d1.js";
import { buildMap, loadMapNodes } from "../graph/map.js";

function setup() {
  const { db, DB, prepared } = makeSqliteD1();
  return { db, env: { DB } as any, prepared };
}

function edge(db: any, src: string, dst: string, type: string, writer = "cypher", provenance = "mechanical") {
  const [st, si] = src.split("/");
  const [dt, di] = dst.split("/");
  db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(st, si, dt, di, type, writer, provenance, "2026-10-20T00:00:00Z");
}
function journal(db: any, id: string, text: string, review_state = "kept", agent = "cypher") {
  db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text, review_state, archived) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, "2026-10-20T00:00:00Z", agent, text, review_state);
}
function shelf(db: any, id: string, title: string) {
  db.prepare("INSERT INTO watch_shelf (id, title, kind, status) VALUES (?, ?, 'show', 'watching')").run(id, title);
}

describe("graph map -- names, visibility, bounds", () => {
  it("names every node and carries the writer on every edge", async () => {
    const { db, env } = setup();
    shelf(db, "fargo", "Fargo");
    journal(db, "j1", "Watching Fargo with him tonight, the snow scene.", "kept", "drevan");
    edge(db, "companion_journal/j1", "watch_shelf/fargo", "mentions", "drevan", "mechanical:title");
    const m = await buildMap(env, { reader: "raziel" });
    const fargo = m.nodes.find((n) => n.key === "watch_shelf/fargo")!;
    const j = m.nodes.find((n) => n.key === "companion_journal/j1")!;
    expect(fargo.label).toBe("Fargo");
    expect(j.label).toMatch(/^Watching Fargo/);
    expect(j.owner).toBe("drevan");
    expect(m.edges).toEqual([expect.objectContaining({ src: "companion_journal/j1", dst: "watch_shelf/fargo", type: "mentions", writer: "drevan" })]);
  });

  it("drops a DRAFT journal row and its edge instead of rendering an id", async () => {
    const { db, env } = setup();
    shelf(db, "fargo", "Fargo");
    journal(db, "draft", "an unreviewed clerk line about Fargo", "draft");
    edge(db, "companion_journal/draft", "watch_shelf/fargo", "mentions");
    const m = await buildMap(env, { reader: "raziel" });
    expect(m.nodes.map((n) => n.key)).not.toContain("companion_journal/draft");
    expect(m.edges).toHaveLength(0);
  });

  it("drops archived notes and superseded conclusions", async () => {
    const { db, env } = setup();
    seedNote(db, { note_id: "gone", archived: 1 });
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at) VALUES ('new', 'cypher', 'the newer belief', '2026-10-02')").run();
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, superseded_by) VALUES ('old', 'cypher', 'an old belief', '2026-10-01', 'new')").run();
    const nodes = await loadMapNodes(env, [{ table: "wm_continuity_notes", id: "gone" }, { table: "companion_conclusions", id: "old" }]);
    expect(nodes.size).toBe(0);
  });

  it("never returns the sealed lane, even when an edge points at it", async () => {
    const { db, env } = setup();
    shelf(db, "fargo", "Fargo");
    edge(db, ["sibling", "notes"].join("_") + "/s1", "watch_shelf/fargo", "mentions");
    const m = await buildMap(env, { reader: "raziel" });
    expect(m.nodes.some((n) => n.table.startsWith("sibling"))).toBe(false);
    expect(m.edges).toHaveLength(0);
  });

  it("keeps the float-move chain out unless a float move is the center", async () => {
    const { db, env } = setup();
    const ev = (id: string, at: string) => db.prepare(
      "INSERT INTO companion_soma_events (id, companion_id, float_key, before_value, after_value, delta, kind, writer, created_at) VALUES (?, 'cypher', 'soma_float_3', 0.5, 0.6, 0.1, 'tick', 'system', ?)",
    ).run(id, at);
    ev("e1", "2026-10-20T00:00:00Z"); ev("e2", "2026-10-20T01:00:00Z");
    edge(db, "companion_soma_events/e2", "companion_soma_events/e1", "follows", "system");
    const byCenter = await buildMap(env, { reader: "cypher", center: { table: "companion_soma_events", id: "e2" } });
    expect(byCenter.edges.map((e) => e.type)).toEqual(["follows"]);
    expect(byCenter.nodes.find((n) => n.key === "companion_soma_events/e2")!.label).toBe("warmth 0.50 -> 0.60 (tick)");
    const viaJournal = await buildMap(env, { reader: "cypher", center: { table: "companion_journal", id: "nope" } });
    expect(viaJournal.edges).toHaveLength(0);
  });

  it("reading the map writes nothing (no heat, no receipts)", async () => {
    const { db, env, prepared } = setup();
    shelf(db, "fargo", "Fargo");
    journal(db, "j1", "Fargo again");
    edge(db, "companion_journal/j1", "watch_shelf/fargo", "mentions");
    const before = prepared.length;
    await buildMap(env, { reader: "cypher", hops: 2 });
    expect(prepared.slice(before).every((sql) => /^\s*(select|with)/i.test(sql))).toBe(true);
  });
});
