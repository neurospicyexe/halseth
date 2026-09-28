// A med_reminder DM "taken" counts as confirming meds, the same as the Hearth routine check-off
// (Raziel, 2026-09-28: "it should accept both"). Both meds_missed (tier 2, care_hold) and
// esc_meds (tier 3, DMs Blue) read one signal, meds_logged_age_hours, so the fix lives there.

import { describe, it, expect } from "vitest";
import { runCareTick, newestAge } from "../care/tick.js";

const NOW = Date.parse("2026-09-28T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function makeEnv(opts: { routineAt: string | null; dmAnswerAt: string | null | "throws" }) {
  const counters = { care: 0, esc: 0, medSql: "" };
  const firstFor = async (sql: string) => {
    if (sql.includes("FROM biometric_snapshots")) return null;
    if (sql.includes("FROM routines")) return { at: opts.routineAt };
    if (sql.includes("FROM med_answers")) {
      counters.medSql = sql;
      if (opts.dmAnswerAt === "throws") throw new Error("D1_ERROR: no such table: med_answers");
      return { at: opts.dmAnswerAt };
    }
    return null;
  };
  const runFor = async (sql: string) => {
    if (sql.includes("INSERT INTO care_actions")) { counters.care++; return { meta: { changes: 1 } }; }
    if (sql.includes("INSERT INTO care_escalations")) { counters.esc++; return { meta: { changes: 1 } }; }
    return { meta: { changes: 1 } };
  };
  const stmt = (sql: string) => ({
    first: () => firstFor(sql),
    all: async () => ({ results: [] }),
    run: () => runFor(sql),
  });
  const env = { DB: { prepare: (sql: string) => ({ ...stmt(sql), bind: () => stmt(sql) }) } };
  return { env: env as any, counters };
}

describe("newestAge", () => {
  it("takes the fresher age and keeps 'never' absent only when both are absent", () => {
    expect(newestAge(100, 2)).toBe(2);
    expect(newestAge(2, 100)).toBe(2);
    expect(newestAge(null, 5)).toBe(5);
    expect(newestAge(5, null)).toBe(5);
    expect(newestAge(null, null)).toBeNull();
    expect(newestAge(0, null)).toBe(0);
  });
});

describe("care tick: a DM 'taken' confirms meds", () => {
  it("control: a 100h-old routine and no DM answer fires meds_missed and esc_meds", async () => {
    const { env, counters } = makeEnv({ routineAt: hoursAgo(100), dmAnswerAt: null });
    await runCareTick(env, NOW, { force: true });
    expect(counters.care).toBeGreaterThan(0);
    expect(counters.esc).toBeGreaterThan(0);
  });

  it("a fresh DM answer suppresses both, even with the Hearth routine 100h stale", async () => {
    const { env, counters } = makeEnv({ routineAt: hoursAgo(100), dmAnswerAt: hoursAgo(2) });
    await runCareTick(env, NOW, { force: true });
    expect(counters.care).toBe(0);
    expect(counters.esc).toBe(0);
  });

  it("a DM answer alone counts when the routine was never logged", async () => {
    const { env, counters } = makeEnv({ routineAt: null, dmAnswerAt: hoursAgo(80) });
    await runCareTick(env, NOW, { force: true });
    // 80h since the last confirmation: the gap is real, and the DM row is what makes it visible.
    expect(counters.esc).toBeGreaterThan(0);
  });

  it("only daily slots count: the query joins med_schedule on weekday_mask 127", async () => {
    const { env, counters } = makeEnv({ routineAt: null, dmAnswerAt: null });
    await runCareTick(env, NOW, { force: true });
    expect(counters.medSql).toMatch(/JOIN med_schedule/);
    expect(counters.medSql).toMatch(/weekday_mask = 127/);
  });

  it("a failed med_answers read falls back to the routine and the tick still runs", async () => {
    const { env, counters } = makeEnv({ routineAt: hoursAgo(100), dmAnswerAt: "throws" });
    await expect(runCareTick(env, NOW, { force: true })).resolves.toBeDefined();
    expect(counters.esc).toBeGreaterThan(0);
  });
});
