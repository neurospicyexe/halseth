// HOLE 9 (found 2026-07-26 by the organ census, proven against prod).
//
// Motif resurrection (mig 0076) has never fired once in five weeks:
// `companion_motifs.last_surfaced_at` is NULL on all 1,173 rows, while 66 faded motifs
// sit at or above RESURRECT_TRUST_FLOOR with no cooldown blocking them.
//
// Root cause is the candidate window, not selectResurrections. execSessionOrient pulled
// BOTH pools with one statement:
//
//   WHERE companion_id = ? AND status IN ('active','faded')
//   ORDER BY trust DESC, recurrence_count DESC LIMIT 20
//
// Active motifs outnumber faded ~11:1 (1,074 vs 99) and saturate the trust ceiling, so
// in prod all 20 slots went to active rows for all three companions (trust at the cutoff
// = 0.95 = the best faded motif's trust). selectResurrections then received a list whose
// faded subset was ALWAYS empty and correctly returned nothing. The gate was never
// reached; resurrection was structurally impossible rather than merely rare.
//
// The fake below is a mini query engine over one fixture rather than a canned row list:
// it honours the status clause and the LIMIT the way D1 would, so the shared-window bug
// reproduces here exactly as it does in prod.

import { describe, it, expect, vi } from "vitest";

vi.mock("../librarian/backends/halseth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/halseth.js")>();
  return { ...actual, sessionOrient: vi.fn(async () => ({ session_id: "sess-1", state: null })) };
});
vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmOrient: vi.fn(async () => null) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execSessionOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

type MotifFixture = {
  id: string; companion_id: string; label: string; display: string;
  recurrence_count: number; trust: number; first_seen: string; last_seen: string;
  last_surfaced_at: string | null; status: string;
};

const motif = (id: string, status: string, trust: number): MotifFixture => ({
  id, companion_id: "cypher", label: id, display: id,
  recurrence_count: 9, trust,
  first_seen: "2026-01-01 00:00:00",
  last_seen: status === "faded" ? "2026-05-01 00:00:00" : "2026-07-25 00:00:00",
  last_surfaced_at: null, status,
});

// Mirrors prod: active rows saturate the trust ceiling and outnumber faded, so a shared
// top-20-by-trust window contains zero faded rows.
const ACTIVE = Array.from({ length: 25 }, (_, i) => motif(`active-${i}`, "active", 0.95));
const FADED_ELIGIBLE = [motif("faded-hot", "faded", 0.95), motif("faded-warm", "faded", 0.8)];
const ALL_MOTIFS = [...ACTIVE, ...FADED_ELIGIBLE];

/** Applies the status filter, trust ordering and LIMIT the way D1 would. */
function queryMotifs(sql: string): MotifFixture[] {
  let pool = ALL_MOTIFS;
  if (/status\s*=\s*'active'/.test(sql)) pool = pool.filter(m => m.status === "active");
  else if (/status\s*=\s*'faded'/.test(sql)) pool = pool.filter(m => m.status === "faded");
  else if (/status IN \('active','faded'\)/.test(sql)) pool = [...pool];

  const floor = /trust\s*>=\s*([0-9.]+)/.exec(sql);
  if (floor) pool = pool.filter(m => m.trust >= Number(floor[1]));

  const sorted = [...pool].sort((a, b) => b.trust - a.trust || b.recurrence_count - a.recurrence_count);
  const limit = /LIMIT\s+(\d+)/i.exec(sql);
  return limit ? sorted.slice(0, Number(limit[1])) : sorted;
}

function makeCtx(): { ctx: ExecutorContext; runs: Array<{ sql: string; args: unknown[] }> } {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const rowsFor = (sql: string) => (sql.includes("FROM companion_motifs") ? queryMotifs(sql) : []);
  const env = {
    DB: {
      prepare: (sql: string) => {
        const mk = (args: unknown[]) => ({
          bind: (...a: unknown[]) => mk(a),
          all: async () => ({ results: rowsFor(sql) }),
          first: async () => rowsFor(sql)[0] ?? null,
          run: async () => { runs.push({ sql, args }); return { meta: { changes: 1 } }; },
        });
        return mk([]);
      },
    },
  } as unknown as Env;

  const ctx = {
    env,
    req: { companion_id: "cypher", request: "orient" },
    entry: {} as never,
    frontState: null,
    pluralAvailable: false,
  } as ExecutorContext;

  return { ctx, runs };
}

describe("execSessionOrient -- motif resurrection survives a saturated active pool (HOLE 9)", () => {
  it("surfaces eligible faded motifs even when 25 active motifs tie at the trust ceiling", async () => {
    const { ctx } = makeCtx();
    const result = await execSessionOrient(ctx);
    expect(result.ready_prompt).toContain("Resurfacing (faded but trusted");
    expect(result.ready_prompt).toContain("faded-hot");
  });

  it("stamps last_surfaced_at on the resurrected motifs so the cooldown can engage", async () => {
    const { ctx, runs } = makeCtx();
    await execSessionOrient(ctx);
    const stamp = runs.find(r => /UPDATE companion_motifs SET last_surfaced_at/.test(r.sql));
    expect(stamp).toBeDefined();
    expect(stamp!.args).toContain("faded-hot");
  });

  it("still surfaces the active motif block -- the two pools do not displace each other", async () => {
    const { ctx } = makeCtx();
    const result = await execSessionOrient(ctx);
    expect(result.ready_prompt).toContain("Recurring threads in your recent work:");
    expect((result.meta as Record<string, unknown>).motifs_active).toBe(3);
    expect((result.meta as Record<string, unknown>).motifs_resurrected).toBe(2);
  });
});
