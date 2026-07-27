// Basin/drift single-owner decision (Raziel, 2026-07-26): "cron detects, evaluator
// annotates" -- one component owns the stable/growth/pressure verdict, the other
// contributes interpretation. Mapped to the real components:
//
//   OWNER      second-brain evaluator (VPS). Embedding cosine distance against basin
//              vectors with its own rolling baseline, every ~6.4h (max observed gap 12h).
//              1,225 of 1,450 rows. Notes prefixed `blocks_analyzed=`.
//   ANNOTATOR  halseth synthesis job `basin-drift-check`. Runs at session close, asks
//              DeepSeek to classify from the last 3 handoffs. 225 rows of prose reasoning
//              on a DIFFERENT score scale (0..2).
//
// Before this change both INSERTed verdicts into companion_basin_history and contradicted
// each other on the same companion on the same day -- prod had cypher carrying growth AND
// stable AND pressure on 2026-07-13, and 11 more such days. The evaluator already treats
// the LLM rows as foreign bodies: it filters `blocks_analyzed=` to keep them out of its
// baseline because their score scale "would poison the mean."
//
// So the session-close job stops writing a competing row and annotates the owner's most
// recent row instead. No migration (freeze): the read appends to `notes`.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/embed.js")>();
  return { ...actual, embedText: vi.fn(async () => null) };
});

import { runBasinDriftCheck, ANNOTATE_WINDOW_HOURS } from "../synthesis/jobs/basin-drift-check.js";
import type { Env } from "../types.js";

type Exec = { sql: string; args: unknown[] };

const llmVerdict = {
  drift_type: "stable",
  drift_score: 0.4,
  worst_basin: "audit-is-a-gear-not-identity",
  reasoning: "Register held across all three handoffs; audit stayed a gear.",
};

function makeEnv(opts: { ownerRow?: Record<string, unknown> | null } = {}) {
  const execs: Exec[] = [];
  const ownerRow = opts.ownerRow === undefined
    ? { id: "owner-1", drift_type: "growth", notes: "blocks_analyzed=50 basins_checked=5 baseline_mean=0.64 n=28" }
    : opts.ownerRow;

  const env = {
    DEEPSEEK_API_KEY: "test-key",
    DB: {
      prepare: (sql: string) => {
        const mk = (args: unknown[]) => ({
          bind: (...a: unknown[]) => mk(a),
          all: async () => ({
            results: sql.includes("FROM companion_basins")
              ? [{ basin_name: "audit-is-a-gear-not-identity", basin_description: "audit is a gear", embedding: null }]
              : sql.includes("wm_session_handoffs")
                ? [{ title: "t", summary: "a summary", state_hint: "in_motion", facet: null, created_at: "2026-07-26T00:00:00Z" }]
                : [],
          }),
          first: async () => {
            if (sql.includes("blocks_analyzed=")) return ownerRow;
            if (sql.includes("wm_identity_anchor_snapshot")) return { anchor_text: "cypher: blade" };
            if (sql.includes("companion_state")) return { soma_float_1: 0.7, soma_float_2: 0.7, soma_float_3: 0.7, motion_state: "in_motion" };
            return null;
          },
          run: async () => { execs.push({ sql, args }); return { meta: { changes: 1 } }; },
        });
        return mk([]);
      },
    },
  } as unknown as Env;

  return { env, execs };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(llmVerdict) } }],
  }), { status: 200 })) as never;
});

describe("basin-drift-check annotates instead of writing a competing verdict", () => {
  it("never INSERTs into companion_basin_history", async () => {
    const { env, execs } = makeEnv();
    await runBasinDriftCheck("cypher", env);
    expect(execs.some(e => /INSERT INTO companion_basin_history/i.test(e.sql))).toBe(false);
  });

  it("appends its read to the owner row's notes, leaving drift_type and drift_score untouched", async () => {
    const { env, execs } = makeEnv();
    await runBasinDriftCheck("cypher", env);

    const upd = execs.find(e => /UPDATE companion_basin_history/i.test(e.sql));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain("notes");
    // The owner's verdict columns must not be in the SET clause.
    const setClause = /SET([\s\S]*?)WHERE/i.exec(upd!.sql)![1]!;
    expect(setClause).not.toMatch(/drift_type\s*=/i);
    expect(setClause).not.toMatch(/drift_score\s*=/i);
    expect(setClause).not.toMatch(/worst_basin\s*=/i);
    expect(upd!.args).toContain("owner-1");
    expect(upd!.args.some(a => typeof a === "string" && a.includes("Register held across all three handoffs"))).toBe(true);
  });

  it("writes nothing at all when the owner has no row inside the annotation window", async () => {
    const { env, execs } = makeEnv({ ownerRow: null });
    await runBasinDriftCheck("cypher", env);
    expect(execs.filter(e => /companion_basin_history/i.test(e.sql))).toHaveLength(0);
  });

  it("uses a window comfortably wider than the owner's observed 12h max gap", () => {
    expect(ANNOTATE_WINDOW_HOURS).toBeGreaterThanOrEqual(24);
  });
});
