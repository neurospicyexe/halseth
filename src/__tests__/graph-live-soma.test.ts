// src/__tests__/graph-live-soma.test.ts
//
// Graph memory Phase 2, tranche 2 (2026-09-14): live edges at the AUTHORED soma writers.
//
// src/graph/live.ts's covenant: a live writer emits a GraphEdgeRow byte-identical to what the nightly
// rebuild (src/graph/rebuild.ts::buildSomaEventEdges) derives for the same row, in a rebuild-owned
// 'mechanical%' lane, appended to the SAME D1 batch as the primary write. Three guarantees under test:
//
//   1. BYTE-IDENTICAL SHAPE for the three live thirds ('moved_by', 'follows', 'logged_in'), compared
//      against rebuild's own builder output filtered by edge_type -- never a hand-copied expectation.
//      'alongside' is rebuild-only (journal scan + commons window) and is asserted ABSENT from live.
//   2. IDS ARE KNOWN BEFORE THE BATCH: assignSomaEventIds settles id + created_at client-side so the
//      edge rows can name the event row they hang off.
//   3. SAME BATCH (source-reading): both authored writers -- sessionClose and updateCompanionState in
//      src/librarian/backends/halseth.ts -- put the event + edge statements into the same `.batch([...])`
//      array as the float UPDATE. Never a second, separately-failable write.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { edgesForSomaEvent, insertEdgeStatements, type GraphEdgeRow } from "../graph/live.js";
import { buildSomaEventEdges, type SomaEventGraphRow } from "../graph/rebuild.js";
import {
  assignSomaEventIds,
  diffFloats,
  latestEventIdsByFloat,
  readLatestEventIdsSql,
  somaEventStatements,
  toSomaEventGraphRow,
  type SomaEventInput,
} from "../soma/events.js";
import { updateCompanionState } from "../librarian/backends/halseth.js";

const src = (p: string) => readFile(resolve(__dirname, "..", p), "utf8");

// rebuild.ts's builder is gaining trailing source arrays (a concurrent tranche); call it positionally
// with empty arrays for everything past (events, sessionIds) and filter its output by edge_type so this
// file only ever compares the three lanes live.ts owns.
type RebuildFn = (...args: unknown[]) => GraphEdgeRow[];
function rebuildEdges(events: SomaEventGraphRow[], sessionIds: Set<string>, types: string[]): GraphEdgeRow[] {
  const all = (buildSomaEventEdges as unknown as RebuildFn)(events, sessionIds, [], [], [], [], []);
  return all.filter((e) => types.includes(e.edge_type));
}

const LIVE_TYPES = ["moved_by", "follows", "logged_in"];

// ── 1. byte-identical to rebuild ──────────────────────────────────────────────────────────────

describe("edgesForSomaEvent: byte-identical to rebuild.ts's buildSomaEventEdges for the same row", () => {
  const prev: SomaEventGraphRow = {
    id: "evt-prev", companion_id: "cypher", float_key: "soma_float_1", kind: "tick", writer: "system",
    cause_table: "companion_ferment_events", cause_id: "fe-1", session_id: null, created_at: "2026-09-13T00:00:00.000Z",
  };

  it("authored_close: moved_by -> handover packet, follows -> previous event, logged_in -> session", () => {
    const event: SomaEventGraphRow = {
      id: "evt-close", companion_id: "cypher", float_key: "soma_float_1", kind: "authored_close", writer: "cypher",
      cause_table: "handover_packets", cause_id: "ho-1", session_id: "sess-1", created_at: "2026-09-14T10:00:00.000Z",
    };
    const live = edgesForSomaEvent(event, { prev_event_id: prev.id });
    const rebuilt = rebuildEdges([prev, event], new Set(["sess-1"]), LIVE_TYPES).filter((e) => e.src_id === event.id);
    expect(live).toEqual(rebuilt);
    expect(live.map((e) => e.edge_type)).toEqual(["moved_by", "follows", "logged_in"]);
    expect(live.find((e) => e.edge_type === "follows")?.writer).toBe("system");
    for (const e of live) expect(e.provenance).toBe("mechanical");
  });

  it("authored_update with a session cause (2026-09-14): moved_by -> sessions AND logged_in -> the same session", () => {
    const event: SomaEventGraphRow = {
      id: "evt-upd", companion_id: "drevan", float_key: "soma_float_2", kind: "authored_update", writer: "drevan",
      cause_table: "sessions", cause_id: "sess-9", session_id: "sess-9", created_at: "2026-09-14T11:00:00.000Z",
    };
    const live = edgesForSomaEvent(event, {});
    const rebuilt = rebuildEdges([event], new Set(["sess-9"]), LIVE_TYPES);
    expect(live).toEqual(rebuilt);
    expect(live.map((e) => e.edge_type)).toEqual(["moved_by", "logged_in"]);
    expect(live[0]).toMatchObject({ dst_table: "sessions", dst_id: "sess-9", writer: "drevan" });
  });

  it("bare authored_update (PATCH /soma, no session): only a follows edge when a predecessor exists, else nothing", () => {
    const event: SomaEventGraphRow = {
      id: "evt-bare", companion_id: "cypher", float_key: "soma_float_1", kind: "authored_update", writer: "cypher",
      cause_table: null, cause_id: null, session_id: null, created_at: "2026-09-14T12:00:00.000Z",
    };
    const withPrev = edgesForSomaEvent(event, { prev_event_id: prev.id });
    expect(withPrev).toEqual(rebuildEdges([prev, event], new Set(), LIVE_TYPES).filter((e) => e.src_id === event.id));
    expect(withPrev.map((e) => e.edge_type)).toEqual(["follows"]);
    expect(edgesForSomaEvent(event, {})).toEqual([]);
    expect(edgesForSomaEvent(event, { prev_event_id: null })).toEqual([]);
  });

  it("never emits 'alongside' -- that lane needs the journal/commons scans and stays rebuild-only", () => {
    const event: SomaEventGraphRow = {
      id: "evt-x", companion_id: "gaia", float_key: "soma_float_3", kind: "authored_close", writer: "gaia",
      cause_table: "handover_packets", cause_id: "ho-2", session_id: "sess-2", created_at: "2026-09-14T13:00:00.000Z",
    };
    expect(edgesForSomaEvent(event, { prev_event_id: "p" }).some((e) => e.edge_type === "alongside")).toBe(false);
  });

  it("follows chain is per (companion, float): a predecessor on another float is the caller's mistake to avoid, and the pre-read is keyed per float", () => {
    const rows = [{ float_key: "soma_float_1", id: "a" }, { float_key: "soma_float_3", id: "c" }, { float_key: "bogus", id: "z" }];
    const m = latestEventIdsByFloat(rows);
    expect([...m.entries()]).toEqual([["soma_float_1", "a"], ["soma_float_3", "c"]]);
    expect(m.get("soma_float_2")).toBeUndefined();
    // Same ordering as loadSomaProvenance's window, one row per float. The replace() is load-bearing:
    // the table holds space-form backfilled stamps AND ISO live stamps, and a raw string sort puts
    // every 'T' row above every ' ' row regardless of time (see SOMA_EVENT_ORDER_DESC).
    expect(readLatestEventIdsSql()).toMatch(/PARTITION BY float_key ORDER BY replace\(created_at, ' ', 'T'\) DESC, id DESC/);
    expect(readLatestEventIdsSql()).toMatch(/WHERE rn = 1/);
  });
});

// ── 2. ids known before the batch ─────────────────────────────────────────────────────────────

describe("assignSomaEventIds: ids and created_at are settled client-side, before any SQL runs", () => {
  const base: Omit<SomaEventInput, "float_key" | "before_value" | "after_value"> = {
    companion_id: "cypher", kind: "authored_update", writer: "cypher", session_id: "s1",
    cause_table: "sessions", cause_id: "s1",
  };

  it("mints a dashless uuid per event, shares one `now`, and keeps an id/created_at already present", () => {
    const now = "2026-09-14T14:00:00.000Z";
    const events = assignSomaEventIds(
      [...diffFloats({ soma_float_1: 0.5, soma_float_2: 0.5 }, { soma_float_1: 0.6, soma_float_2: 0.7 }, base),
        { ...base, float_key: "soma_float_3", before_value: 0.1, after_value: 0.2, id: "keep-me", created_at: "2026-01-01T00:00:00.000Z" }],
      now,
    );
    expect(events).toHaveLength(3);
    expect(events[0]!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(events[1]!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(events[0]!.created_at).toBe(now);
    expect(events[2]!.id).toBe("keep-me");
    expect(events[2]!.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("the event INSERT binds the pre-minted id and the edge rows reference that same id", () => {
    const bound: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => { bound.push([sql, ...args]); return {}; } }),
    } as unknown as D1Database;
    const [e] = assignSomaEventIds(diffFloats({ soma_float_1: 0.5 }, { soma_float_1: 0.6 }, base), "2026-09-14T14:00:00.000Z");
    const edges = edgesForSomaEvent(toSomaEventGraphRow(e!), { prev_event_id: "prev-1" });
    somaEventStatements(db, [e!]);
    insertEdgeStatements(db, edges);
    const insertRow = bound[0]!;
    expect(insertRow[1]).toBe(e!.id);
    for (const edgeRow of bound.slice(1)) {
      expect(edgeRow[0]).toMatch(/INSERT OR IGNORE INTO graph_edges/);
      expect(edgeRow[2]).toBe(e!.id); // src_id
      expect(edgeRow[8]).toBe("2026-09-14T14:00:00.000Z"); // created_at agrees with the event row
    }
    expect(bound.slice(1).map((r) => r[5])).toEqual(["moved_by", "follows", "logged_in"]);
  });
});

// ── 3. same batch as the float UPDATE (source-reading + behavioural) ──────────────────────────

describe("authored writers put event + edge statements into the SAME batch as the float UPDATE", () => {
  // Source-reading by necessity: sessionClose has no behavioural double here (its close body fans
  // out across a dozen tables and would need a full D1 fake), so the batch shape is pinned by text.
  // updateCompanionState is covered by the behavioural double below instead; its regex twin was
  // removed as redundant (2026-09-14 review).
  it("sessionClose: stmts holds the UPDATE companion_state and the event/edge statements, then ONE env.DB.batch(stmts)", async () => {
    const backend = await src("librarian/backends/halseth.ts");
    const fn = backend.slice(backend.indexOf("export async function sessionClose("));
    const close = fn.slice(0, fn.indexOf("await env.DB.batch(stmts);"));
    expect(close).toMatch(/stmts\.push\(\s*env\.DB\.prepare\(`UPDATE companion_state SET/);
    expect(close).toMatch(/stmts\.push\(\.\.\.somaEventAndEdgeStatements\(env, events, prevEventIds\)\)/);
    // No second batch/run for events or edges anywhere inside the close body.
    expect(close).not.toMatch(/env\.DB\.batch\(somaEventStatements/);
    expect(close).not.toMatch(/writeEdgesBestEffort/);
    // The helper it calls is the one that fuses events + edges into one list.
    expect(backend).toMatch(/function somaEventAndEdgeStatements\([\s\S]*?return \[\.\.\.somaEventStatements\(env\.DB, events\), \.\.\.insertEdgeStatements\(env\.DB, edges\)\];/);
  });

  it("updateCompanionState (behavioural): one batch whose first statement is the UPDATE, followed by the event INSERT, moved_by, follows and logged_in edges", async () => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const batches: { sql: string; binds: unknown[] }[][] = [];
    const mk = (sql: string, binds: unknown[]) => ({
      sql, binds,
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => (/FROM companion_state/.test(sql) ? { soma_float_1: 0.5, soma_float_2: null, soma_float_3: null, version: 4 } : null),
      all: async () => ({ results: /FROM companion_soma_events/.test(sql) ? [{ float_key: "soma_float_1", id: "prev-evt" }] : [] }),
    });
    const env = {
      DB: {
        prepare: (sql: string) => ({ bind: (...binds: unknown[]) => { const s = mk(sql, binds); calls.push(s); return s; } }),
        batch: async (stmts: { sql: string; binds: unknown[] }[]) => { batches.push(stmts); return stmts.map(() => ({ meta: { changes: 1 } })); },
      },
    } as unknown as Parameters<typeof updateCompanionState>[0];

    const r = await updateCompanionState(env, "cypher", { soma_float_1: 0.62 }, { session_id: "sess-42", detail: "update my state: acuity 0.62" });
    expect(r.ok).toBe(true);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch[0]!.sql).toMatch(/^UPDATE companion_state SET soma_float_1 = \?/);
    expect(batch[1]!.sql).toMatch(/INSERT OR IGNORE INTO companion_soma_events/);
    const eventId = batch[1]!.binds[0] as string;
    expect(eventId).toMatch(/^[0-9a-f]{32}$/);
    // cause_table / cause_id / session_id columns (positions 8, 9, 10 in EVENT_COLUMNS order).
    expect(batch[1]!.binds.slice(8, 11)).toEqual(["sessions", "sess-42", "sess-42"]);
    const edgeStmts = batch.slice(2);
    expect(edgeStmts.map((s) => s.binds[4])).toEqual(["moved_by", "follows", "logged_in"]);
    for (const s of edgeStmts) {
      expect(s.sql).toMatch(/INSERT OR IGNORE INTO graph_edges/);
      expect(s.binds[1]).toBe(eventId);
    }
    expect(edgeStmts[0]!.binds.slice(2, 4)).toEqual(["sessions", "sess-42"]);
    expect(edgeStmts[1]!.binds.slice(2, 4)).toEqual(["companion_soma_events", "prev-evt"]);
    expect(edgeStmts[2]!.binds.slice(2, 4)).toEqual(["sessions", "sess-42"]);
    // The predecessor pre-read happened exactly once and only because a float was written.
    expect(calls.filter((c) => /ROW_NUMBER\(\) OVER \(PARTITION BY float_key/.test(c.sql))).toHaveLength(1);
    // No stray .run() of the UPDATE outside the batch.
    expect(calls.filter((c) => /^UPDATE companion_state/.test(c.sql))).toHaveLength(1);
  });

  it("updateCompanionState (behavioural): a mood-only write takes no pre-read and no batch", async () => {
    const calls: string[] = [];
    let batched = 0;
    const env = {
      DB: {
        prepare: (sql: string) => ({ bind: () => { calls.push(sql); return { run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) }; } }),
        batch: async (stmts: unknown[]) => { batched++; return stmts.map(() => ({ meta: { changes: 1 } })); },
      },
    } as unknown as Parameters<typeof updateCompanionState>[0];
    const r = await updateCompanionState(env, "gaia", { current_mood: "still" }, { session_id: "s", detail: "d" });
    expect(r.ok).toBe(true);
    expect(batched).toBe(0);
    expect(calls.some((s) => /companion_soma_events/.test(s))).toBe(false);
    expect(calls.filter((s) => /^UPDATE companion_state/.test(s))).toHaveLength(1);
  });
});
