// M6 (docs/PLAN-memory-map-2026-10-28.md): the orient neighborhood, named and read from each seed.
//   1. traverse fair share: one busy seed cannot spend the whole per-hop cap; leftover budget returns;
//   2. the anchored [Linked] renderer: direction-aware verbs, map-labeler names, hidden rows dropped,
//      two neighbors per seed with "+N more", seed order;
//   3. loadNeighborhoodNodes hides what the map hides (archived journal), against the real schema.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { neighborhood } from "../graph/traverse.js";
import { neighborhoodBlock } from "../librarian/response/orient-blocks.js";
import { isLabeledTable, loadNeighborhoodNodes } from "../graph/labels.js";

function envWith() {
  const { db, DB } = makeSqliteD1();
  return { db, env: { DB } as any };
}
const addEdge = (db: any, src: [string, string], dst: [string, string], type: string, writer: string, at: string) =>
  db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, 'mechanical', ?)")
    .run(src[0], src[1], dst[0], dst[1], type, writer, at);

describe("traverse fair share", () => {
  it("a busy seed no longer starves a quiet one, and unused budget is handed back", async () => {
    const { db, env } = envWith();
    for (let i = 0; i < 10; i++) addEdge(db, ["companion_journal", `j${i}`], ["watch_shelf", "fargo"], "mentions", "drevan", `2026-10-2${i % 9}T00:00:0${i}Z`);
    addEdge(db, ["companion_journal", "quiet"], ["sessions", "s1"], "logged_in", "gaia", "2026-01-01T00:00:00Z");
    const seeds = [{ table: "watch_shelf", id: "fargo" }, { table: "companion_journal", id: "quiet" }];

    const old = await neighborhood(env, seeds, { hops: 1, limit: 6 });
    expect(old.some((e) => e.src_id === "quiet")).toBe(false); // the starvation this fixes

    const fair = await neighborhood(env, seeds, { hops: 1, limit: 6, perNodeLimit: 2 });
    expect(fair).toHaveLength(6); // leftover handed back to Fargo
    expect(fair.some((e) => e.src_id === "quiet")).toBe(true);
  });
});

describe("anchored [Linked] block", () => {
  const e = (src: [string, string], dst: [string, string], edge_type: string, writer: string, created_at: string) =>
    ({ src_table: src[0], src_id: src[1], dst_table: dst[0], dst_id: dst[1], edge_type, writer, created_at, hop: 1 });

  it("reads from the seed outward with the passive verb when the seed is the dst", () => {
    const out = neighborhoodBlock(
      [e(["companion_journal", "j1"], ["watch_shelf", "fargo"], "mentions", "drevan", "2026-09-24T00:00:00Z")],
      {
        seeds: ["watch_shelf/fargo"],
        nodes: new Map([["watch_shelf/fargo", { label: "Fargo" }], ["companion_journal/j1", { label: "Crash reached for a snuggle" }]]),
        isLabeledTable,
      },
    );
    expect(out).toBe('\n[Linked]\n• Fargo -- mentioned in "Crash reached for a snuggle" (drevan 09-24)');
  });

  it("drops a neighbor the labeler hid, shows two, counts the rest, content before thin rows", () => {
    const edges = [
      e(["companion_journal", "seed"], ["sessions", "s1"], "logged_in", "cypher", "2026-10-28T00:00:00Z"),
      e(["companion_soma_events", "m1"], ["companion_journal", "seed"], "alongside", "cypher", "2026-10-27T00:00:00Z"),
      e(["companion_soma_events", "m2"], ["companion_journal", "seed"], "alongside", "cypher", "2026-10-26T00:00:00Z"),
      e(["companion_journal", "hidden"], ["companion_journal", "seed"], "references", "cypher", "2026-10-29T00:00:00Z"),
    ];
    const nodes = new Map([
      ["companion_journal/seed", { label: "the snow scene again" }],
      ["companion_soma_events/m1", { label: "acuity 0.75 -> 0.80 (authored close)" }],
      ["companion_soma_events/m2", { label: "presence 0.94 -> 0.95 (authored close)" }],
      ["sessions/s1", { label: "session 10-28 (work)" }],
    ]);
    const out = neighborhoodBlock(edges, { seeds: ["companion_journal/seed"], nodes, isLabeledTable });
    expect(out).toContain('"the snow scene again" -- alongside acuity 0.75 -> 0.80');
    expect(out).toContain("alongside presence 0.94 -> 0.95");
    expect(out).toContain("+1 more"); // the session, ranked after content
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("journal entry hidden"); // never shown by id either
  });

  it("orders lines by seed order and caps line count", () => {
    const edges = [
      e(["watch_shelf", "a"], ["companion_journal", "x"], "mentions", "d", "2026-10-01T00:00:00Z"),
      e(["companion_conclusions", "c1"], ["companion_conclusions", "c0"], "supersedes", "cypher", "2026-09-01T00:00:00Z"),
    ];
    const out = neighborhoodBlock(edges, { seeds: ["companion_conclusions/c1", "watch_shelf/a"], maxLines: 1 });
    expect(out.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(1);
    expect(out).toContain("supersedes");
  });

  it("without seeds the old grouped renderer still answers (director and older callers)", () => {
    const out = neighborhoodBlock([e(["companion_journal", "j1"], ["watch_shelf", "f"], "mentions", "drevan", "2026-09-24T00:00:00Z")], {
      labels: new Map([["watch_shelf/f", "Fargo"]]),
    });
    expect(out).toContain("mentions: Fargo (show) -- 1 notes from drevan");
  });
});

describe("loadNeighborhoodNodes", () => {
  it("names visible rows and leaves hidden ones absent; knows which tables it labels", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at, archived, review_state) VALUES ('kept1', 'drevan', 'Crash reached for a snuggle', '2026-09-24T00:00:00Z', 0, 'kept')").run();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at, archived, review_state) VALUES ('gone1', 'drevan', 'archived words', '2026-09-24T00:00:00Z', 1, 'kept')").run();
    const nodes = await loadNeighborhoodNodes(env, [
      { src_table: "companion_journal", src_id: "kept1", dst_table: "companion_journal", dst_id: "gone1" },
    ]);
    expect(nodes.get("companion_journal/kept1")?.label).toBe("Crash reached for a snuggle");
    expect(nodes.has("companion_journal/gone1")).toBe(false);
    expect(isLabeledTable("companion_journal")).toBe(true);
    expect(isLabeledTable("not_a_table")).toBe(false);
  });
});
