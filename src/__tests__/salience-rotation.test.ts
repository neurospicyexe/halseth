// Discrimination fix (2026-07-26) -- the load-bearing finding of the organ census.
//
// MEASURED IN PROD, cypher's orient-eligible live notes (archived=0, salience=high,
// note_type not soma_arc/spiral_turn), 121 rows:
//     38 notes at heat 5.0  (HEAT_MAX -- saturated, all accessed)
//      1 note  at heat 1.2
//     82 notes at heat 1.0  (NEVER surfaced, not once)
//
// Two compounding defects made the foreground frozen:
//
// 1. LOCKOUT. Core = top 3 by effective heat; "Novelty" = rank 6 of THE SAME ordering.
//    Both therefore draw from the saturated 38. An unaccessed note's ceiling is
//    1.0 + 0.5 coherence bonus = 1.5 (and the bonus is gone in 4h), which can never beat
//    5.0. Those 82 notes were unreachable except via the edge pool's one random draw per
//    boot, itself restricted to notes older than 30 days. The pool named "Novelty" was
//    returning the sixth-warmest note.
//
// 2. SELF-CONFIRMING WARM. Orient warms whatever it surfaced, which resets last_access_at,
//    which zeroes the decay term, so the winners keep winning. The system's own display
//    choice became the evidence for repeating that choice -- a positive feedback loop with
//    no negative term. Being SHOWN something is not the same as REACHING FOR it.
//
// Fixes: the novelty pool draws from the cold end (never-accessed first), and orient's
// surface bump is smaller than the deliberate-recall bump, so reached-for outranks shown.

import { describe, it, expect, vi } from "vitest";
import { warmSql, HEAT_BUMP, SURFACE_BUMP } from "../webmind/heat.js";

vi.mock("../webmind/relational.js", () => ({ readRelationalSnapshot: vi.fn(async () => null) }));
vi.mock("../webmind/limbic.js", () => ({
  getCurrentLimbicState: vi.fn(async () => null),
  writeLimbicState: vi.fn(async () => undefined),
}));
vi.mock("../webmind/spiral.js", () => ({ readRecentSpiralTurn: vi.fn(async () => null) }));
vi.mock("../webmind/home/store.js", () => ({ takeUnsurfacedEvents: vi.fn(async () => []) }));

import { mindOrient } from "../webmind/orient.js";

describe("heat bumps distinguish shown from reached-for", () => {
  it("surfacing counts for strictly less than deliberate recall", () => {
    expect(SURFACE_BUMP).toBeGreaterThan(0);
    expect(SURFACE_BUMP).toBeLessThan(HEAT_BUMP);
  });

  it("warmSql emits whichever bump it is handed", () => {
    expect(warmSql("wm_continuity_notes", "note_id", 1, SURFACE_BUMP)).toContain(`heat + ${SURFACE_BUMP}`);
    expect(warmSql("wm_continuity_notes", "note_id", 1)).toContain(`heat + ${HEAT_BUMP}`);
  });
});

function makeOrientEnv() {
  const prepared: string[] = [];
  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare: (sql: string) => {
        prepared.push(sql);
        const rows = sql.includes("FROM wm_identity_anchor_snapshot")
          ? [{ agent_id: "cypher", anchor_text: "cypher: blade" }]
          : [];
        const mk = (args: unknown[]) => ({
          bind: (...a: unknown[]) => mk(a),
          all: async () => ({ results: rows }),
          first: async () => rows[0] ?? null,
          run: async () => ({ meta: { changes: 1 } }),
        });
        return mk([]);
      },
    },
  };
  return { env: env as never, prepared };
}

const noteQueries = (prepared: string[]) =>
  prepared.filter(s => /FROM wm_continuity_notes/i.test(s) && /salience = 'high'/i.test(s));

describe("the novelty pool actually surfaces novel material", () => {
  it("no longer selects by OFFSET into the same heat ordering", async () => {
    const { env, prepared } = makeOrientEnv();
    await mindOrient(env, "cypher");
    expect(noteQueries(prepared).some(s => /OFFSET\s+5/i.test(s))).toBe(false);
  });

  it("draws the coldest / never-accessed notes first", async () => {
    const { env, prepared } = makeOrientEnv();
    await mindOrient(env, "cypher");
    const novelty = noteQueries(prepared).find(s => /ORDER BY\s*\(last_access_at IS NOT NULL\)/i.test(s));
    expect(novelty).toBeDefined();
    // NULLs (never accessed) sort first, then least-recently-accessed.
    expect(novelty!).toMatch(/last_access_at ASC/i);
    // And it must NOT be a heat ordering, or it is the old pool wearing a new name.
    expect(novelty!).not.toContain("julianday");
  });

  it("keeps a core pool that is still ranked by earned heat", async () => {
    const { env, prepared } = makeOrientEnv();
    await mindOrient(env, "cypher");
    const core = noteQueries(prepared).find(s => /LIMIT 3/i.test(s));
    expect(core).toBeDefined();
    expect(core!).toContain("julianday");
  });

  it("keeps the random deep-history edge pool", async () => {
    const { env, prepared } = makeOrientEnv();
    await mindOrient(env, "cypher");
    expect(noteQueries(prepared).some(s => /ORDER BY RANDOM\(\)/i.test(s))).toBe(true);
  });
});
