// The care-tick hourly gate as a CONDITIONAL CLAIM (reviewer, 2026-08-17).
//
// Two live drivers exist (the VPS kick-script and the CF scheduled handler), so the gate must
// admit exactly ONE caller per hour even when two runs overlap -- the old check-then-act SELECT
// let both through, double-inserting escalations and double-DMing a human. This test pins the
// claim semantics at the D1 boundary: same-instant claims, one winner.

import { describe, it, expect } from "vitest";
import { runCareTick } from "../care/tick.js";

/** Minimal fake D1: real claim semantics on companion_settings; empty reads everywhere else. */
function makeEnv(): { env: any; escalationInserts: number; careInserts: () => number } {
  const settings = new Map<string, string>();
  let careInserts = 0;
  const counters = { escalationInserts: 0 };
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => stmt(sql, binds),
        first: async () => firstFor(sql, []),
        all: async () => ({ results: [] }),
        run: async () => runFor(sql, []),
      }),
    },
  };
  function stmt(sql: string, binds: unknown[]) {
    return {
      first: async () => firstFor(sql, binds),
      all: async () => ({ results: [] }),
      run: async () => runFor(sql, binds),
    };
  }
  function firstFor(sql: string, _binds: unknown[]) {
    if (sql.includes("FROM biometric_snapshots")) return null;
    if (sql.includes("FROM routines")) return { at: null };
    return null;
  }
  function runFor(sql: string, binds: unknown[]) {
    if (sql.includes("INSERT OR IGNORE INTO companion_settings")) {
      if (!settings.has("care_tick_at")) settings.set("care_tick_at", "1970-01-01T00:00:00.000Z");
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE companion_settings")) {
      const [newVal, cutoff] = binds as [string, string];
      const cur = settings.get("care_tick_at")!;
      if (cur <= cutoff) {
        settings.set("care_tick_at", newVal);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("INSERT INTO care_actions")) { careInserts++; return { meta: { changes: 1 } }; }
    if (sql.includes("INSERT INTO care_escalations")) { counters.escalationInserts++; return { meta: { changes: 1 } }; }
    return { meta: { changes: 0 } };
  }
  return { env, get escalationInserts() { return counters.escalationInserts; }, careInserts: () => careInserts };
}

describe("care tick gate claim", () => {
  it("two same-instant ticks: exactly one proceeds, the other reports skipped", async () => {
    const { env } = makeEnv();
    const nowMs = Date.parse("2026-08-17T15:00:00Z");
    const [a, b] = [await runCareTick(env, nowMs), await runCareTick(env, nowMs)];
    const skipped = [a, b].filter(r => r.skipped === "gate");
    expect(skipped).toHaveLength(1);
  });

  it("the claim releases after the gate hour, and a new tick proceeds", async () => {
    const { env } = makeEnv();
    const t0 = Date.parse("2026-08-17T15:00:00Z");
    const first = await runCareTick(env, t0);
    expect(first.skipped).toBeUndefined();
    const early = await runCareTick(env, t0 + 30 * 60_000);
    expect(early.skipped).toBe("gate");
    const later = await runCareTick(env, t0 + 61 * 60_000);
    expect(later.skipped).toBeUndefined();
  });

  it("force skips the gate without consuming or stamping the claim", async () => {
    const { env } = makeEnv();
    const t0 = Date.parse("2026-08-17T15:00:00Z");
    await runCareTick(env, t0);
    const forced = await runCareTick(env, t0 + 60_000, { force: true });
    expect(forced.skipped).toBeUndefined();
    // the normal cadence is unaffected by the forced pass
    const later = await runCareTick(env, t0 + 61 * 60_000);
    expect(later.skipped).toBeUndefined();
  });
});
