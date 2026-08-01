// src/__tests__/mind-loader-degradation.test.ts
//
// loadMindState must NEVER abort a boot, and must say so when it degrades.
//
// This is a regression test for a bug introduced by the execBotOrient cutover (2026-08-01) and caught by the
// existing fixtures rather than by prod. The old bot orient ran 33 sources under `Promise.allSettled` -- any one
// could fail and orient still returned. loadMindState used `Promise.all`, so once the bots read through it, a
// single throw from `mindOrient` (which calls seedIdentityAnchor, which throws by design on an empty read-back)
// took out the entire boot. Because loadMindState is now the boot path for EVERY loom, a fail-closed loader is
// the whole house going dark at once.
//
// The second half matters as much as the first. `allSettled` on its own would trade a loud failure for a silent
// one, and "soft-failing thing looks healthy" has cost this project three separate debugging sessions -- wave 4
// shipped a world block that returned entirely empty and read as a quiet house. So a degraded load must NAME
// what failed in `meta.degraded`: an empty block and an unavailable block are different facts.

import { describe, it, expect, vi } from "vitest";

vi.mock("../webmind/orient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webmind/orient.js")>();
  return { ...actual, mindOrient: vi.fn(async () => { throw new Error("seedIdentityAnchor: failed to read back anchor"); }) };
});
vi.mock("../webmind/ground.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webmind/ground.js")>();
  return { ...actual, mindGround: vi.fn(async () => { throw new Error("D1 unavailable"); }) };
});

import { loadMindState } from "../mind/loader.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import type { Env } from "../types.js";

/** Every query resolves empty. The point is that BOTH aggregators throw, not that the DB is interesting. */
function makeEnv(): Env {
  const stmt: Record<string, unknown> = {};
  stmt.bind = () => stmt;
  stmt.all = async () => ({ results: [] });
  stmt.first = async () => null;
  stmt.run = async () => ({ meta: { changes: 0 } });
  return { DB: { prepare: () => stmt }, SYSTEM_OWNER: "Raziel" } as unknown as Env;
}

describe("loadMindState -- degrades, never aborts (cutover regression, 2026-08-01)", () => {
  it("resolves a well-formed MindState even when BOTH aggregators throw", async () => {
    const ms = await loadMindState(makeEnv(), "cypher", "discord");

    expect(ms.contract_version).toBe(MINDSTATE_CONTRACT_VERSION);
    expect(ms.companion_id).toBe("cypher");
    expect(ms.loom).toBe("discord");
    // Every block present and traversable -- a consumer must not have to null-check the contract itself.
    expect(ms.identity.anchor).toBeNull();
    expect(ms.continuity.recent_handoffs).toEqual([]);
    expect(ms.continuity.open_thread_count).toBe(0);
    expect(ms.carried.tensions).toEqual([]);
    expect(ms.beliefs.conclusions).toEqual([]);
    expect(ms.relational.journal_recent).toEqual([]);
    expect(ms.world.watching).toEqual([]);
    expect(ms.oversight.pressure_flags).toEqual([]);
  });

  it("NAMES both failures in meta.degraded rather than passing for a quiet house", async () => {
    const ms = await loadMindState(makeEnv(), "cypher", "discord");

    expect(ms.meta.degraded).toContain("orient");
    expect(ms.meta.degraded).toContain("ground");
    // degraded and not_yet_loaded answer different questions and must not be conflated: "it broke just now"
    // vs "this version does not implement it yet".
    expect(ms.meta.not_yet_loaded).toEqual([]);
  });

  it("still knows what time it is -- temporal grounding has no acceptable empty", async () => {
    const ms = await loadMindState(makeEnv(), "cypher", "discord");

    // A companion that does not know when it is will reason about "recently" from whatever it last saw,
    // which is the stale-Fargo failure in a different costume.
    expect(ms.meta.datetime_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isFinite(Date.parse(ms.meta.datetime_iso))).toBe(true);
    expect(ms.meta.datetime_local).toBeTruthy();
  });

  it("siblings are still NAMED when relational data is unavailable", async () => {
    // Who the siblings ARE is structural, not data. An empty array would read as "this companion has no
    // siblings", which is never true of the triad.
    const ms = await loadMindState(makeEnv(), "cypher", "discord");

    expect(ms.relational.siblings.map(s => s.companion_id).sort()).toEqual(["drevan", "gaia"]);
    expect(ms.relational.siblings.every(s => s.lane_spine === null)).toBe(true);
  });
});
