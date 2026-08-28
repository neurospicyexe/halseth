// runScheduledWork (src/index.ts) is the every-minute cron's single entry point, with one rider
// per autonomic job (home tick, roster refresh, ferment tick, salience prune, stale-session sweep,
// SOMA refresh, narrative refresh, care tick, budget replenish, changelog announce, and now the
// graph-rebuild tick). Each rider is wrapped in its own try/catch specifically so ONE rider's
// failure can never take the others down -- this test proves that property for the newly added
// graph-rebuild rider: a throwing runGraphRebuildTick must not propagate out of runScheduledWork,
// and every sibling rider must still get called.
//
// No prior test exercised runScheduledWork directly (grep confirms this is the first), so every
// dependency the function imports is mocked here rather than mirroring an existing precedent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types.js";

// src/index.ts builds a Router at module load, and Router.on() constructs a real URLPattern per
// route (src/router.ts) -- a Cloudflare Workers / browser global the Node test runtime doesn't
// provide. This test never calls router.handle(), only runScheduledWork, so a construction-only
// stub is sufficient: it just needs to not throw when `new URLPattern({ pathname })` is called.
(globalThis as { URLPattern?: unknown }).URLPattern ??= class {
  constructor(_init: unknown) {}
  exec(_input: unknown) { return null; }
};

vi.mock("../synthesis/index.js", () => ({ processQueue: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../webmind/home/tick.js", () => ({ runHomeTick: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../roster/pk-roster.js", () => ({ runRosterRefresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../handlers/fermentation.js", () => ({
  runFermentTick: vi.fn().mockResolvedValue(undefined),
  tickFermentation: vi.fn(),
  postFermentStimulus: vi.fn(),
  getFermentation: vi.fn(),
}));
vi.mock("../webmind/salience-prune.js", () => ({
  runSaliencePrune: vi.fn().mockResolvedValue({ archived: 0 }),
  postSaliencePrune: vi.fn(),
}));
vi.mock("../graph/tick.js", () => ({ runGraphRebuildTick: vi.fn() }));
vi.mock("../webmind/stale-session-sweep.js", () => ({
  runStaleSessionSweep: vi.fn().mockResolvedValue(undefined),
  postStaleSessionSweep: vi.fn(),
}));
vi.mock("../synthesis/soma-refresh.js", () => ({
  runSomaRefresh: vi.fn().mockResolvedValue(undefined),
  postSomaRefresh: vi.fn(),
}));
vi.mock("../synthesis/narrative-refresh.js", () => ({
  runNarrativeRefresh: vi.fn().mockResolvedValue(undefined),
  postNarrativeRefresh: vi.fn(),
}));
vi.mock("../care/tick.js", () => ({ runCareTick: vi.fn().mockResolvedValue({ fired: 0 }) }));
vi.mock("../care/budget.js", () => ({ runBudgetReplenish: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../mind/changelog.js", () => ({ runChangelogAnnounce: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => vi.clearAllMocks());

describe("runScheduledWork -- one rider's failure never breaks the others", () => {
  it("a throwing graph-rebuild tick does not propagate out of runScheduledWork, and every sibling rider still runs", async () => {
    const { runScheduledWork } = await import("../index.js");
    const { runGraphRebuildTick } = await import("../graph/tick.js");
    const { runHomeTick } = await import("../webmind/home/tick.js");
    const { runCareTick } = await import("../care/tick.js");
    const { runChangelogAnnounce } = await import("../mind/changelog.js");
    const { processQueue } = await import("../synthesis/index.js");

    vi.mocked(runGraphRebuildTick).mockRejectedValueOnce(new Error("D1 unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const env = {} as Env;
    await expect(runScheduledWork(env)).resolves.toBeUndefined();

    expect(runGraphRebuildTick).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalledWith("graph rebuild tick failed", expect.any(Error));

    // Every sibling rider still ran despite the graph-rebuild rider throwing.
    expect(processQueue).toHaveBeenCalledTimes(1);
    expect(runHomeTick).toHaveBeenCalledTimes(1);
    expect(runCareTick).toHaveBeenCalledTimes(1);
    expect(runChangelogAnnounce).toHaveBeenCalledTimes(1);

    consoleErr.mockRestore();
  });
});
