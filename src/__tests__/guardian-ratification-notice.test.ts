/**
 * Ratification-backlog notice wording (2026-09-13).
 *
 * The notice used to say the "hybrid flow should be draining these nightly". The clearing pass
 * runs Sun + Wed and SHORTLISTS real growth for Raziel on purpose, so the pile it leaves is the
 * healthy output of the machine, not a stall -- and Gaia's witness repeated the false alarm
 * nightly for a week. The notice must name what is true (waiting on a person, how old) and must
 * not claim a nightly drain exists.
 */
import { describe, it, expect } from "vitest";
import { detectRatificationBacklog } from "../guardian/detectors.js";
import type { Env } from "../types.js";

function fakeEnv(rows: Array<{ companion_id: string; n: number; oldest: string | null }>): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
    },
  } as unknown as Env;
}

describe("detectRatificationBacklog notice", () => {
  it("says the pile waits on Raziel and how old it is; never claims a nightly drain", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const flags = await detectRatificationBacklog(fakeEnv([{ companion_id: "cypher", n: 9, oldest: tenDaysAgo }]));
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.summary).toContain("waiting on Raziel's review");
    expect(f.summary).toMatch(/oldest (9|10)d/);
    expect(f.summary).toContain("clearing pass");
    expect(f.summary).not.toMatch(/nightly/);
    expect(f.summary).not.toMatch(/hybrid flow/);
    expect(f.evidence).toMatchObject({ pending: 9, oldest: tenDaysAgo });
    expect(f.dedup_key).toBe("ratification:cypher");
  });

  it("omits the age when the oldest stamp is missing, and drops unknown companions", async () => {
    const flags = await detectRatificationBacklog(fakeEnv([
      { companion_id: "gaia", n: 12, oldest: null },
      { companion_id: "steward", n: 40, oldest: null },
    ]));
    expect(flags.map(f => f.companion_id)).toEqual(["gaia"]);
    expect(flags[0]!.summary).not.toMatch(/oldest/);
    expect(flags[0]!.evidence).toMatchObject({ oldest_days: null });
  });
});
