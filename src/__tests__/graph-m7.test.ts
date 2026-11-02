// M7 (docs/PLAN-memory-map-2026-10-28.md), against the real schema:
//   1. the diff rebuild never empties the graph -- an unchanged night writes nothing, a stale
//      mechanical row is removed, a drifted one is corrected in place, a 'live' row still wins;
//   2. a boot that shows a handover resumes it (Raziel's D3), on both open paths;
//   3. reach records what orient rendered, with a zero streak for the alarm.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { rebuildGraphDetailed } from "../graph/rebuild.js";
import { loadOrientData, loadSessionData } from "../mcp/tools/session_load.js";
import { nextReachRecord, readGraphReach, recordGraphReach, summarizeReach } from "../graph/reach.js";

function envWith() {
  const { db, DB } = makeSqliteD1();
  // mig 0040 seeds stances toward Raziel, which the centre lane (mig 0150) links; these tests count
  // edges from their own rows only.
  db.prepare("DELETE FROM companion_relational_state").run();
  return { db, env: { DB } as any };
}

function seedSupersede(db: any) {
  // Newer row first: superseded_by is a foreign key onto it.
  db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at) VALUES ('new1', 'cypher', 'the newer read', '2026-10-02T00:00:00Z')").run();
  db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, superseded_by) VALUES ('old1', 'cypher', 'the older read', '2026-10-01T00:00:00Z', 'new1')").run();
}

const edgeRows = (db: any) => db.prepare("SELECT id, src_id, dst_id, edge_type, provenance, created_at FROM graph_edges ORDER BY id").all();

describe("diff rebuild", () => {
  it("an unchanged second run writes nothing and keeps the same rows (same ids: nothing was wiped)", async () => {
    const { db, env } = envWith();
    seedSupersede(db);
    const first = await rebuildGraphDetailed(env);
    expect(first.diff).toMatchObject({ added: 1, updated: 0, removed: 0 });
    const before = edgeRows(db);

    const second = await rebuildGraphDetailed(env);
    expect(second.diff).toMatchObject({ derived: 1, added: 0, updated: 0, removed: 0 });
    expect(edgeRows(db)).toEqual(before);
    expect(second.sources.find((s) => s.source === "companion_conclusions.superseded_by")).toMatchObject({ inserted: 1, added: 0 });
  });

  it("removes a mechanical row no source derives, corrects a drifted one in place, never touches live", async () => {
    const { db, env } = envWith();
    seedSupersede(db);
    await rebuildGraphDetailed(env);
    const edgeId = (edgeRows(db)[0] as any).id;
    db.prepare("UPDATE graph_edges SET created_at = '1999-01-01T00:00:00Z' WHERE id = ?").run(edgeId);
    db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES ('companion_conclusions', 'gone', 'companion_conclusions', 'gone2', 'supersedes', 'cypher', 'mechanical', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES ('sessions', 's1', 'handover_packets', 'h1', 'resumed_from', 'cypher', 'live', '2026-01-01T00:00:00Z')").run();

    const r = await rebuildGraphDetailed(env);
    expect(r.diff).toMatchObject({ added: 0, updated: 1, removed: 1 });
    const rows = edgeRows(db) as any[];
    expect(rows.find((e) => e.id === edgeId)?.created_at).toBe("2026-10-02T00:00:00Z");
    expect(rows.some((e) => e.src_id === "gone")).toBe(false);
    expect(rows.some((e) => e.provenance === "live")).toBe(true);
  });

  it("a live row holding a derived key keeps it, exactly as INSERT OR IGNORE let it", async () => {
    const { db, env } = envWith();
    seedSupersede(db);
    db.prepare("INSERT INTO graph_edges (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at) VALUES ('companion_conclusions', 'new1', 'companion_conclusions', 'old1', 'supersedes', 'cypher', 'live', '2026-10-02T00:00:00Z')").run();
    const r = await rebuildGraphDetailed(env);
    expect(r.diff.added).toBe(0);
    expect((edgeRows(db) as any[]).map((e) => e.provenance)).toEqual(["live"]);
    expect(r.sources.find((s) => s.source === "companion_conclusions.superseded_by")?.inserted).toBe(0);
  });
});

describe("a boot that shows a handover resumes it (D3)", () => {
  function seedPacket(db: any, id: string, sessionId: string, at: string, closeKind: string | null, companion = "cypher") {
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, session_type, companion_id, front_state, handover_id) VALUES (?, ?, ?, 'work', ?, 'raziel', ?)").run(sessionId, at, at, companion, id);
    db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, motion_state, close_kind) VALUES (?, ?, ?, 'a spine', 'at_rest', ?)").run(id, sessionId, at, closeKind);
  }
  const resumed = (db: any) => db.prepare("SELECT src_id, dst_id, provenance FROM graph_edges WHERE edge_type = 'resumed_from'").all();

  it("session_open (the Claude Code boot hook's path) links the new session to the packet it returned", async () => {
    const { db, env } = envWith();
    seedPacket(db, "hp-human", "s-old", "2026-10-28T10:00:00Z", null);
    seedPacket(db, "hp-machine", "s-old2", "2026-10-28T11:00:00Z", "consolidation");
    const out: any = await loadSessionData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-code:test" });
    expect(out.handover.id).toBe("hp-human");
    expect(resumed(db)).toEqual([{ src_id: out.session_id, dst_id: "hp-human", provenance: "live" }]);
    expect(db.prepare("SELECT returned FROM handover_packets WHERE id = 'hp-human'").get()).toEqual({ returned: 1 });
  });

  it("orient links the same way, and a reused session does not link again", async () => {
    const { db, env } = envWith();
    seedPacket(db, "hp-1", "s-old", "2026-10-28T10:00:00Z", null);
    const a: any = await loadOrientData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-ai:t" });
    seedPacket(db, "hp-2", "s-other", "2026-10-28T12:00:00Z", null);
    const b: any = await loadOrientData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-ai:t" });
    expect(b.session_id).toBe(a.session_id);
    expect(resumed(db)).toEqual([{ src_id: a.session_id, dst_id: "hp-1", provenance: "live" }]);
  });

  it("an explicit prior_handover_id wins over the shown packet", async () => {
    const { db, env } = envWith();
    seedPacket(db, "hp-named", "s-a", "2026-10-27T10:00:00Z", null);
    seedPacket(db, "hp-shown", "s-b", "2026-10-28T10:00:00Z", null);
    const out: any = await loadOrientData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-ai:t", prior_handover_id: "hp-named" });
    expect(resumed(db)).toEqual([{ src_id: out.session_id, dst_id: "hp-named", provenance: "live" }]);
  });

  it("a boot shown ANOTHER companion's close orients from it but does not resume it", async () => {
    const { db, env } = envWith();
    seedPacket(db, "hp-cypher", "s-c", "2026-10-28T10:00:00Z", null);
    seedPacket(db, "hp-gaia", "s-g", "2026-10-29T00:55:00Z", null, "gaia");
    const out: any = await loadSessionData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-code:test" });
    expect(out.handover.id).toBe("hp-gaia");
    expect(resumed(db)).toEqual([]);
    expect(db.prepare("SELECT returned FROM handover_packets WHERE id = 'hp-gaia'").get()).toEqual({ returned: null });
  });

  it("no packet shown, nothing linked", async () => {
    const { db, env } = envWith();
    await loadOrientData(env, { companion_id: "cypher", front_state: "raziel", surface: "claude-ai:t" });
    expect(resumed(db)).toEqual([]);
  });
});

describe("graph reach", () => {
  const edge = (s: string, d: string) => ({ src_table: "companion_journal", src_id: s, dst_table: "watch_shelf", dst_id: d });

  it("counts edges and distinct nodes, and whether anything rendered", () => {
    expect(summarizeReach([edge("j1", "w1"), edge("j2", "w1")], "[Neighborhood] ...")).toEqual({ edges: 2, nodes: 3, rendered: true });
    expect(summarizeReach([], "")).toEqual({ edges: 0, nodes: 0, rendered: false });
  });

  it("zero streak climbs on empty boots and resets on one that reached", () => {
    const one = nextReachRecord(null, { edges: 0, nodes: 0, rendered: false }, "t1");
    const two = nextReachRecord(one, { edges: 0, nodes: 0, rendered: false }, "t2");
    expect(two).toMatchObject({ zero_streak: 2, last_nonzero_at: null });
    const three = nextReachRecord(two, { edges: 4, nodes: 5, rendered: true }, "t3");
    expect(three).toMatchObject({ zero_streak: 0, last_nonzero_at: "t3" });
    expect(nextReachRecord(three, { edges: 0, nodes: 0, rendered: false }, "t4")).toMatchObject({ zero_streak: 1, last_nonzero_at: "t3" });
  });

  it("records per companion and surface, and reads every record back", async () => {
    const { env } = envWith();
    await recordGraphReach(env, "cypher", [edge("j1", "w1")], "[Neighborhood] Fargo");
    await recordGraphReach(env, "gaia", [], "");
    await recordGraphReach(env, "gaia", [], "", "discord");
    const all = await readGraphReach(env);
    expect(all.cypher).toMatchObject({ edges: 1, nodes: 2, rendered: true, zero_streak: 0 });
    expect(all.gaia).toMatchObject({ edges: 0, zero_streak: 1, last_nonzero_at: null });
    expect(all["gaia@discord"]).toMatchObject({ edges: 0, zero_streak: 1 });
  });

  it("an unchanged reading inside the hour is not re-recorded; a changed one always is", async () => {
    const { db, env } = envWith();
    await recordGraphReach(env, "gaia", [], "", "discord");
    await recordGraphReach(env, "gaia", [], "", "discord"); // a 5-minute bot refresh, same reading
    expect((await readGraphReach(env))["gaia@discord"]?.zero_streak).toBe(1);
    await recordGraphReach(env, "gaia", [edge("j1", "w1")], "[Linked] x", "discord");
    expect((await readGraphReach(env))["gaia@discord"]).toMatchObject({ zero_streak: 0, edges: 1 });
    // An hour later the same empty reading counts again.
    const old = JSON.stringify({ at: new Date(Date.now() - 2 * 3600e3).toISOString(), edges: 0, nodes: 0, rendered: false, zero_streak: 1, last_nonzero_at: null });
    db.prepare("UPDATE companion_settings SET value = ? WHERE companion_id = '_system' AND key = 'graph_reach:gaia@discord'").run(old);
    await recordGraphReach(env, "gaia", [], "", "discord");
    expect((await readGraphReach(env))["gaia@discord"]?.zero_streak).toBe(2);
  });

  it("a failing store never throws into the boot", async () => {
    const env: any = { DB: { prepare: () => { throw new Error("D1 down"); } } };
    await expect(recordGraphReach(env, "cypher", [], "")).resolves.toBeUndefined();
  });
});
