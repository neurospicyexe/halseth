// src/__tests__/graph-live.test.ts
//
// Graph memory Phase 1, live-write half (src/graph/live.ts, wired into the source writers
// listed in that file's header). Two guarantees under test:
//
//   1. BYTE-IDENTICAL SHAPE. A live write must produce the exact same GraphEdgeRow a nightly
//      rebuild (src/graph/rebuild.ts) would derive for the same source row -- otherwise
//      INSERT OR IGNORE's identity (the UNIQUE constraint) silently papers over a shape mismatch
//      and the two writers have quietly diverged. Every "byte-identical" test below imports
//      rebuild.ts's own exported builders (buildNoteEdges, buildSupersedesEdges) and compares
//      live.ts's helper output against them directly, not against a hand-copied expectation.
//   2. LIVE LANE SURVIVES REBUILD. 'resumed_from' (session open with prior_handover_id) is
//      provenance 'live', not 'mechanical' -- rebuildGraph must never derive or delete it. That
//      cross-file guarantee is exercised in graph-rebuild.test.ts; this file exercises the write
//      side: the edge is written exactly when prior_handover_id is present, absent otherwise.

import { describe, it, expect } from "vitest";
import { edgeForNote, edgeForNoteRef, edgeForConclusionSupersede, edgeForResumedFrom } from "../graph/live.js";
import { buildNoteEdges, buildSupersedesEdges } from "../graph/rebuild.js";
import { registerSessionTools } from "../mcp/tools/session.js";
import type { Env } from "../types.js";

// ── 1. inter_companion_notes -> 'sent_to' / 'references', byte-identical to rebuild ────────────

describe("edgeForNote: byte-identical to rebuild.ts's buildNoteEdges for the same row", () => {
  it("addressed note (to_id set): one 'sent_to' edge, same shape both ways", () => {
    const note = { id: "note1", from_id: "cypher", to_id: "drevan", created_at: "2026-08-20T00:00:00Z" };
    const live = edgeForNote(note);
    const rebuilt = buildNoteEdges([{ ...note, ref_type: null, ref_id: null }]);
    expect(live).toEqual(rebuilt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      src_table: "inter_companion_notes", src_id: "note1",
      dst_table: "companions", dst_id: "drevan",
      edge_type: "sent_to", writer: "cypher", provenance: "mechanical",
    });
  });

  it("broadcast note (to_id NULL): fans out to the other two companions, same shape both ways", () => {
    const note = { id: "note2", from_id: "gaia", to_id: null, created_at: "2026-08-20T00:00:00Z" };
    const live = edgeForNote(note);
    const rebuilt = buildNoteEdges([{ ...note, ref_type: null, ref_id: null }]);
    expect(live).toEqual(rebuilt);
    expect(live).toHaveLength(2);
    const dsts = live.map((e) => e.dst_id).sort();
    expect(dsts).toEqual(["cypher", "drevan"]);
    for (const e of live) expect(e.provenance).toBe("mechanical:broadcast");
  });
});

describe("edgeForNoteRef: byte-identical to rebuild.ts's buildNoteEdges 'references' half", () => {
  it("ref_type/ref_id present: one 'references' edge via NOTE_REF_TABLES, same shape both ways", () => {
    const note = { id: "note3", from_id: "cypher", created_at: "2026-08-20T00:00:00Z", ref_type: "tension" as const, ref_id: "t1" };
    const live = edgeForNoteRef(note);
    const rebuilt = buildNoteEdges([{ ...note, to_id: "drevan" }]).filter((e) => e.edge_type === "references");
    expect(live).toEqual(rebuilt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      src_table: "inter_companion_notes", src_id: "note3",
      dst_table: "companion_tensions", dst_id: "t1",
      edge_type: "references", writer: "cypher", provenance: "mechanical",
    });
  });

  it("no ref: empty array, matching rebuild's no-op for a plain note", () => {
    const note = { id: "note4", from_id: "cypher", created_at: "2026-08-20T00:00:00Z", ref_type: null, ref_id: null };
    expect(edgeForNoteRef(note)).toEqual([]);
  });
});

// ── 2. companion_conclusions.superseded_by -> 'supersedes', byte-identical to rebuild ──────────

describe("edgeForConclusionSupersede: byte-identical to rebuild.ts's buildSupersedesEdges", () => {
  it("direction and created_at match rebuild exactly: replacement --supersedes--> old, replacement's created_at", () => {
    const live = edgeForConclusionSupersede({
      replacementId: "new1", oldId: "old1", writer: "drevan", createdAt: "2026-03-05T00:00:00Z",
    });
    const rebuilt = buildSupersedesEdges([
      { id: "old1", companion_id: "drevan", superseded_by: "new1", created_at: "2026-01-01T00:00:00Z" },
      { id: "new1", companion_id: "drevan", superseded_by: null, created_at: "2026-03-05T00:00:00Z" },
    ])[0];
    expect(live).toEqual(rebuilt);
    expect(live.src_id).toBe("new1");
    expect(live.dst_id).toBe("old1");
    expect(live.created_at).toBe("2026-03-05T00:00:00Z");
    expect(live.provenance).toBe("mechanical");
  });
});

// ── 3. resumed_from edge on session open with prior_handover_id, absent without ─────────────────

interface CapturedTool {
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

class FakeMcpServer {
  tools: Record<string, CapturedTool> = {};
  tool(name: string, _description: string, _schema: unknown, handler: CapturedTool["handler"]): void {
    this.tools[name] = { handler };
  }
}

interface StmtCall { sql: string; bound: unknown[] }

function fakeSessionEnv(): { env: Env; calls: StmtCall[] } {
  const calls: StmtCall[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bound: unknown[]) {
            return {
              async run() { calls.push({ sql, bound }); return { meta: { changes: 1 } }; },
              async first() { return null; }, // findOpenSession short-circuits on missing surface anyway
            };
          },
        };
      },
      async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        const results = [];
        for (const s of stmts) results.push(await s.run());
        return results;
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("halseth_session_open: 'resumed_from' edge written iff prior_handover_id is present", () => {
  it("writes the edge when prior_handover_id is provided", async () => {
    const { env, calls } = fakeSessionEnv();
    const server = new FakeMcpServer();
    registerSessionTools(server as never, env);

    await server.tools["halseth_session_open"]!.handler({
      front_state: "raziel", session_type: "work", companion_id: "cypher",
      prior_handover_id: "handover-old-1",
    });

    const edgeInsert = calls.find((c) => c.sql.includes("INSERT OR IGNORE INTO graph_edges"));
    expect(edgeInsert).toBeDefined();
    const [srcTable, srcId, dstTable, dstId, edgeType, writer, provenance] = edgeInsert!.bound as string[];
    expect(srcTable).toBe("sessions");
    expect(dstTable).toBe("handover_packets");
    expect(dstId).toBe("handover-old-1");
    expect(edgeType).toBe("resumed_from");
    expect(writer).toBe("cypher");
    expect(provenance).toBe("live"); // NOT 'mechanical' -- rebuild must never touch this lane

    const sessionInsert = calls.find((c) => c.sql.includes("INSERT INTO sessions"));
    expect(srcId).toBe(sessionInsert!.bound[0]); // src_id is the NEW session's id

    const handoverUpdate = calls.find((c) => c.sql.includes("UPDATE handover_packets SET returned"));
    expect(handoverUpdate).toBeDefined();
  });

  it("writes no edge when prior_handover_id is absent", async () => {
    const { env, calls } = fakeSessionEnv();
    const server = new FakeMcpServer();
    registerSessionTools(server as never, env);

    await server.tools["halseth_session_open"]!.handler({
      front_state: "raziel", session_type: "work", companion_id: "cypher",
    });

    expect(calls.some((c) => c.sql.includes("INSERT OR IGNORE INTO graph_edges"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("UPDATE handover_packets"))).toBe(false);
  });

  it("writer falls back to 'system' when no companion_id is given", async () => {
    const { env, calls } = fakeSessionEnv();
    const server = new FakeMcpServer();
    registerSessionTools(server as never, env);

    await server.tools["halseth_session_open"]!.handler({
      front_state: "raziel", session_type: "work", prior_handover_id: "handover-old-2",
    });

    const edgeInsert = calls.find((c) => c.sql.includes("INSERT OR IGNORE INTO graph_edges"));
    expect(edgeInsert!.bound[5]).toBe("system"); // writer column
  });
});
