// src/__tests__/bot-orient-salience.test.ts
//
// Discrimination fix, bot half (2026-07-27). The 2026-07-26 fix (novelty pool +
// SURFACE_BUMP) landed on mindOrient -- the Claude.ai / raw /mind/orient path, which runs
// a handful of times a day. execBotOrient is the HIGH-frequency path: every Discord bot
// boot, all day, three companions. It was therefore the actual saturation engine, and it
// was untouched. Classic fix-landed-on-a-different-writer: same table, different writer,
// symptom survives the real fix.
//
// What it did wrong:
//   - Candidate pool = wmGround's recent_notes, which is ORDER BY created_at DESC LIMIT 10.
//     A note sits in that window for about a day (cypher writes ~10/day).
//   - Picked the top 3 of that window by (salience high, then heat).
//   - Warmed those 3 at the FULL deliberate-recall bump (warmSql's default, 0.2).
// So whatever won the window during its one day hit HEAT_MAX and stayed pinned forever,
// and whatever lost was never touched by anything again. Prod at fix time, live notes
// (archived = 0): cypher 43 of 138 saturated / 93 never accessed; drevan 32/108 / 74;
// gaia 27/90 / 62. Same shape on all three.
//
// The fix reserves one of the three slots for a never-shown note drawn from the WHOLE
// live pool (ground's LIMIT 10 cannot supply one once all ten are warm), and drops the
// warm to SURFACE_BUMP. Being shown a note is not reaching for it -- the read must not
// write the ranking that chose it.

import { describe, it, expect, vi } from "vitest";
import { HEAT_BUMP, SURFACE_BUMP } from "../webmind/heat.js";

const GROUND_NOTES = [
  { note_id: "hot-1", content: "the saturated winner", heat: 5.0, salience: "high" },
  { note_id: "hot-2", content: "the second winner", heat: 5.0, salience: "high" },
  { note_id: "hot-3", content: "the third winner", heat: 4.8, salience: "high" },
  { note_id: "warm-4", content: "also in the window", heat: 1.2, salience: "high" },
];

// THE CANDIDATE POOL MOVED (cutover, 2026-08-01). execBotOrient no longer calls the librarian's `wmGround`
// for its note window -- it reads `MindState.continuity.recent_notes`, which loadMindState fills from
// `mindGround` (src/webmind/ground.ts). So the pool has to be mocked at its new source or these tests silently
// exercise an empty window and pass for the wrong reason. The BEHAVIOUR under test is unchanged: two slots by
// (high salience, then heat), one reserved for a never-shown note, all warmed at SURFACE_BUMP.
vi.mock("../webmind/ground.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webmind/ground.js")>();
  return { ...actual, mindGround: vi.fn(async () => ({ recent_notes: GROUND_NOTES })) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execBotOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

const NOVELTY_ROW = { note_id: "cold-99", content: "never shown to anyone, ever" };

function makeCtx(opts: { noveltyRow?: { note_id: string; content: string } | null } = {}) {
  const prepared: string[] = [];
  const warms: Array<{ sql: string; ids: unknown[] }> = [];

  const env = {
    DB: {
      prepare: (sql: string) => {
        prepared.push(sql);
        const isNoteWarm = /UPDATE wm_continuity_notes/.test(sql) && /heat/.test(sql);
        const isNovelty = /FROM wm_continuity_notes/.test(sql) && /last_access_at IS NOT NULL/.test(sql);
        let bound: unknown[] = [];
        const stmt = {
          bind: (...args: unknown[]) => { bound = args; return stmt; },
          all: async () => ({ results: [] }),
          first: async () => {
            if (isNovelty) return opts.noveltyRow === undefined ? NOVELTY_ROW : opts.noveltyRow;
            return null;
          },
          run: async () => {
            if (isNoteWarm) warms.push({ sql, ids: bound });
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
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

  return { ctx, prepared, warms };
}

const noteWarmSql = (warms: Array<{ sql: string; ids: unknown[] }>) =>
  warms.find(w => /UPDATE wm_continuity_notes/.test(w.sql));

describe("execBotOrient -- surfacing is not recall (2026-07-27)", () => {
  it("warms surfaced notes at SURFACE_BUMP, never the deliberate-recall bump", async () => {
    const { ctx, warms } = makeCtx();
    await execBotOrient(ctx);

    const warm = noteWarmSql(warms);
    expect(warm).toBeDefined();
    expect(warm!.sql).toContain(`heat + ${SURFACE_BUMP}`);
    // The whole point: the live presence's own display choice must stop counting as
    // evidence for repeating it at full strength.
    expect(warm!.sql).not.toContain(`heat + ${HEAT_BUMP}`);
  });

  it("SURFACE_BUMP is an order of magnitude below HEAT_BUMP (pins the ratio, not just the call)", () => {
    expect(SURFACE_BUMP).toBeGreaterThan(0);
    expect(SURFACE_BUMP * 5).toBeLessThan(HEAT_BUMP);
  });
});

describe("execBotOrient -- one slot reserved for a note never shown (2026-07-27)", () => {
  it("queries the whole live pool for a never-accessed note, not ground's recency window", async () => {
    const { ctx, prepared } = makeCtx();
    await execBotOrient(ctx);

    const novelty = prepared.find(s =>
      /FROM wm_continuity_notes/.test(s) && /ORDER BY\s*\(last_access_at IS NOT NULL\)/.test(s));
    expect(novelty).toBeDefined();
    // Never-accessed rows sort first, then least-recently-shown.
    expect(novelty!).toMatch(/last_access_at ASC/);
    // Must not be a heat ordering, or it is the frozen pool wearing a new name.
    expect(novelty!).not.toContain("julianday");
    // Must not inherit ground's recency ceiling -- that is what made the cold pool
    // unreachable in the first place.
    expect(novelty!).toContain("archived = 0");
  });

  it("the cold note actually reaches the prompt, alongside only TWO heat winners", async () => {
    const { ctx } = makeCtx();
    const result = (await execBotOrient(ctx) as { data?: { continuity_notes?: string[] } }).data ?? {};

    expect(result.continuity_notes).toEqual([
      "the saturated winner",
      "the second winner",
      "never shown to anyone, ever",
    ]);
    // hot-3 lost its slot to the cold note. That is the trade, stated explicitly.
    expect(result.continuity_notes).not.toContain("the third winner");
  });

  it("warms all three surfaced notes including the cold one -- rotation needs the stamp", async () => {
    const { ctx, warms } = makeCtx();
    await execBotOrient(ctx);

    const warm = noteWarmSql(warms);
    expect(warm!.ids).toEqual(["hot-1", "hot-2", "cold-99"]);
  });

  it("no cold note available (every note already shown): falls back to two, never crashes", async () => {
    const { ctx, warms } = makeCtx({ noveltyRow: null });
    const result = (await execBotOrient(ctx) as { data?: { continuity_notes?: string[] } }).data ?? {};

    expect(result.continuity_notes).toEqual(["the saturated winner", "the second winner"]);
    expect(noteWarmSql(warms)!.ids).toEqual(["hot-1", "hot-2"]);
  });

  it("the cold note is already a heat winner: not surfaced or warmed twice", async () => {
    const { ctx, warms } = makeCtx({ noveltyRow: { note_id: "hot-1", content: "the saturated winner" } });
    const result = (await execBotOrient(ctx) as { data?: { continuity_notes?: string[] } }).data ?? {};

    expect(result.continuity_notes).toEqual(["the saturated winner", "the second winner"]);
    expect(noteWarmSql(warms)!.ids).toEqual(["hot-1", "hot-2"]);
  });
});
