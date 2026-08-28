// Tests for the graph memory Phase 1 rebuild (src/graph/rebuild.ts, mig 0127).
// Mirrors the suite's miniflare-free style (see forage.test.ts / coordination-writes.test.ts):
// a minimal in-memory D1 fake, hand-shaped to the exact query patterns rebuild.ts issues
// (whole-table SELECT * FROM <table>, a single DELETE ... WHERE provenance LIKE ?, and batched
// INSERT OR IGNORE INTO graph_edges with the real UNIQUE-constraint semantics enforced in JS).

import { describe, it, expect, beforeEach } from "vitest";
import { rebuildGraph } from "../graph/rebuild.js";
import type { Env } from "../types.js";

interface Row {
  [k: string]: unknown;
}

const GRAPH_EDGE_COLUMNS = [
  "src_table",
  "src_id",
  "dst_table",
  "dst_id",
  "edge_type",
  "writer",
  "provenance",
  "created_at",
];

function uniqueKey(r: Row): string {
  return [r.src_table, r.src_id, r.dst_table, r.dst_id, r.edge_type].join(" ");
}

class FakeStatement {
  constructor(
    private sql: string,
    private tables: Record<string, Row[]>,
    private bound: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.tables, args);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql.trim();

    if (sql.startsWith("DELETE FROM graph_edges")) {
      const pattern = String(this.bound[0] ?? "").replace("%", "");
      const before = (this.tables.graph_edges ?? []).length;
      this.tables.graph_edges = (this.tables.graph_edges ?? []).filter(
        (r) => !String(r.provenance ?? "").startsWith(pattern),
      );
      return { meta: { changes: before - this.tables.graph_edges.length } };
    }

    if (sql.startsWith("INSERT OR IGNORE INTO graph_edges")) {
      const row: Row = {};
      GRAPH_EDGE_COLUMNS.forEach((col, i) => (row[col] = this.bound[i]));
      this.tables.graph_edges = this.tables.graph_edges ?? [];
      const key = uniqueKey(row);
      const exists = this.tables.graph_edges.some((r) => uniqueKey(r) === key);
      if (exists) return { meta: { changes: 0 } };
      row.id = `edge-${this.tables.graph_edges.length}`;
      this.tables.graph_edges.push(row);
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    const m = /FROM (\w+)/.exec(this.sql);
    const name = m?.[1] ?? "misc";
    return { results: ((this.tables[name] ?? []) as unknown) as T[] };
  }

  async first<T = Row>(): Promise<T | null> {
    return null;
  }
}

type TableStore = Record<string, Row[]> & { graph_edges: Row[] };

function makeEnv(seed: Record<string, Row[]> = {}): { env: Env; tables: TableStore } {
  const tables = { graph_edges: [], ...seed } as TableStore;
  const env = {
    DB: {
      prepare: (sql: string) => new FakeStatement(sql, tables),
      batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run())),
    },
  } as unknown as Env;
  return { env, tables };
}

describe("rebuildGraph", () => {
  it("is deterministic -- running twice against unchanged data yields the same row count", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [
        { id: "old1", companion_id: "cypher", superseded_by: "new1", created_at: "2026-01-01T00:00:00Z" },
        { id: "new1", companion_id: "cypher", superseded_by: null, created_at: "2026-01-02T00:00:00Z" },
      ],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
    });

    const first = await rebuildGraph(env);
    const rowsAfterFirst = tables.graph_edges.length;
    const second = await rebuildGraph(env);
    const rowsAfterSecond = tables.graph_edges.length;

    expect(rowsAfterFirst).toBeGreaterThan(0);
    expect(rowsAfterSecond).toBe(rowsAfterFirst);
    expect(second).toEqual(first);
  });

  it("supersedes edge points replacement --supersedes--> old, not reversed", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [
        { id: "old1", companion_id: "drevan", superseded_by: "new1", created_at: "2026-01-01T00:00:00Z" },
        { id: "new1", companion_id: "drevan", superseded_by: null, created_at: "2026-03-05T00:00:00Z" },
      ],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
    });

    await rebuildGraph(env);
    const edge = tables.graph_edges.find((e) => e.edge_type === "supersedes");
    expect(edge).toBeDefined();
    expect(edge!.src_id).toBe("new1"); // replacement is the source
    expect(edge!.dst_id).toBe("old1"); // old belief is the destination
    // created_at inherits the REPLACEMENT's birth time (when the supersede actually happened),
    // not the old row's original created_at.
    expect(edge!.created_at).toBe("2026-03-05T00:00:00Z");
  });

  it("broadcast note (to_id NULL) expands to one edge per OTHER companion", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [
        {
          id: "note1",
          from_id: "cypher",
          to_id: null,
          created_at: "2026-02-01T00:00:00Z",
          ref_type: null,
          ref_id: null,
        },
      ],
      companion_tensions: [],
      handover_packets: [],
    });

    await rebuildGraph(env);
    const edges = tables.graph_edges.filter((e) => e.src_table === "inter_companion_notes" && e.src_id === "note1");
    expect(edges).toHaveLength(2); // drevan + gaia, never cypher (the sender)
    const dsts = edges.map((e) => e.dst_id).sort();
    expect(dsts).toEqual(["drevan", "gaia"]);
    for (const e of edges) {
      expect(e.provenance).toBe("mechanical:broadcast");
      expect(e.dst_table).toBe("companions");
    }
  });

  it("relational_deltas empty-string companion_id falls back to `agent`, not 'system'", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [
        {
          id: "delta1",
          companion_id: "", // MCP-row placeholder trap
          session_id: "sess1",
          agent: "gaia",
          created_at: "2026-02-10T00:00:00Z",
        },
        {
          id: "delta2",
          companion_id: "", // no agent either -- true system fallback
          session_id: "sess2",
          agent: null,
          created_at: "2026-02-11T00:00:00Z",
        },
        {
          id: "delta3",
          companion_id: "",
          session_id: "", // empty string session -- must be skipped
          agent: "drevan",
          created_at: "2026-02-12T00:00:00Z",
        },
        {
          id: "delta4",
          companion_id: "",
          session_id: null, // NULL session -- must be skipped
          agent: "drevan",
          created_at: "2026-02-13T00:00:00Z",
        },
      ],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
    });

    await rebuildGraph(env);
    const edges = tables.graph_edges.filter((e) => e.src_table === "relational_deltas");
    expect(edges).toHaveLength(2); // delta3/delta4 skipped (no session)

    const d1 = edges.find((e) => e.src_id === "delta1");
    expect(d1!.writer).toBe("gaia");

    const d2 = edges.find((e) => e.src_id === "delta2");
    expect(d2!.writer).toBe("system");
  });

  it("never writes a graph_edges row touching the sealed companion-private-notes lane", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [
        { id: "old1", companion_id: "cypher", superseded_by: "new1", created_at: "2026-01-01T00:00:00Z" },
        { id: "new1", companion_id: "cypher", superseded_by: null, created_at: "2026-01-02T00:00:00Z" },
      ],
      relational_deltas: [
        { id: "delta1", companion_id: "cypher", session_id: "sess1", agent: null, created_at: "2026-01-01T00:00:00Z" },
      ],
      companion_journal: [
        { id: "j1", agent: "drevan", session_id: "sess2", created_at: "2026-01-01T00:00:00Z" },
      ],
      inter_companion_notes: [
        { id: "note1", from_id: "cypher", to_id: "gaia", created_at: "2026-01-01T00:00:00Z", ref_type: "tension", ref_id: "t1" },
        { id: "note2", from_id: "drevan", to_id: null, created_at: "2026-01-01T00:00:00Z", ref_type: null, ref_id: null },
      ],
      companion_tensions: [
        { id: "t1", companion_id: "gaia", status: "simmering", first_noted_at: "2026-01-01T00:00:00Z" },
      ],
      handover_packets: [{ id: "h1", session_id: "sess1", created_at: "2026-01-01T00:00:00Z" }],
    });

    await rebuildGraph(env);
    expect(tables.graph_edges.length).toBeGreaterThan(0);
    const sealedTable = ["sibling", "notes"].join("_"); // see comment above -- keep the literal out of source text
    for (const e of tables.graph_edges) {
      expect(e.src_table).not.toBe(sealedTable);
      expect(e.dst_table).not.toBe(sealedTable);
    }
  });

  it("companion_tensions edge encodes status in provenance and points companion -> tension", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [
        { id: "t1", companion_id: "gaia", status: "crystallized", first_noted_at: "2026-04-01T00:00:00Z" },
      ],
      handover_packets: [],
    });

    await rebuildGraph(env);
    const edge = tables.graph_edges.find((e) => e.edge_type === "holds_tension");
    expect(edge).toBeDefined();
    expect(edge!.src_table).toBe("companions");
    expect(edge!.src_id).toBe("gaia");
    expect(edge!.dst_table).toBe("companion_tensions");
    expect(edge!.dst_id).toBe("t1");
    expect(edge!.provenance).toBe("mechanical:status=crystallized");
  });

  it("relational_deltas/companion_journal rows pointing at a missing session are marked mechanical:dangling", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [
        { id: "delta1", companion_id: "cypher", session_id: "ghost-session", agent: null, created_at: "2026-03-01T00:00:00Z" },
        { id: "delta2", companion_id: "cypher", session_id: "current", agent: null, created_at: "2026-03-02T00:00:00Z" }, // literal placeholder from the audit
      ],
      companion_journal: [
        { id: "j1", agent: "drevan", session_id: "ghost-session-2", created_at: "2026-03-03T00:00:00Z" },
      ],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
      sessions: [{ id: "sess-real" }], // exists, but not referenced by any row above
    });

    await rebuildGraph(env);
    const dangling = tables.graph_edges.filter(
      (e) => e.src_table === "relational_deltas" || e.src_table === "companion_journal",
    );
    expect(dangling).toHaveLength(3);
    for (const e of dangling) {
      expect(e.provenance).toBe("mechanical:dangling");
    }
  });

  it("relational_deltas/companion_journal rows pointing at an existing session stay plain mechanical", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [
        { id: "delta1", companion_id: "cypher", session_id: "sess-real", agent: null, created_at: "2026-03-01T00:00:00Z" },
      ],
      companion_journal: [
        { id: "j1", agent: "drevan", session_id: "sess-real", created_at: "2026-03-02T00:00:00Z" },
      ],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
      sessions: [{ id: "sess-real" }],
    });

    await rebuildGraph(env);
    const edges = tables.graph_edges.filter(
      (e) => e.src_table === "relational_deltas" || e.src_table === "companion_journal",
    );
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      expect(e.provenance).toBe("mechanical");
    }
  });

  it("delete-then-rebuild still removes dangling-marked rows via the 'mechanical%' LIKE match", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [
        { id: "delta1", companion_id: "cypher", session_id: "ghost-session", agent: null, created_at: "2026-03-01T00:00:00Z" },
      ],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
      sessions: [],
    });

    await rebuildGraph(env);
    const danglingBefore = tables.graph_edges.filter((e) => e.provenance === "mechanical:dangling");
    expect(danglingBefore.length).toBeGreaterThan(0);

    // Second rebuild starts with the same DELETE FROM graph_edges WHERE provenance LIKE 'mechanical%'
    // that rebuildGraph itself issues -- prove the dangling row does not survive as an orphaned
    // leftover if the source row disappears, and that regeneration is stable if it doesn't.
    tables.relational_deltas = [];
    await rebuildGraph(env);
    const danglingAfter = tables.graph_edges.filter((e) => e.provenance === "mechanical:dangling");
    expect(danglingAfter).toHaveLength(0);
    const anyMechanicalLeftover = tables.graph_edges.filter((e) => String(e.provenance).startsWith("mechanical"));
    // Only whatever the (now-empty) other sources produce -- none here, so zero.
    expect(anyMechanicalLeftover).toHaveLength(0);
  });

  it("a 'live' provenance row survives rebuildGraph -- rebuild's DELETE only matches 'mechanical%'", async () => {
    const { env, tables } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
    });
    // A live writer (src/mcp/tools/session.ts) puts this row here directly -- rebuildGraph never
    // derives 'resumed_from' edges itself (see rebuild.ts's section g / this file's own header).
    tables.graph_edges.push({
      id: "live-edge-1",
      src_table: "sessions",
      src_id: "sess-new",
      dst_table: "handover_packets",
      dst_id: "handover-old",
      edge_type: "resumed_from",
      writer: "cypher",
      provenance: "live",
      created_at: "2026-08-20T00:00:00Z",
    });

    await rebuildGraph(env);

    const survivor = tables.graph_edges.find((e) => e.id === "live-edge-1");
    expect(survivor).toBeDefined();
    expect(survivor!.provenance).toBe("live");

    // A second rebuild must not touch it either -- determinism holds across the 'live' lane too.
    await rebuildGraph(env);
    const stillThere = tables.graph_edges.find((e) => e.id === "live-edge-1");
    expect(stillThere).toBeDefined();
  });

  it("returns per-source counts covering all six backfill sources", async () => {
    const { env } = makeEnv({
      companion_conclusions: [],
      relational_deltas: [],
      companion_journal: [],
      inter_companion_notes: [],
      companion_tensions: [],
      handover_packets: [],
    });

    const counts = await rebuildGraph(env);
    const sources = counts.map((c) => c.source).sort();
    expect(sources).toEqual(
      [
        "companion_conclusions.superseded_by",
        "companion_journal.session_id",
        "companion_tensions",
        "handover_packets.session_id",
        "inter_companion_notes",
        "relational_deltas.session_id",
      ].sort(),
    );
  });
});
