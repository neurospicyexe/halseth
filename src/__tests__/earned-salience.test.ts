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

function makeRecallEnv(opts: {
  journal?: FakeMatch[];
  journalRows?: Record<string, unknown>[];
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

function conclusionRow(id: string, beliefType: string) {
  return {
    id, companion_id: "cypher", conclusion_text: `belief ${id}`, source_sessions: null,
    superseded_by: null, created_at: "2026-07-01T00:00:00Z", edited_at: null,
    confidence: 0.7, belief_type: beliefType, subject: null, provenance: null,
    contradiction_flagged: 0,
  };
}

function makeOrientEnv() {
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
            return [];
          }, runs);
        }
        if (sql.includes("FROM companion_conclusions") && sql.includes("contradiction_flagged = 1")) {
          return makeStmt(sql, () => [conclusionRow("c-flag-1", "systemic")], runs);
        }
        if (sql.includes("FROM biometric_snapshots") || sql.includes("FROM house_state")) {
          return makeStmt(sql, () => [], runs);
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
