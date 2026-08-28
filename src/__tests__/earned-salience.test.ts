// Task 19 (thinking-quality fix 5, mig 0105): recall warms journal rows + filters
// archived; orient orders conclusions by heat + warms surfaced ones.
//
// (a) recallNotesByMeaning warms returned companion_journal rows (heat bump,
//     mirroring the pre-existing wm_continuity_notes warm in the same function).
// (b) recallNotesByMeaning's journal candidate SQL excludes archived=1 rows.
// (c) mindOrient's active_conclusions queries order by effective heat (not
//     created_at), and a warm UPDATE fires for every surfaced conclusion id
//     (both the type-distributed pass and the flagged-beliefs pass).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/embed.js")>();
  return {
    ...actual,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  };
});

import { recallNotesByMeaning } from "../webmind/notes.js";

interface FakeMatch { score: number; metadata: { table: string; row_id: string; companion_id: string } }
interface FakeJournalEdgeRow {
  id: string; src_table: string; src_id: string; dst_table: string; dst_id: string;
  edge_type: string; writer: string; created_at: string;
}

function makeRecallEnv(opts: {
  journal?: FakeMatch[];
  journalRows?: Record<string, unknown>[];
  graphEdges?: FakeJournalEdgeRow[];
}) {
  const executed: string[] = [];
  const env = {
    VECTORIZE: {
      query: vi.fn(async (_v: number[], q: { filter: { table: string } }) => {
        const table = q.filter.table;
        if (table === "companion_journal") return { matches: opts.journal ?? [] };
        return { matches: [] };
      }),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM companion_journal")) return { results: opts.journalRows ?? [] };
            // Graph-memory Phase 1.5 (Tranche 3): default empty -- degree 0 everywhere,
            // connectivityMultiplier(0) === 1, so pre-existing recall assertions stay valid
            // unchanged unless a test explicitly supplies graphEdges.
            if (sql.includes("FROM graph_edges")) return { results: opts.graphEdges ?? [] };
            return { results: [] };
          },
          run: async () => { executed.push(sql); return { meta: { changes: 1 } }; },
        }),
      }),
    },
  };
  return { env: env as never, executed };
}

const journalRow = (id: string, source: string | null) =>
  ({ id, note_text: `journal ${id}`, created_at: "2026-07-03T00:00:00Z", source });

beforeEach(() => vi.clearAllMocks());

describe("recallNotesByMeaning -- journal warm + archived filter (task 19)", () => {
  it("issues a warmSql UPDATE on companion_journal binding the returned journal ids", async () => {
    const { env, executed } = makeRecallEnv({
      journal: [
        { score: 0.90, metadata: { table: "companion_journal", row_id: "j1", companion_id: "cypher" } },
        { score: 0.80, metadata: { table: "companion_journal", row_id: "j2", companion_id: "cypher" } },
      ],
      journalRows: [journalRow("j1", "claude_code"), journalRow("j2", "claude_code")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "what happened", 5);
    expect(out.map(n => n.note_id).sort()).toEqual(["j1", "j2"]);

    const journalWarms = executed.filter(sql => sql.includes("UPDATE companion_journal"));
    expect(journalWarms).toHaveLength(1);
    expect(journalWarms[0]).toContain("SET heat = MIN(");
    expect(journalWarms[0]).toContain("last_access_at = datetime('now')");
    expect(journalWarms[0]).toContain("id IN (?, ?)");
  });

  it("never warms companion_journal when no journal rows are returned", async () => {
    const { env, executed } = makeRecallEnv({});
    const out = await recallNotesByMeaning(env, "cypher", "nothing here", 5);
    expect(out).toEqual([]);
    expect(executed.some(sql => sql.includes("UPDATE companion_journal"))).toBe(false);
  });

  it("scopes the journal candidate SELECT to archived = 0", async () => {
    let candidateSql = "";
    const env = {
      VECTORIZE: {
        query: vi.fn(async (_v: number[], q: { filter: { table: string } }) => {
          if (q.filter.table === "companion_journal") {
            return { matches: [{ score: 0.9, metadata: { table: "companion_journal", row_id: "j1", companion_id: "cypher" } }] };
          }
          return { matches: [] };
        }),
      },
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("FROM companion_journal") && sql.includes("SELECT id")) candidateSql = sql;
          return {
            bind: (..._args: unknown[]) => ({
              all: async () => (sql.includes("FROM companion_journal") && sql.includes("SELECT id"))
                ? { results: [journalRow("j1", "claude_code")] }
                : { results: [] },
              run: async () => ({ meta: { changes: 1 } }),
            }),
          };
        },
      },
    };
    await recallNotesByMeaning(env as never, "cypher", "archived check", 5);
    expect(candidateSql).toContain("archived = 0");
  });
});

// --- recallNotesByMeaning: graph salience nudges journal ranking (Phase 1.5, Tranche 3) ---
//
// Two journal candidates, limit=1 (only one wins). By vector-score * source-weight alone:
//   j1: score 0.60, source "legacy" (unclassified -> neutral weight 0.85) -> effective 0.51
//   j2: score 0.50, source "claude_code" (HUMAN_SOURCES -> weight 1.0)    -> effective 0.50
// so the un-multiplied winner is j1. One graph_edges row touches (companions, "cypher") on one
// endpoint and companion_journal/j2 on the other -- reader-relevant for cypher (hub match, mig
// 0127 rebuild.ts convention) -- giving j2 degree 1 -> connectivityMultiplier(1) ~= 1.104 ->
// graph score 0.50 * 1.104 ~= 0.552, which now outranks j1's 0.51. The winner flips to j2.
describe("recallNotesByMeaning -- graph salience nudges journal ranking (Phase 1.5, Tranche 3)", () => {
  const journalMatches: FakeMatch[] = [
    { score: 0.60, metadata: { table: "companion_journal", row_id: "j1", companion_id: "cypher" } },
    { score: 0.50, metadata: { table: "companion_journal", row_id: "j2", companion_id: "cypher" } },
  ];
  const journalRows = [journalRow("j1", "legacy"), journalRow("j2", "claude_code")];
  const graphEdges: FakeJournalEdgeRow[] = [{
    id: "edge-1", src_table: "companions", src_id: "cypher",
    dst_table: "companion_journal", dst_id: "j2",
    edge_type: "logged_in", writer: "cypher", created_at: "2026-08-01T00:00:00Z",
  }];

  it("BEFORE (no graph signal): un-multiplied score*weight order picks j1", async () => {
    const { env } = makeRecallEnv({ journal: journalMatches, journalRows });
    const out = await recallNotesByMeaning(env, "cypher", "what happened", 1);
    expect(out.map(n => n.note_id)).toEqual(["j1"]);
  });

  it("AFTER (graph signal present): connectivity flips the winner to j2 for the reader the edge belongs to (cypher)", async () => {
    const { env } = makeRecallEnv({ journal: journalMatches, journalRows, graphEdges });
    const out = await recallNotesByMeaning(env, "cypher", "what happened", 1);
    expect(out.map(n => n.note_id)).toEqual(["j2"]);
  });

  it("is non-fatal: a neighborhood() failure degrades to the un-multiplied order, never throws", async () => {
    const { env } = makeRecallEnv({ journal: journalMatches, journalRows });
    (env as { DB: { prepare: (sql: string) => unknown } }).DB.prepare = ((sql: string) => {
      if (sql.includes("FROM graph_edges")) throw new Error("D1 unavailable");
      return {
        bind: (..._args: unknown[]) => ({
          all: async () => sql.includes("FROM companion_journal") ? { results: journalRows } : { results: [] },
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
    }) as never;
    const out = await recallNotesByMeaning(env, "cypher", "what happened", 1);
    expect(out.map(n => n.note_id)).toEqual(["j1"]);
  });
});

// --- orient: active_conclusions ordered by heat, surfaced ids warmed ---------------

import { mindOrient } from "../webmind/orient.js";
import { effectiveHeatSql } from "../webmind/heat.js";

vi.mock("../webmind/relational.js", () => ({
  readRelationalSnapshot: vi.fn(async () => null),
}));
vi.mock("../webmind/limbic.js", () => ({
  getCurrentLimbicState: vi.fn(async () => null),
  writeLimbicState: vi.fn(async () => undefined),
}));
vi.mock("../webmind/spiral.js", () => ({
  readRecentSpiralTurn: vi.fn(async () => null),
}));
vi.mock("../webmind/home/store.js", () => ({
  takeUnsurfacedEvents: vi.fn(async () => []),
}));

type Stmt = {
  bind: (...args: unknown[]) => Stmt;
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function makeStmt(sql: string, rowsFn: (args: unknown[]) => unknown[], runsSink: Array<{ sql: string; args: unknown[] }>): Stmt {
  let boundArgs: unknown[] = [];
  const stmt: Stmt = {
    bind: (...args: unknown[]) => { boundArgs = args; return stmt; },
    all: async () => ({ results: rowsFn(boundArgs) }),
    first: async () => (rowsFn(boundArgs)[0] ?? null),
    run: async () => { runsSink.push({ sql, args: boundArgs }); return { meta: { changes: boundArgs.length } }; },
  };
  return stmt;
}

function conclusionRow(id: string, beliefType: string, effectiveHeat = 1) {
  return {
    id, companion_id: "cypher", conclusion_text: `belief ${id}`, source_sessions: null,
    superseded_by: null, created_at: "2026-07-01T00:00:00Z", edited_at: null,
    confidence: 0.7, belief_type: beliefType, subject: null, provenance: null,
    contradiction_flagged: 0, effective_heat: effectiveHeat,
  };
}

interface FakeEdgeRow {
  id: string; src_table: string; src_id: string; dst_table: string; dst_id: string;
  edge_type: string; writer: string; created_at: string;
}

function makeOrientEnv(opts: {
  observationalRows?: ReturnType<typeof conclusionRow>[];
  graphEdges?: FakeEdgeRow[];
} = {}) {
  const preparedSql: string[] = [];
  const runs: Array<{ sql: string; args: unknown[] }> = [];

  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);

        if (sql.includes("FROM wm_identity_anchor_snapshot")) {
          return makeStmt(sql, () => [{ agent_id: "cypher", anchor_text: "x" }], runs);
        }
        if (sql.includes("FROM companion_conclusions") && sql.includes("belief_type = ?")) {
          return makeStmt(sql, (args) => {
            const type = args[1];
            if (type === "self") return [conclusionRow("c-self-1", "self")];
            if (type === "relational") return [conclusionRow("c-rel-1", "relational")];
            if (type === "observational" && opts.observationalRows) return opts.observationalRows;
            return [];
          }, runs);
        }
        if (sql.includes("FROM companion_conclusions") && sql.includes("contradiction_flagged = 1")) {
          return makeStmt(sql, () => [conclusionRow("c-flag-1", "systemic")], runs);
        }
        if (sql.includes("FROM biometric_snapshots") || sql.includes("FROM house_state")) {
          return makeStmt(sql, () => [], runs);
        }
        // Graph-memory Phase 1.5 (Tranche 2): the fixture answers NOTHING for graph_edges by
        // default (empty rows) -- degree 0 everywhere, connectivityMultiplier(0) === 1, so the
        // pre-existing effective-heat order is untouched and every assertion above this line
        // stays valid unchanged. Tests that need a real graph pass `graphEdges`.
        if (sql.includes("FROM graph_edges")) {
          return makeStmt(sql, () => opts.graphEdges ?? [], runs);
        }
        // Everything else (threads, notes pools, tensions, dreams, letters, journal,
        // deltas, witness, soma_arc, open loops/questions, handoffs) -- empty by default.
        return makeStmt(sql, () => [], runs);
      },
    },
  };
  return { env: env as never, preparedSql, runs };
}

describe("mindOrient -- active_conclusions ordered by heat, warmed on surface (task 19)", () => {
  it("orders both conclusion SELECT sites by effective heat instead of created_at", async () => {
    const { env, preparedSql } = makeOrientEnv();
    await mindOrient(env, "cypher");

    const beliefTypeSql = preparedSql.filter(sql => sql.includes("FROM companion_conclusions") && sql.includes("belief_type = ?"));
    expect(beliefTypeSql.length).toBe(4); // self/relational/observational/systemic
    for (const sql of beliefTypeSql) {
      expect(sql).toContain(effectiveHeatSql());
      expect(sql).not.toMatch(/ORDER BY created_at DESC/);
    }

    const flaggedSql = preparedSql.find(sql => sql.includes("FROM companion_conclusions") && sql.includes("contradiction_flagged = 1"));
    expect(flaggedSql).toBeDefined();
    expect(flaggedSql).toContain(effectiveHeatSql());
    expect(flaggedSql).not.toMatch(/ORDER BY created_at DESC/);
  });

  it("scopes the recent-journal (SUBSTANTIVE lane) SELECT to archived = 0", async () => {
    const { env, preparedSql } = makeOrientEnv();
    await mindOrient(env, "cypher");
    const journalSql = preparedSql.find(sql => sql.includes("FROM companion_journal"));
    expect(journalSql).toBeDefined();
    expect(journalSql).toContain("archived = 0");
  });

  it("warms every surfaced conclusion id (type-distributed + flagged, deduped) and nothing else", async () => {
    const { env, runs } = makeOrientEnv();
    const result = await mindOrient(env, "cypher");

    expect(result.active_conclusions.map(c => c.id).sort()).toEqual(["c-rel-1", "c-self-1"]);
    expect(result.flagged_beliefs.map(c => c.id)).toEqual(["c-flag-1"]);

    const warmRuns = runs.filter(r => r.sql.includes("UPDATE companion_conclusions"));
    expect(warmRuns).toHaveLength(1);
    expect(warmRuns[0]!.sql).toContain("SET heat = MIN(");
    expect(warmRuns[0]!.sql).toContain("last_access_at = datetime('now')");
    expect(new Set(warmRuns[0]!.args)).toEqual(new Set(["c-self-1", "c-rel-1", "c-flag-1"]));
  });

  it("never fires the conclusion warm when nothing is surfaced", async () => {
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    // Override: no conclusions at all this time (everything, including the identity
    // anchor lookup, returns empty rows).
    const emptyEnv = {
      SYSTEM_OWNER: "raziel",
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("FROM wm_identity_anchor_snapshot")) {
            return makeStmt(sql, () => [{ agent_id: "cypher", anchor_text: "x" }], runs);
          }
          return makeStmt(sql, () => [], runs);
        },
      },
    };
    const result = await mindOrient(emptyEnv as never, "cypher");
    expect(result.active_conclusions).toEqual([]);
    expect(result.flagged_beliefs).toEqual([]);
    expect(runs.some(r => r.sql.includes("UPDATE companion_conclusions"))).toBe(false);
  });
});

// --- orient: graph salience nudges conclusion ranking, PER READER (Phase 1.5, Tranche 2) ---
//
// Three "observational" candidates, over-fetched together (PER_TYPE_LIMIT=2 x
// CONCLUSION_OVER_FETCH=3 headroom): by raw effective heat alone the order is
// obs-a (0.50) > obs-c (0.47) > obs-b (0.45), so the un-multiplied top-2 is [obs-a, obs-c] and
// obs-b is cut. Five graph_edges rows all touch (companions, "cypher") on one endpoint and
// companion_conclusions/obs-b on the other -- reader-relevant for cypher (hub match), giving
// obs-b degree 5 -> connectivityMultiplier(5) ~= 1.269 -> graph score 0.45 * 1.269 ~= 0.571,
// which now outranks obs-a (0.50) and obs-c (0.47). The top-2 flips to [obs-b, obs-a] and obs-c
// is the one cut instead -- a real membership change, not just an internal re-sort.
//
// For a DIFFERENT reader (gaia), none of those edges are writer-matched or hub-matched (they
// touch "cypher"'s hub node, not "gaia"'s), so degree stays 0 for every candidate and the
// original un-multiplied order [obs-a, obs-c] survives untouched. Same edge table, same rows,
// different reader, different gravity -- exactly the "bank, not a mind" clause in the spec.
describe("mindOrient -- graph salience nudges conclusion ranking per reader (Phase 1.5, Tranche 2)", () => {
  const observationalRows = [
    conclusionRow("obs-a", "observational", 0.50),
    conclusionRow("obs-b", "observational", 0.45),
    conclusionRow("obs-c", "observational", 0.47),
  ];

  const graphEdges: FakeEdgeRow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `edge-${i}`,
    src_table: "companions",
    src_id: "cypher",
    dst_table: "companion_conclusions",
    dst_id: "obs-b",
    edge_type: "holds_tension",
    writer: "cypher",
    created_at: "2026-08-01T00:00:00Z",
  }));

  it("BEFORE (no graph signal): un-multiplied effective-heat order keeps obs-a + obs-c, cuts obs-b", async () => {
    const { env } = makeOrientEnv({ observationalRows }); // no graphEdges -> degree 0 everywhere
    const result = await mindOrient(env, "cypher");
    const observationalIds = result.active_conclusions
      .filter(c => c.belief_type === "observational")
      .map(c => c.id)
      .sort();
    expect(observationalIds).toEqual(["obs-a", "obs-c"]);
  });

  it("AFTER (graph signal present): connectivity flips the top-2 to obs-b + obs-a, cutting obs-c, for the reader the edges belong to (cypher)", async () => {
    const { env } = makeOrientEnv({ observationalRows, graphEdges });
    const result = await mindOrient(env, "cypher");
    const observationalIds = result.active_conclusions
      .filter(c => c.belief_type === "observational")
      .map(c => c.id)
      .sort();
    expect(observationalIds).toEqual(["obs-a", "obs-b"]);
  });

  it("PER-READER GRAVITY: the same edges are inert for a different reader (gaia) -- order stays un-multiplied", async () => {
    const { env } = makeOrientEnv({ observationalRows, graphEdges });
    const result = await mindOrient(env, "gaia");
    const observationalIds = result.active_conclusions
      .filter(c => c.belief_type === "observational")
      .map(c => c.id)
      .sort();
    expect(observationalIds).toEqual(["obs-a", "obs-c"]);
  });
});

// --- orient: active_conversations (Task 4, thread spine mig 0106) -----------------

describe("mindOrient -- active_conversations (task 4, thread spine)", () => {
  it("includes active_conversations with seed_gist when a row is returned", async () => {
    const convoRow = {
      id: "conv-1", channel_id: "chan-1", seed_author: "raziel",
      seed_gist: "what if we tried the sync differently", state: "open",
      ref_label: null, turn_count: 3, last_turn_at: "2026-07-20T00:00:00Z",
    };
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      SYSTEM_OWNER: "raziel",
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("FROM wm_identity_anchor_snapshot")) {
            return makeStmt(sql, () => [{ agent_id: "cypher", anchor_text: "x" }], runs);
          }
          if (sql.includes("FROM conversation_threads")) {
            return makeStmt(sql, () => [convoRow], runs);
          }
          return makeStmt(sql, () => [], runs);
        },
      },
    };
    const result = await mindOrient(env as never, "cypher");
    expect(result.active_conversations).toEqual([convoRow]);
  });

  it("scopes the conversation_threads SELECT to open/moving state, ordered by last_turn_at, capped at 3", async () => {
    const { env, preparedSql } = makeOrientEnv();
    await mindOrient(env, "cypher");
    const convoSql = preparedSql.find(sql => sql.includes("FROM conversation_threads"));
    expect(convoSql).toBeDefined();
    expect(convoSql).toContain("state IN ('open','moving')");
    expect(convoSql).toContain("ORDER BY last_turn_at DESC");
    expect(convoSql).toContain("LIMIT 3");
    expect(convoSql).toContain("substr(seed_text, 1, 140) AS seed_gist");
  });

  it("defaults to an empty array when no active threads exist", async () => {
    const { env } = makeOrientEnv();
    const result = await mindOrient(env, "cypher");
    expect(result.active_conversations).toEqual([]);
  });
});
