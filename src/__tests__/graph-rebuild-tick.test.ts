// The nightly graph-rebuild tick (src/graph/tick.ts). graph_edges (mig 0127) is a derived
// projection that used to only rebuild via the manual POST /admin/graph/rebuild door -- this tick
// rides the every-minute scheduled cron and self-gates to 24h, copying the exact gate mechanism
// runSaliencePrune uses (src/webmind/salience-prune.ts): read a companion_settings stamp, run only
// when it's absent or 24h+ stale, and write the stamp ONLY after a run actually completes.
//
// Two layers of proof:
//  (1) Gate -- blocks an unforced second run within the 24h window, force bypasses it, a stale
//      stamp re-arms the gate, and a thrown rebuild failure leaves the stamp unwritten (so a failed
//      attempt is retried next tick instead of being falsely gated for 24h -- the tick-restamp trap
//      this whole mechanism exists to avoid).
//  (2) Identity -- the stamp's (companion_id, key) pair is distinct from the salience prune's own,
//      so neither job can accidentally restamp the other's anchor.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runGraphRebuildTick,
  GRAPH_REBUILD_GATE_HOURS,
  GRAPH_REBUILD_GATE_COMPANION_ID,
  GRAPH_REBUILD_GATE_KEY,
} from "../graph/tick.js";
import { PRUNE_GATE_COMPANION_ID, PRUNE_GATE_KEY } from "../webmind/salience-prune.js";
import type { Env } from "../types.js";
import type { SourceCount } from "../graph/rebuild.js";

vi.mock("../graph/rebuild.js", () => ({
  rebuildGraph: vi.fn(),
}));

import { rebuildGraph } from "../graph/rebuild.js";

beforeEach(() => vi.clearAllMocks());

const SAMPLE_COUNTS: SourceCount[] = [
  { source: "companion_conclusions.superseded_by", inserted: 3 },
  { source: "relational_deltas.session_id", inserted: 12 },
];

/** Minimal fake D1: a single companion_settings row backing the gate check/stamp. */
function makeEnv(opts: { gateLastRunIso?: string | null } = {}) {
  const gateStampCalls: unknown[][] = [];
  let gateValue: string | null = opts.gateLastRunIso ?? null;

  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM companion_settings")) {
              return gateValue !== null ? { value: gateValue } : null;
            }
            return null;
          },
          run: async () => {
            if (sql.includes("INSERT INTO companion_settings")) {
              gateStampCalls.push(args);
              gateValue = args[2] as string;
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    },
  };
  return { env: env as unknown as Env, gateStampCalls, getGateValue: () => gateValue };
}

describe("runGraphRebuildTick -- 24h self-gate (the cron fires every minute, not daily)", () => {
  it("runs and stamps on a first (never-run-before) pass", async () => {
    vi.mocked(rebuildGraph).mockResolvedValueOnce(SAMPLE_COUNTS);
    const { env, gateStampCalls } = makeEnv();

    const result = await runGraphRebuildTick(env);

    expect(result.ran).toBe(true);
    expect(result.sources).toEqual(SAMPLE_COUNTS);
    expect(typeof result.ms).toBe("number");
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    expect(gateStampCalls).toHaveLength(1);
  });

  it("blocks an unforced second run within the 24h window -- rebuildGraph never re-fires", async () => {
    vi.mocked(rebuildGraph).mockResolvedValue(SAMPLE_COUNTS);
    const { env } = makeEnv();

    const first = await runGraphRebuildTick(env);
    expect(first.ran).toBe(true);

    const second = await runGraphRebuildTick(env);
    expect(second.ran).toBe(false);
    expect(second.sources).toBeUndefined();
    expect(rebuildGraph).toHaveBeenCalledTimes(1); // no second rebuild at all
  });

  it("does not block when the prior stamp is already 24h+ old", async () => {
    const staleIso = new Date(Date.now() - (GRAPH_REBUILD_GATE_HOURS + 1) * 60 * 60 * 1000).toISOString();
    vi.mocked(rebuildGraph).mockResolvedValueOnce(SAMPLE_COUNTS);
    const { env } = makeEnv({ gateLastRunIso: staleIso });

    const result = await runGraphRebuildTick(env);
    expect(result.ran).toBe(true);
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the gate even immediately after a run", async () => {
    vi.mocked(rebuildGraph).mockResolvedValue(SAMPLE_COUNTS);
    const { env } = makeEnv();

    const first = await runGraphRebuildTick(env);
    expect(first.ran).toBe(true);

    const forced = await runGraphRebuildTick(env, { force: true });
    expect(forced.ran).toBe(true);
    expect(rebuildGraph).toHaveBeenCalledTimes(2);
  });

  it("does not stamp (and does not rebuild) when gated out -- a blocked call performs no work at all", async () => {
    vi.mocked(rebuildGraph).mockResolvedValue(SAMPLE_COUNTS);
    const { env, gateStampCalls } = makeEnv();

    await runGraphRebuildTick(env);
    expect(gateStampCalls).toHaveLength(1); // the first, real run stamped once

    await runGraphRebuildTick(env); // gated -- must not rebuild, must not re-stamp
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    expect(gateStampCalls).toHaveLength(1);
  });

  it("a thrown rebuild failure leaves the gate unwritten -- retried next tick, never falsely gated", async () => {
    vi.mocked(rebuildGraph).mockRejectedValueOnce(new Error("D1 unavailable"));
    const { env, gateStampCalls } = makeEnv();

    await expect(runGraphRebuildTick(env)).rejects.toThrow("D1 unavailable");
    // The load-bearing claim: rebuildGraph's throw propagates BEFORE stampGraphRebuildGate ever
    // runs, so a failed attempt is never falsely gated for 24h. Assert the stamp write count
    // directly -- not just that it rejected -- so a future refactor that wraps the rebuild in a
    // try/catch (silently falling through to the stamp on failure) fails this test instead of
    // passing it.
    expect(gateStampCalls).toHaveLength(0);

    // And the retry actually proceeds: no stale gate was left behind by the failed attempt.
    vi.mocked(rebuildGraph).mockResolvedValueOnce(SAMPLE_COUNTS);
    const retried = await runGraphRebuildTick(env);
    expect(retried.ran).toBe(true);
  });

  it("still stamps a completed run that inserted nothing -- re-arms the 24h window", async () => {
    vi.mocked(rebuildGraph).mockResolvedValueOnce([]);
    const { env, gateStampCalls } = makeEnv();

    const result = await runGraphRebuildTick(env);
    expect(result.ran).toBe(true);
    expect(result.sources).toEqual([]);
    expect(gateStampCalls).toHaveLength(1); // ran (inserted nothing), still a completed run
  });
});

describe("runGraphRebuildTick -- gate identity (never shares an anchor with another job)", () => {
  it("the stamp's (companion_id, key) pair is distinct from the salience prune's own", () => {
    // Same sentinel companion_id (deliberately -- neither job is a real companion), but a
    // DIFFERENT key, so one job's stamp write can never satisfy or clobber the other's gate check.
    expect(GRAPH_REBUILD_GATE_COMPANION_ID).toBe(PRUNE_GATE_COMPANION_ID);
    expect(GRAPH_REBUILD_GATE_KEY).not.toBe(PRUNE_GATE_KEY);
  });

  it("writes the stamp keyed on exactly its own identity, into companion_settings", async () => {
    vi.mocked(rebuildGraph).mockResolvedValueOnce(SAMPLE_COUNTS);
    const { env, gateStampCalls } = makeEnv();

    await runGraphRebuildTick(env);

    expect(gateStampCalls).toHaveLength(1);
    expect(gateStampCalls[0]![0]).toBe(GRAPH_REBUILD_GATE_COMPANION_ID);
    expect(gateStampCalls[0]![1]).toBe(GRAPH_REBUILD_GATE_KEY);
  });
});
