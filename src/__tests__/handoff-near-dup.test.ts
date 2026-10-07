// Handoff triplication + self-repeat (2026-10-07).
//
// Drevan's Claude.ai orient showed three near-identical "Raziel is mid-tournament" handoffs, and the
// newest repeated its own opening inside itself. Two causes:
//   1. the session-close auto-write tagged every wm handoff source='session_close', including the bots'
//      ~2h idle consolidations, and nothing deduped wm_session_handoffs, so three re-narrations of one
//      idle stretch filled all three orient slots;
//   2. title = spine.slice(0,120) and summary = spine + "Last real thing", rendered `title: summary`,
//      so the first 120 chars of every spine printed twice.
// Texts below are synthetic stand-ins shaped like the prod rows (paraphrased re-narrations of one
// state), never the stored text.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  handoffSimilarity, isNearDuplicate, collapseNearDuplicateHandoffs, writeHandoff, handoffFetchLimit,
  NEAR_DUP_JACCARD,
} from "../webmind/handoffs.js";
import { handoffText, buildContinuityBlock } from "../librarian/response/builder.js";
import type { Env } from "../types.js";
import type { WmSessionHandoff } from "../webmind/types.js";

const src = (p: string) => readFile(resolve(__dirname, "..", p), "utf8");

const A = "Quiet lane while the chess tournament runs. He is mid-tournament, round four tonight, checking in between games; I held the porch light and kept the thread on the knight sacrifice he liked.";
const B = "The lane stayed quiet: he is still mid-tournament, round four tonight, checking in between games. I kept the porch light on and the knight sacrifice thread warm.";
const C = "Mid-tournament still, round four tonight; he checks in between games. Quiet lane. Porch light held, the knight sacrifice thread kept close.";
const UNRELATED = "We rebuilt the garden bed plan, argued about tomatoes versus peppers, and settled on a trellis by the fence before he went to sleep.";

let seq = 0;
function row(source: string, summary: string, over: Partial<WmSessionHandoff> = {}): WmSessionHandoff {
  seq++;
  return {
    handoff_id: `h${seq}`, agent_id: "drevan", thread_id: null, title: summary.slice(0, 120), summary,
    next_steps: null, open_loops: null, state_hint: "at_rest", facet: null, actor: "agent", source,
    correlation_id: null, created_at: new Date(Date.UTC(2026, 9, 7, 12, 0) - seq * 60_000).toISOString(),
    ...over,
  };
}

describe("handoff similarity", () => {
  it("re-narrations of one state are near-duplicates; an unrelated handoff is not", () => {
    expect(isNearDuplicate({ summary: A }, { summary: B })).toBe(true);
    expect(isNearDuplicate({ summary: B }, { summary: C })).toBe(true);
    expect(isNearDuplicate({ summary: A }, { summary: C })).toBe(true);
    expect(isNearDuplicate({ summary: A }, { summary: UNRELATED })).toBe(false);
    expect(handoffSimilarity(A, UNRELATED).jaccard).toBeLessThan(NEAR_DUP_JACCARD / 2);
  });

  it("empty-ish bodies only match exactly", () => {
    expect(isNearDuplicate({ summary: "..." }, { summary: "..." })).toBe(true);
    expect(isNearDuplicate({ summary: "..." }, { summary: "!!" })).toBe(false);
  });
});

describe("collapseNearDuplicateHandoffs (read time)", () => {
  it("three consolidations re-narrating one state collapse to the newest", () => {
    const rows = [row("consolidation", C), row("consolidation", B), row("consolidation", A)];
    const out = collapseNearDuplicateHandoffs(rows, 3);
    expect(out.map(r => r.handoff_id)).toEqual([rows[0]!.handoff_id]);
  });

  it("frees the slots for distinct handoffs further back", () => {
    const rows = [row("consolidation", C), row("consolidation", B), row("consolidation", A), row("session_close", UNRELATED)];
    expect(collapseNearDuplicateHandoffs(rows, 3).map(r => r.summary)).toEqual([C, UNRELATED]);
  });

  it("NEVER drops an authored close; a near-duplicate machine row yields to it", () => {
    const machine = row("consolidation", B);
    const authored = row("session_close", A);
    const out = collapseNearDuplicateHandoffs([machine, authored], 3);
    expect(out.map(r => r.handoff_id)).toEqual([authored.handoff_id]);
  });

  it("only the newest consolidation is in view by default; older distinct ones give way to authored closes", () => {
    const AUTHORED = "Talked through the move to the new apartment, the boxes in the hallway, and which week the lease starts.";
    const rows = [row("consolidation", C), row("consolidation", UNRELATED), row("session_close", AUTHORED), row("distillation", "Distilled: a slow Sunday, coffee, a long walk by the river.")];
    const out = collapseNearDuplicateHandoffs(rows, 3);
    expect(out.map(r => r.source)).toEqual(["consolidation", "session_close", "distillation"]);
    expect(out[0]!.summary).toBe(C);
    // A caller may widen the machine allowance (ground passes 2).
    expect(collapseNearDuplicateHandoffs(rows, 5, 2).filter(r => r.source === "consolidation")).toHaveLength(2);
  });

  it("two authored closes are both kept even when they read alike", () => {
    const out = collapseNearDuplicateHandoffs([row("session_close", A), row("session_close", B)], 3);
    expect(out).toHaveLength(2);
  });

  it("shutdown boilerplate is dropped when anything else exists, kept once when it is all there is", () => {
    const sd = "[auto] bot shutdown -- process received a stop signal";
    const withOthers = collapseNearDuplicateHandoffs([row("shutdown", sd), row("session_close", UNRELATED)], 3);
    expect(withOthers.map(r => r.source)).toEqual(["session_close"]);
    const only = collapseNearDuplicateHandoffs([row("shutdown", sd), row("shutdown", sd)], 3);
    expect(only).toHaveLength(1);
  });

  it("legacy rows tagged session_close are treated as authored (not collapsed)", () => {
    // Pre-fix consolidations carry source='session_close'; the invariant wins over tidiness. They age
    // out of the 30-row window in ~2 days.
    expect(collapseNearDuplicateHandoffs([row("session_close", C), row("session_close", B)], 3)).toHaveLength(2);
  });
});

// ── writeHandoff (write time) with a recording fake D1 ──────────────────────────

type Stmt = { sql: string; args: unknown[]; all: () => Promise<{ results: unknown[] }> };
function fakeEnv(prior: unknown[] | Error) {
  const batches: Stmt[][] = [];
  const lookups: Stmt[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]): Stmt {
            const s: Stmt = {
              sql, args,
              all: async () => {
                lookups.push(s);
                if (prior instanceof Error) throw prior;
                return { results: prior };
              },
            };
            return s;
          },
        };
      },
      async batch(stmts: Stmt[]) { batches.push(stmts); return []; },
    },
  } as unknown as Env;
  return { env, batches, lookups };
}

describe("writeHandoff supersedes machine near-duplicates", () => {
  it("a consolidation replaces a near-identical consolidation from the window", async () => {
    const { env, batches } = fakeEnv([{ handoff_id: "old1", title: A.slice(0, 120), summary: A, source: "consolidation" }]);
    const r = await writeHandoff(env, { agent_id: "drevan", title: B.slice(0, 120), summary: B, source: "consolidation" });
    const sqls = batches[0]!.map(s => s.sql.replace(/\s+/g, " "));
    expect(sqls[0]).toMatch(/INSERT INTO wm_session_handoffs/);
    const del = batches[0]!.find(s => /handoff_id IN \(\?\)/.test(s.sql));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/source IN \('consolidation', 'shutdown'\)/);
    expect(del!.args).toEqual(["drevan", "old1"]);
    expect(r.source).toBe("consolidation");
  });

  it("does not supersede an unrelated consolidation", async () => {
    const { env, batches } = fakeEnv([{ handoff_id: "old1", title: "x", summary: UNRELATED, source: "consolidation" }]);
    await writeHandoff(env, { agent_id: "drevan", title: "t", summary: A, source: "consolidation" });
    expect(batches[0]!.some(s => /handoff_id IN \(\?/.test(s.sql))).toBe(false);
  });

  it("an authored close never looks up or deletes anything but the cap", async () => {
    const { env, batches, lookups } = fakeEnv([{ handoff_id: "old1", title: "x", summary: A, source: "consolidation" }]);
    await writeHandoff(env, { agent_id: "drevan", title: "t", summary: A, source: "session_close" });
    expect(lookups).toHaveLength(0);
    expect(batches[0]).toHaveLength(2); // insert + cap
  });

  it("a failed lookup still lands the insert", async () => {
    const { env, batches } = fakeEnv(new Error("D1 hiccup"));
    await writeHandoff(env, { agent_id: "drevan", title: "t", summary: A, source: "consolidation" });
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.sql).toMatch(/INSERT INTO wm_session_handoffs/);
  });

  it("the cap protects the 10 newest authored rows from machine churn", async () => {
    const { env, batches } = fakeEnv([]);
    await writeHandoff(env, { agent_id: "gaia", title: "t", summary: "s", source: "consolidation" });
    const cap = batches[0]!.at(-1)!.sql.replace(/\s+/g, " ");
    expect(cap).toMatch(/LIMIT 30 \)/);
    expect(cap).toMatch(/source NOT IN \('consolidation', 'shutdown'\) ORDER BY created_at DESC LIMIT 10/);
  });
});

// ── provenance + readers + render ───────────────────────────────────────────────

describe("session close forwards close_kind into the wm handoff source", () => {
  it("allowlisted close_kind becomes source; anything else stays session_close", async () => {
    const exec = await src("librarian/executors/session.ts");
    const fn = exec.slice(exec.indexOf("export async function execSessionClose("));
    expect(fn).toMatch(/const handoffSource = p\.close_kind && \(CALLER_CLOSE_KINDS as readonly string\[\]\)\.includes\(p\.close_kind\)\s*\?\s*p\.close_kind\s*:\s*"session_close";/);
    expect(fn).toMatch(/source: handoffSource,/);
    expect(fn).not.toMatch(/source: "session_close" as const/);
  });
});

describe("orient and ground over-fetch and collapse", () => {
  it("both readers collapse instead of taking the raw newest rows", async () => {
    const orient = await src("webmind/orient.ts");
    expect(orient).toMatch(/FROM wm_session_handoffs WHERE agent_id = \? ORDER BY created_at DESC LIMIT \?"\s*\)\.bind\(agentId, handoffFetchLimit\(3\)\)/);
    expect(orient).toMatch(/collapseNearDuplicateHandoffs\(recentHandoffs\.results \?\? \[\], 3\)/);
    expect(orient).not.toMatch(/recentHandoffs\.results\?\.\[0\]/);
    const ground = await src("webmind/ground.ts");
    expect(ground).toMatch(/handoffFetchLimit\(5\)/);
    expect(ground).toMatch(/collapseNearDuplicateHandoffs\(handoffs\.results \?\? \[\], 5, 2\)/);
    expect(handoffFetchLimit(3)).toBe(30);
  });
});

describe("handoff render does not repeat the spine", () => {
  const spine = "Raziel is mid-tournament and checking in between rounds; the lane is quiet and I am holding the porch light for when he is back tonight.";
  const legacy = { title: spine.slice(0, 120), summary: `${spine}\n\nLast real thing: he said round four starts at seven.` };

  it("a title that prefixes the summary renders once", () => {
    const out = handoffText(legacy);
    expect(out).toBe(legacy.summary);
    expect(out.split("mid-tournament").length - 1).toBe(1);
  });

  it("a genuinely separate title still prefixes", () => {
    expect(handoffText({ title: "Garden", summary: UNRELATED })).toBe(`Garden: ${UNRELATED}`);
    expect(handoffText({ title: "", summary: "s" })).toBe("s");
  });

  it("a legacy consolidation whose 'Last real thing' is its own final sentence renders it once", () => {
    const body = "Quiet lane tonight. He is mid-tournament between rounds. Porch light held until he is back.";
    const out = handoffText({ title: body.slice(0, 40), summary: `${body}\n\nLast real thing: Porch light held until he is back.` });
    expect(out).toBe(body);
  });

  it("a distinct 'Last real thing' is kept", () => {
    const s = `${UNRELATED}\n\nLast real thing: he laughed at the tomato joke.`;
    expect(handoffText({ title: "", summary: s })).toBe(s);
  });

  it("the close auto-write skips a last_real_thing the spine already contains", async () => {
    const exec = await src("librarian/executors/session.ts");
    expect(exec).toMatch(/const handoffSummary = p\.last_real_thing && !textContains\(p\.spine, p\.last_real_thing\)/);
  });

  it("buildContinuityBlock prints each spine once", () => {
    const wm = {
      latest_handoff: { ...row("consolidation", legacy.summary), title: legacy.title },
      recent_handoffs: [{ ...row("consolidation", legacy.summary), title: legacy.title }, { ...row("session_close", UNRELATED), title: "Garden" }],
      recent_notes: [], open_thread_count: 0, top_threads: [],
    } as never;
    const block = buildContinuityBlock(wm, "drevan");
    expect(block.split("mid-tournament").length - 1).toBe(1);
    expect(block).toContain("Garden: ");
  });
});
