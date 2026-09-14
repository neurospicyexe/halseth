// Graph memory Phase 2, tranche 1 -- rebuild source (i), companion_soma_events.
// (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md)
//
// Same style as graph-rebuild.test.ts: the pure builder gets unit coverage (every edge family,
// the dangling stamp, both window boundaries, the merged cap, determinism) and rebuildGraph gets
// one end-to-end pass through the same hand-shaped D1 fake, seeded with the new tables.

import { describe, it, expect } from "vitest";
import {
  buildSomaEventEdges,
  rebuildGraph,
  ALONGSIDE_LANES,
  type SomaEventGraphRow,
  type CommonsPostGraphRow,
  type AutonomyReflectionGraphRow,
  type ForageFindGraphRow,
  type AutonomyRunGraphRow,
  type RelationalDeltaGraphRow,
} from "../graph/rebuild.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

// ── the same fake D1 graph-rebuild.test.ts uses ────────────────────────────────────────────────
const GRAPH_EDGE_COLUMNS = ["src_table", "src_id", "dst_table", "dst_id", "edge_type", "writer", "provenance", "created_at"];
const uniqueKey = (r: Row) => [r.src_table, r.src_id, r.dst_table, r.dst_id, r.edge_type].join(" ");

class FakeStatement {
  constructor(private sql: string, private tables: Record<string, Row[]>, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.tables, args); }
  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql.trim();
    if (sql.startsWith("DELETE FROM graph_edges")) {
      const pattern = String(this.bound[0] ?? "").replace("%", "");
      const before = (this.tables.graph_edges ?? []).length;
      this.tables.graph_edges = (this.tables.graph_edges ?? []).filter((r) => !String(r.provenance ?? "").startsWith(pattern));
      return { meta: { changes: before - this.tables.graph_edges.length } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO graph_edges")) {
      const row: Row = {};
      GRAPH_EDGE_COLUMNS.forEach((col, i) => (row[col] = this.bound[i]));
      this.tables.graph_edges = this.tables.graph_edges ?? [];
      if (this.tables.graph_edges.some((r) => uniqueKey(r) === uniqueKey(row))) return { meta: { changes: 0 } };
      this.tables.graph_edges.push(row);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async all<T = Row>(): Promise<{ results: T[] }> {
    const name = /FROM (\w+)/.exec(this.sql)?.[1] ?? "misc";
    // Tables the fixture never seeds resolve to [] -- the same way a missing table would be an
    // empty source here, so a rebuild is exercisable without stubbing all fourteen.
    return { results: ((this.tables[name] ?? []) as unknown) as T[] };
  }
  async first<T = Row>(): Promise<T | null> { return null; }
}

function makeEnv(seed: Record<string, Row[]> = {}): { env: Env; tables: Record<string, Row[]> } {
  const tables = { graph_edges: [], ...seed } as Record<string, Row[]>;
  const env = {
    DB: {
      prepare: (sql: string) => new FakeStatement(sql, tables),
      batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run())),
    },
  } as unknown as Env;
  return { env, tables };
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const AT = "2026-09-12T12:00:00.000Z";
const atMinus = (min: number) => new Date(Date.parse(AT) - min * 60_000).toISOString();

function ev(over: Partial<SomaEventGraphRow> = {}): SomaEventGraphRow {
  return {
    id: "e1", companion_id: "cypher", float_key: "soma_float_1",
    kind: "authored_close", writer: "cypher",
    cause_table: "handover_packets", cause_id: "h1",
    session_id: "s1", created_at: AT, ...over,
  };
}
const journal = (id: string, over: Partial<Record<string, unknown>> = {}) =>
  ({ id, agent: "cypher", session_id: "s1", note_text: "x", created_at: atMinus(5), ...over }) as any;
const commons = (id: string, over: Partial<CommonsPostGraphRow> = {}): CommonsPostGraphRow =>
  ({ id, author: "raziel", created_at: atMinus(5), ...over });

// Tranche 2 lane fixtures. Each defaults to "this companion, 5 minutes before the event" so a test
// only spells the ONE field it is about.
const reflection = (id: string, over: Partial<AutonomyReflectionGraphRow> = {}): AutonomyReflectionGraphRow =>
  ({ id, companion_id: "cypher", created_at: atMinus(5), ...over });
const forage = (id: string, over: Partial<ForageFindGraphRow> = {}): ForageFindGraphRow =>
  ({ id, companion_id: "cypher", consumed_at: atMinus(5), consumed_by: "cypher", ...over });
const run = (id: string, over: Partial<AutonomyRunGraphRow> = {}): AutonomyRunGraphRow =>
  ({ id, companion_id: "cypher", started_at: atMinus(20), completed_at: atMinus(5), created_at: atMinus(20), ...over });
const delta = (id: string, over: Partial<RelationalDeltaGraphRow> = {}): RelationalDeltaGraphRow =>
  ({ id, companion_id: "cypher", agent: null, session_id: null, created_at: atMinus(5), ...over });

/** Positional wrapper so lane tests name only the lane they exercise. */
type Lanes = {
  journal?: any[]; commons?: CommonsPostGraphRow[]; reflections?: AutonomyReflectionGraphRow[];
  forage?: ForageFindGraphRow[]; runs?: AutonomyRunGraphRow[]; deltas?: RelationalDeltaGraphRow[];
};
const alongsideOf = (events: SomaEventGraphRow[], lanes: Lanes) =>
  typesOf(
    buildSomaEventEdges(events, new Set(["s1"]), lanes.journal ?? [], lanes.commons ?? [], lanes.reflections ?? [], lanes.forage ?? [], lanes.runs ?? [], lanes.deltas ?? []),
    "alongside",
  );

const typesOf = (edges: ReturnType<typeof buildSomaEventEdges>, t: string) => edges.filter((e) => e.edge_type === t);

describe("buildSomaEventEdges -- edge families", () => {
  it("moved_by points at the cause row and carries the event's writer", () => {
    const [e] = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), [], []), "moved_by");
    expect(e).toMatchObject({
      src_table: "companion_soma_events", src_id: "e1",
      dst_table: "handover_packets", dst_id: "h1",
      writer: "cypher", provenance: "mechanical", created_at: AT,
    });
  });

  it("emits NO moved_by when the event has no cause (a bare authored_update)", () => {
    const edges = buildSomaEventEdges([ev({ kind: "authored_update", cause_table: null, cause_id: null })], new Set(["s1"]), [], []);
    expect(typesOf(edges, "moved_by")).toHaveLength(0);
  });

  it("follows chains the previous event for the SAME companion+float, writer 'system'", () => {
    const a = ev({ id: "a", created_at: atMinus(30) });
    const b = ev({ id: "b", created_at: AT });
    const [f] = typesOf(buildSomaEventEdges([b, a], new Set(["s1"]), [], []), "follows");
    expect(f).toMatchObject({ src_id: "b", dst_table: "companion_soma_events", dst_id: "a", writer: "system", provenance: "mechanical" });
  });

  it("follows never crosses floats or companions", () => {
    const rows = [
      ev({ id: "a", created_at: atMinus(30), float_key: "soma_float_1" }),
      ev({ id: "b", created_at: atMinus(20), float_key: "soma_float_2" }),
      ev({ id: "c", created_at: atMinus(10), companion_id: "gaia", writer: "gaia", float_key: "soma_float_1" }),
    ];
    expect(typesOf(buildSomaEventEdges(rows, new Set(["s1"]), [], []), "follows")).toHaveLength(0);
  });

  it("logged_in stamps mechanical for a live session and mechanical:dangling for a missing one", () => {
    const edges = buildSomaEventEdges(
      [ev({ id: "live", session_id: "s1" }), ev({ id: "gone", session_id: "nope", float_key: "soma_float_2" })],
      new Set(["s1"]), [], [],
    );
    const byId = Object.fromEntries(typesOf(edges, "logged_in").map((e) => [e.src_id, e]));
    expect(byId.live!.provenance).toBe("mechanical");
    expect(byId.gone!.provenance).toBe("mechanical:dangling");
    // Mark, don't drop -- the dangling edge is still emitted.
    expect(byId.gone!.dst_id).toBe("nope");
  });

  it("skips logged_in (and session-alongside) entirely when session_id is null", () => {
    const edges = buildSomaEventEdges([ev({ session_id: null })], new Set(["s1"]), [journal("j1")], []);
    expect(typesOf(edges, "logged_in")).toHaveLength(0);
    expect(typesOf(edges, "alongside")).toHaveLength(0);
  });
});

describe("buildSomaEventEdges -- alongside", () => {
  it("journal rows in the same session, same agent, at or before the event -> mechanical:session", () => {
    const rows = [
      journal("same"),
      journal("other-session", { session_id: "s2" }),
      journal("other-agent", { agent: "gaia" }),
      journal("after", { created_at: atMinus(-5) }),
    ];
    const edges = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), rows, []), "alongside");
    expect(edges.map((e) => e.dst_id)).toEqual(["same"]);
    expect(edges[0]!.provenance).toBe("mechanical:session");
    expect(edges[0]!.dst_table).toBe("companion_journal");
  });

  it("commons posts by the companion or raziel inside the window -> mechanical:window", () => {
    const rows = [commons("raz"), commons("mine", { author: "cypher" }), commons("sibling", { author: "gaia" })];
    const edges = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), [], rows), "alongside");
    expect(edges.map((e) => e.dst_id).sort()).toEqual(["mine", "raz"]);
    expect(edges.every((e) => e.provenance === "mechanical:window")).toBe(true);
  });

  it("the 60-minute window is inclusive at BOTH ends; 60:01 before and any time after are out", () => {
    const rows = [
      commons("exactly-60", { created_at: atMinus(60) }),
      commons("just-past", { created_at: new Date(Date.parse(AT) - 60 * 60_000 - 1000).toISOString() }),
      commons("same-instant", { created_at: AT }),
      commons("after", { created_at: atMinus(-1) }),
    ];
    const ids = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), [], rows), "alongside").map((e) => e.dst_id);
    expect(ids).toContain("exactly-60");
    expect(ids).toContain("same-instant");
    expect(ids).not.toContain("just-past");
    expect(ids).not.toContain("after");
  });

  it("compares by parsed instant, not raw string -- a datetime('now') commons row still lands", () => {
    // "2026-09-12 11:30:00" sorts BEFORE any ISO string lexically ('T' > ' '), so a raw string
    // window check would silently drop every SQLite-formatted row. This is that regression.
    const edges = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), [], [commons("sqlite", { created_at: "2026-09-12 11:30:00" })]), "alongside");
    expect(edges.map((e) => e.dst_id)).toEqual(["sqlite"]);
  });

  it("caps alongside at 6 per event across BOTH lanes merged, newest first", () => {
    const journalRows = Array.from({ length: 5 }, (_, i) => journal(`j${i}`, { created_at: atMinus(50 - i) }));
    const commonsRows = Array.from({ length: 5 }, (_, i) => commons(`c${i}`, { created_at: atMinus(20 - i * 2) }));
    const edges = typesOf(buildSomaEventEdges([ev()], new Set(["s1"]), journalRows, commonsRows), "alongside");
    // Not 12 (6 per lane), not 10 (all candidates): six total, and they are the six NEWEST.
    expect(edges).toHaveLength(6);
    expect(edges.map((e) => e.dst_id)).toEqual(["c4", "c3", "c2", "c1", "c0", "j4"]);
  });
});

describe("buildSomaEventEdges -- alongside, tranche 2 lanes", () => {
  it("the four tranche 2 arrays default to empty, so the tranche 1 call shape is unchanged", () => {
    const four = buildSomaEventEdges([ev()], new Set(["s1"]), [journal("j1")], [commons("c1")]);
    const eight = buildSomaEventEdges([ev()], new Set(["s1"]), [journal("j1")], [commons("c1")], [], [], [], []);
    expect(JSON.stringify(four)).toBe(JSON.stringify(eight));
  });

  describe("autonomy_reflections", () => {
    it("window hit -> mechanical:window", () => {
      const edges = alongsideOf([ev()], { reflections: [reflection("r1")] });
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ dst_table: "autonomy_reflections", dst_id: "r1", provenance: "mechanical:window", writer: "cypher" });
    });
    it("window miss at 61 minutes and wrong companion are both out", () => {
      const edges = alongsideOf([ev()], {
        reflections: [reflection("late", { created_at: atMinus(61) }), reflection("gaia", { companion_id: "gaia" }), reflection("in")],
      });
      expect(edges.map((e) => e.dst_id)).toEqual(["in"]);
    });
    it("a reflection AFTER the event is not alongside it", () => {
      expect(alongsideOf([ev()], { reflections: [reflection("future", { created_at: atMinus(-1) })] })).toHaveLength(0);
    });
  });

  describe("forage_finds", () => {
    it("a find owned by this companion and consumed in the window -> mechanical:window", () => {
      const edges = alongsideOf([ev()], { forage: [forage("f1")] });
      expect(edges[0]).toMatchObject({ dst_table: "forage_finds", dst_id: "f1", provenance: "mechanical:window" });
    });
    it("a shared-pool find (companion_id NULL) counts when consumed_by names this companion", () => {
      const edges = alongsideOf([ev()], {
        forage: [
          forage("shared-mine", { companion_id: null, consumed_by: "discord:cypher-bot" }),
          forage("shared-theirs", { companion_id: null, consumed_by: "gaia" }),
          forage("shared-unknown", { companion_id: null, consumed_by: null }),
        ],
      });
      expect(edges.map((e) => e.dst_id)).toEqual(["shared-mine"]);
    });
    it("consumption is the act, not gathering: an unconsumed find is out even if gathered in the window", () => {
      expect(alongsideOf([ev()], { forage: [forage("gathered-only", { consumed_at: null })] })).toHaveLength(0);
    });
    it("window is measured on consumed_at: 61 minutes before is out, wrong companion is out", () => {
      const edges = alongsideOf([ev()], {
        forage: [forage("late", { consumed_at: atMinus(61) }), forage("gaia", { companion_id: "gaia", consumed_by: "gaia" }), forage("in")],
      });
      expect(edges.map((e) => e.dst_id)).toEqual(["in"]);
    });
  });

  describe("autonomy_runs", () => {
    it("a run whose interval overlaps the window -> mechanical:window", () => {
      const edges = alongsideOf([ev()], { runs: [run("a1")] });
      expect(edges[0]).toMatchObject({ dst_table: "autonomy_runs", dst_id: "a1", provenance: "mechanical:window" });
    });
    it("overlap is interval-based: a run that STARTED before the window but ended inside it counts", () => {
      const edges = alongsideOf([ev()], { runs: [run("long", { started_at: atMinus(180), completed_at: atMinus(30) })] });
      expect(edges.map((e) => e.dst_id)).toEqual(["long"]);
    });
    it("a run still going at the event (no completed_at) counts if it started at or before the event", () => {
      const edges = alongsideOf([ev()], { runs: [run("live", { started_at: atMinus(10), completed_at: null })] });
      expect(edges.map((e) => e.dst_id)).toEqual(["live"]);
    });
    it("a run that finished 61 minutes before, one that starts after the event, one that never started, one by another companion: all out", () => {
      const edges = alongsideOf([ev()], {
        runs: [
          run("stale", { started_at: atMinus(120), completed_at: atMinus(61) }),
          run("future", { started_at: atMinus(-1), completed_at: atMinus(-10) }),
          run("pending", { started_at: null, completed_at: null }),
          run("gaia", { companion_id: "gaia" }),
        ],
      });
      expect(edges).toHaveLength(0);
    });
    it("run_type never reaches provenance -- the lane set stays stable", () => {
      const edges = alongsideOf([ev()], { runs: [run("a1", { ...( { run_type: "synthesis" } as object) })] });
      expect(edges[0]!.provenance).toBe("mechanical:window");
    });
  });

  describe("relational_deltas", () => {
    it("same session -> mechanical:session, even when the row is outside the 60-minute window", () => {
      const edges = alongsideOf([ev()], { deltas: [delta("d1", { session_id: "s1", created_at: atMinus(200) })] });
      expect(edges[0]).toMatchObject({ dst_table: "relational_deltas", dst_id: "d1", provenance: "mechanical:session" });
    });
    it("no session match but inside the window -> mechanical:window", () => {
      const edges = alongsideOf([ev()], { deltas: [delta("d1", { session_id: "s-other" }), delta("d2")] });
      expect(edges.map((e) => e.dst_id).sort()).toEqual(["d1", "d2"]);
      expect(edges.every((e) => e.provenance === "mechanical:window")).toBe(true);
    });
    it("window miss at 61 minutes and wrong companion are out", () => {
      const edges = alongsideOf([ev()], { deltas: [delta("late", { created_at: atMinus(61) }), delta("gaia", { companion_id: "gaia" })] });
      expect(edges).toHaveLength(0);
    });
    it("matches the MCP-logged row shape (companion_id '' + agent) as well as the legacy one", () => {
      const edges = alongsideOf([ev()], { deltas: [delta("mcp", { companion_id: "", agent: "cypher" }), delta("mcp-other", { companion_id: "", agent: "drevan" })] });
      expect(edges.map((e) => e.dst_id)).toEqual(["mcp"]);
    });
    it("a same-session delta written AFTER the event falls back to the window rule (and is out)", () => {
      expect(alongsideOf([ev()], { deltas: [delta("after", { session_id: "s1", created_at: atMinus(-2) })] })).toHaveLength(0);
    });
  });

  it("the merged cap holds across all six lanes: 8 candidates -> exactly 6, newest first, stable on re-run", () => {
    const lanes: Lanes = {
      journal: [journal("j1", { created_at: atMinus(50) })],
      commons: [commons("c1", { created_at: atMinus(40) })],
      reflections: [reflection("r1", { created_at: atMinus(30) }), reflection("r2", { created_at: atMinus(1) })],
      forage: [forage("f1", { consumed_at: atMinus(20) })],
      runs: [run("a1", { started_at: atMinus(25), completed_at: atMinus(10) })],
      deltas: [delta("d1", { created_at: atMinus(3) }), delta("d2", { session_id: "s1", created_at: atMinus(45) })],
    };
    const first = alongsideOf([ev()], lanes);
    expect(first).toHaveLength(6);
    // Newest first by the lane's own stamp (run = completed_at, find = consumed_at). j1 (50) and d2
    // (45) are the two that fall off; d2 is a session-lane row and STILL loses -- the cap is on the
    // merged list, no lane is exempt.
    expect(first.map((e) => e.dst_id)).toEqual(["r2", "d1", "a1", "f1", "r1", "c1"]);
    const reversed: Lanes = Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, [...v].reverse()]));
    expect(JSON.stringify(alongsideOf([ev()], reversed))).toBe(JSON.stringify(first));
  });
});

describe("buildSomaEventEdges -- determinism", () => {
  it("is byte-identical regardless of input row order (SQLite guarantees none)", () => {
    const events = [ev({ id: "b", created_at: atMinus(10) }), ev({ id: "a", created_at: atMinus(40) }), ev({ id: "c", created_at: AT })];
    const journalRows = [journal("j2", { created_at: atMinus(2) }), journal("j1", { created_at: atMinus(35) })];
    const commonsRows = [commons("c2", { created_at: atMinus(3) }), commons("c1", { created_at: atMinus(45) })];
    const a = buildSomaEventEdges(events, new Set(["s1"]), journalRows, commonsRows);
    const b = buildSomaEventEdges([...events].reverse(), new Set(["s1"]), [...journalRows].reverse(), [...commonsRows].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.length).toBeGreaterThan(0);
  });

  it("pre-parsed index changes cost only: a deterministic shuffle of every lane and the events is byte-identical across all six lanes", () => {
    // Enough rows per lane that the binary-search entry point, the forward-walk cutoff and the
    // session buckets are all exercised: rows well before the window, at both inclusive edges,
    // inside it, after the event, other-companion rows, other-session rows, and an interval run
    // that ENDS after the event but started inside the window.
    const events = [
      ev({ id: "e-mid", created_at: atMinus(30) }),
      ev({ id: "e-late", created_at: AT }),
      ev({ id: "e-early", created_at: atMinus(200), session_id: "s2" }),
      ev({ id: "e-nosess", created_at: atMinus(10), session_id: null, float_key: "soma_float_2" }),
    ];
    const lanes: Lanes = {
      journal: [
        journal("j-in", { created_at: atMinus(15) }), journal("j-after", { created_at: atMinus(-5) }),
        journal("j-s2", { created_at: atMinus(210), session_id: "s2" }), journal("j-other", { created_at: atMinus(5), agent: "drevan" }),
        journal("j-old", { created_at: atMinus(400) }), journal("j-sqlite", { created_at: "2026-09-12 11:50:00" }),
      ],
      commons: [
        commons("c-edge-lo", { created_at: atMinus(60) }), commons("c-out", { created_at: atMinus(61) }),
        commons("c-at", { created_at: AT }), commons("c-after", { created_at: atMinus(-1) }),
        commons("c-cy", { created_at: atMinus(25), author: "cypher" }), commons("c-gaia", { created_at: atMinus(20), author: "gaia" }),
        commons("c-ancient", { created_at: atMinus(5000) }),
      ],
      reflections: [
        reflection("r-in", { created_at: atMinus(45) }), reflection("r-out", { created_at: atMinus(90) }),
        reflection("r-other", { created_at: atMinus(2), companion_id: "drevan" }), reflection("r-edge", { created_at: atMinus(60) }),
      ],
      forage: [
        forage("f-in"), forage("f-pool", { companion_id: null, consumed_by: "cypher/abc" }),
        forage("f-unconsumed", { consumed_at: null }), forage("f-out", { consumed_at: atMinus(120) }),
        forage("f-notmine", { companion_id: null, consumed_by: "gaia" }),
      ],
      runs: [
        run("run-in"), run("run-straddle", { started_at: atMinus(35), completed_at: atMinus(-20) }),
        run("run-open", { completed_at: null }), run("run-old", { started_at: atMinus(300), completed_at: atMinus(200) }),
        run("run-pending", { started_at: null, completed_at: null }), run("run-other", { companion_id: "gaia" }),
      ],
      deltas: [
        delta("d-win"), delta("d-sess", { session_id: "s1", created_at: atMinus(150) }),
        delta("d-sess-after", { session_id: "s1", created_at: atMinus(-30) }), delta("d-legacy", { companion_id: "", agent: "cypher", created_at: atMinus(50) }),
        delta("d-other", { companion_id: "drevan" }), delta("d-s2", { session_id: "s2", created_at: atMinus(250) }),
        delta("d-out", { created_at: atMinus(61) }), delta("d-edge", { created_at: atMinus(60) }),
      ],
    };
    const baseline = buildSomaEventEdges(
      events, new Set(["s1"]), lanes.journal!, lanes.commons!, lanes.reflections!, lanes.forage!, lanes.runs!, lanes.deltas!,
    );
    expect(typesOf(baseline, "alongside").length).toBeGreaterThan(6); // more than one event's cap, so the merge is real

    // Reference: the pre-index alongside scan (O(events x rows), Date.parse per row per event), kept
    // here verbatim so the indexed implementation is pinned to the OLD output, not only to itself.
    const tsMs = (s: string | null | undefined) => {
      if (!s) return 0;
      const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
      return Number.isNaN(ms) ? 0 : ms;
    };
    const byTimeThenId = <T extends { id: string; created_at: string }>(a: T, b: T) => {
      const d = tsMs(a.created_at) - tsMs(b.created_at);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    };
    const deltaOwner = (r: RelationalDeltaGraphRow) => (r.companion_id && r.companion_id !== "" ? r.companion_id : (r.agent || null));
    const referenceAlongside = (e: SomaEventGraphRow) => {
      const at = tsMs(e.created_at);
      const windowLo = at - 60 * 60 * 1000;
      const inWindow = (ms: number) => ms <= at && ms >= windowLo;
      const out: Array<{ table: string; id: string; created_at: string; provenance: string }> = [];
      if (e.session_id) {
        for (const j of [...lanes.journal!].sort(byTimeThenId)) {
          if (j.session_id !== e.session_id || j.agent !== e.companion_id || tsMs(j.created_at) > at) continue;
          out.push({ table: "companion_journal", id: j.id, created_at: j.created_at, provenance: "mechanical:session" });
        }
      }
      for (const c of [...lanes.commons!].sort(byTimeThenId)) {
        if ((c.author !== e.companion_id && c.author !== "raziel") || !inWindow(tsMs(c.created_at))) continue;
        out.push({ table: "commons_posts", id: c.id, created_at: c.created_at, provenance: "mechanical:window" });
      }
      for (const r of [...lanes.reflections!].sort(byTimeThenId)) {
        if (r.companion_id !== e.companion_id || !inWindow(tsMs(r.created_at))) continue;
        out.push({ table: "autonomy_reflections", id: r.id, created_at: r.created_at, provenance: "mechanical:window" });
      }
      const forageRows = lanes.forage!.filter((f) => f.consumed_at)
        .map((f) => ({ id: f.id, companion_id: f.companion_id, consumed_by: f.consumed_by, created_at: f.consumed_at as string })).sort(byTimeThenId);
      for (const f of forageRows) {
        const owned = f.companion_id === e.companion_id || (f.companion_id === null && !!f.consumed_by && f.consumed_by.includes(e.companion_id));
        if (!owned || !inWindow(tsMs(f.created_at))) continue;
        out.push({ table: "forage_finds", id: f.id, created_at: f.created_at, provenance: "mechanical:window" });
      }
      const runRows = lanes.runs!.filter((r) => r.started_at)
        .map((r) => ({ id: r.id, companion_id: r.companion_id, start: tsMs(r.started_at), created_at: (r.completed_at ?? r.started_at) as string })).sort(byTimeThenId);
      for (const r of runRows) {
        if (r.companion_id !== e.companion_id || r.start > at || tsMs(r.created_at) < windowLo) continue;
        out.push({ table: "autonomy_runs", id: r.id, created_at: r.created_at, provenance: "mechanical:window" });
      }
      for (const d of [...lanes.deltas!].sort(byTimeThenId)) {
        if (deltaOwner(d) !== e.companion_id) continue;
        const dAt = tsMs(d.created_at);
        if (e.session_id && d.session_id === e.session_id && dAt <= at) out.push({ table: "relational_deltas", id: d.id, created_at: d.created_at, provenance: "mechanical:session" });
        else if (inWindow(dAt)) out.push({ table: "relational_deltas", id: d.id, created_at: d.created_at, provenance: "mechanical:window" });
      }
      out.sort((a, b) => { const d = tsMs(b.created_at) - tsMs(a.created_at); return d !== 0 ? d : a.id.localeCompare(b.id); });
      return out.slice(0, 6).map((a) => ({
        src_table: "companion_soma_events", src_id: e.id, dst_table: a.table, dst_id: a.id,
        edge_type: "alongside", writer: e.writer, provenance: a.provenance, created_at: e.created_at,
      }));
    };
    const reference = [...events].sort(byTimeThenId).flatMap(referenceAlongside);
    expect(JSON.stringify(typesOf(baseline, "alongside"))).toBe(JSON.stringify(reference));
    // The fixture really exercises the interesting shapes and they survive the cap somewhere: an
    // interval run that straddles the late event (newest candidate, ends after it), the s2-session
    // journal + delta rows far outside the early event's window (session lane has no lower bound),
    // a run whose interval only touches the early event's window edge, and an excluded 60:01 row.
    const refIds = new Set(reference.map((x) => x.dst_id));
    for (const id of ["run-straddle", "j-s2", "d-s2", "run-old"]) expect(refIds.has(id), id).toBe(true);
    expect(refIds.has("c-out")).toBe(false);

    // Deterministic LCG shuffle so a failure reproduces; three different permutations.
    const shuffle = <T,>(arr: readonly T[], seed: number): T[] => {
      const out = [...arr];
      let s = seed;
      for (let i = out.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    for (const seed of [7, 1313, 717]) {
      const shuffled = buildSomaEventEdges(
        shuffle(events, seed), new Set(["s1"]),
        shuffle(lanes.journal!, seed + 1), shuffle(lanes.commons!, seed + 2), shuffle(lanes.reflections!, seed + 3),
        shuffle(lanes.forage!, seed + 4), shuffle(lanes.runs!, seed + 5), shuffle(lanes.deltas!, seed + 6),
      );
      expect(JSON.stringify(shuffled)).toBe(JSON.stringify(baseline));
    }
  });

  it("ties on created_at break on id, so identical stamps still order identically", () => {
    const events = [ev({ id: "zz" }), ev({ id: "aa", float_key: "soma_float_2" })];
    const a = buildSomaEventEdges(events, new Set(["s1"]), [], []);
    const b = buildSomaEventEdges([...events].reverse(), new Set(["s1"]), [], []);
    expect(a.map((e) => e.src_id)).toEqual(b.map((e) => e.src_id));
    expect(a[0]!.src_id).toBe("aa");
  });

  it("empty input produces no edges", () => {
    expect(buildSomaEventEdges([], new Set(), [], [])).toEqual([]);
  });
});

describe("rebuildGraph -- source (i) end to end", () => {
  const seed = () => ({
    sessions: [{ id: "s1" }],
    companion_soma_events: [
      { id: "e1", companion_id: "cypher", float_key: "soma_float_1", kind: "authored_close", writer: "cypher", cause_table: "handover_packets", cause_id: "h1", session_id: "s1", created_at: atMinus(30) },
      { id: "e2", companion_id: "cypher", float_key: "soma_float_1", kind: "tick", writer: "system", cause_table: "companion_ferment_events", cause_id: "f1", session_id: null, created_at: AT },
    ],
    companion_journal: [{ id: "j1", agent: "cypher", session_id: "s1", note_text: "held it", created_at: atMinus(40) }],
    commons_posts: [{ id: "p1", author: "raziel", created_at: atMinus(10) }],
  });

  it("reports all four families as separate, legible source counts", async () => {
    const { env, tables } = makeEnv(seed());
    const counts = await rebuildGraph(env);
    const by = Object.fromEntries(counts.map((c) => [c.source, c.inserted]));
    expect(by["companion_soma_events.cause"]!).toBe(2);
    expect(by["companion_soma_events.follows"]!).toBe(1);
    expect(by["companion_soma_events.session"]!).toBe(1);
    // e1 (in session s1, journal j1 precedes it); e2 has no session but IS inside the commons window.
    expect(by["companion_soma_events.alongside"]!).toBe(2);
    expect(tables.graph_edges!.filter((r) => r.src_table === "companion_soma_events")).toHaveLength(6);
  });

  it("the alongside report carries a per-table breakdown with every lane present, zeroes included", async () => {
    const { env } = makeEnv({
      ...seed(),
      autonomy_reflections: [{ id: "r1", companion_id: "cypher", reflection_text: "body never loaded", created_at: atMinus(3) }],
      forage_finds: [{ id: "f1", companion_id: null, consumed_at: atMinus(2), consumed_by: "cypher", gathered_at: atMinus(600) }],
      autonomy_runs: [{ id: "a1", companion_id: "cypher", run_type: "reflection", status: "completed", started_at: atMinus(15), completed_at: atMinus(4), created_at: atMinus(15) }],
      relational_deltas: [{ id: "d1", companion_id: "cypher", agent: null, session_id: "s1", created_at: atMinus(35) }],
    });
    const counts = await rebuildGraph(env);
    const alongside = counts.find((c) => c.source === "companion_soma_events.alongside")!;
    expect(Object.keys(alongside.lanes!).sort()).toEqual([...ALONGSIDE_LANES].sort());
    // e1 (atMinus 30, session s1): j1 (session) + d1 (session). e2 (AT, no session): p1, r1, f1, a1, d1 (window).
    expect(alongside.lanes).toEqual({
      companion_journal: 1,
      commons_posts: 1,
      autonomy_reflections: 1,
      forage_finds: 1,
      autonomy_runs: 1,
      relational_deltas: 2,
    });
    expect(alongside.inserted).toBe(7);
    // The other three families carry no breakdown -- `lanes` is only for merged-cap sources.
    expect(counts.find((c) => c.source === "companion_soma_events.cause")!.lanes).toBeUndefined();
  });

  it("with the tranche 2 tables empty, their lanes report as visible zeroes", async () => {
    const { env } = makeEnv(seed());
    const counts = await rebuildGraph(env);
    const alongside = counts.find((c) => c.source === "companion_soma_events.alongside")!;
    expect(alongside.lanes).toMatchObject({ autonomy_reflections: 0, forage_finds: 0, autonomy_runs: 0, relational_deltas: 0 });
  });

  it("is idempotent -- a second rebuild over unchanged sources inserts nothing new", async () => {
    const { env, tables } = makeEnv(seed());
    await rebuildGraph(env);
    const first = JSON.stringify(tables.graph_edges!);
    const counts = await rebuildGraph(env);
    expect(JSON.stringify(tables.graph_edges!)).toBe(first);
    for (const c of counts.filter((x) => x.source.startsWith("companion_soma_events"))) {
      // DELETE-then-rederive, so the inserts happen again; the resulting row SET is identical.
      expect(c.inserted).toBeGreaterThanOrEqual(0);
    }
  });

  it("an empty companion_soma_events table is a zero source, not a throw", async () => {
    const { env } = makeEnv({ sessions: [{ id: "s1" }] });
    const counts = await rebuildGraph(env);
    for (const s of ["cause", "follows", "session", "alongside"]) {
      expect(counts.find((c) => c.source === `companion_soma_events.${s}`)?.inserted).toBe(0);
    }
  });
});
