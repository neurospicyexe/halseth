// Weekly budget (consequence layer C3, mig 0124). R2: 1 credit = 1 run, 7/week, Monday
// (Chicago) refill, NO rollover.
//
// The rails under test: replenish idempotency (unique week key), the no-rollover WINDOW
// (last week's unspent stops counting rather than being swept), refusal-with-reason at zero
// (scarcity is felt, never silently absorbed), and the denominator in every read.

import { describe, it, expect } from "vitest";
import { weekKeyChicago, ensureReplenished, readBudget, spendBudget, WEEKLY_CREDITS } from "../care/budget.js";

interface Row { companion_id: string; delta: number; reason: string; ref: string | null; created_at: string }

/** Stateful fake D1 for the ledger: recognizes the four SQL shapes budget.ts issues. */
function makeLedgerEnv(clock: { now: () => string }): { env: any; rows: Row[] } {
  const rows: Row[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => {
            if (sql.includes("SELECT 1 AS x")) {
              const [cid, ref] = binds as [string, string];
              return rows.find(r => r.companion_id === cid && r.reason === "replenish" && r.ref === ref) ? { x: 1 } : null;
            }
            if (sql.includes("SELECT created_at FROM companion_budget_entries")) {
              const [cid, ref] = binds as [string, string];
              const row = rows.find(r => r.companion_id === cid && r.reason === "replenish" && r.ref === ref);
              return row ? { created_at: row.created_at } : null;
            }
            throw new Error(`unexpected first(): ${sql}`);
          },
          all: async () => {
            if (sql.includes("SELECT reason, delta")) {
              const [cid, anchorAt] = binds as [string, string];
              return { results: rows.filter(r => r.companion_id === cid && r.created_at >= anchorAt).map(r => ({ reason: r.reason, delta: r.delta })) };
            }
            throw new Error(`unexpected all(): ${sql}`);
          },
          run: async () => {
            if (sql.includes("'replenish'")) {
              const [, cid, delta, ref] = binds as [string, string, number, string];
              if (!rows.find(r => r.companion_id === cid && r.reason === "replenish" && r.ref === ref)) {
                rows.push({ companion_id: cid, delta, reason: "replenish", ref, created_at: clock.now() });
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes("VALUES (?, ?, -1")) {
              const [, cid, reason, ref] = binds as [string, string, string, string | null];
              rows.push({ companion_id: cid, delta: -1, reason, ref, created_at: clock.now() });
              return { meta: { changes: 1 } };
            }
            throw new Error(`unexpected run(): ${sql}`);
          },
        }),
      }),
    },
  };
  return { env, rows };
}

describe("weekKeyChicago", () => {
  it("a Saturday belongs to the Monday that started its Chicago week", () => {
    expect(weekKeyChicago(new Date("2026-08-15T20:00:00-05:00"))).toBe("2026-08-10");
  });
  it("a Monday is its own week key, and Sunday still belongs to the PRIOR Monday", () => {
    expect(weekKeyChicago(new Date("2026-08-10T09:00:00-05:00"))).toBe("2026-08-10");
    expect(weekKeyChicago(new Date("2026-08-16T09:00:00-05:00"))).toBe("2026-08-10");
  });
  it("DST fall-back hour: Sun Nov 1 2026 23:30 CST still belongs to Monday Oct 26 (the phantom-Tuesday bug)", () => {
    // Pre-fix, the 24h walk-back shifted this instant onto TUESDAY 2026-10-27 and the
    // every-minute rider minted a phantom +7 that inflated the whole week's balance.
    expect(weekKeyChicago(new Date("2026-11-02T05:30:00Z"))).toBe("2026-10-26");
  });
  it("DST spring-forward week resolves to its own Monday", () => {
    // Sun Mar 8 2026 (spring forward) 10:00 CDT -> Monday Mar 2.
    expect(weekKeyChicago(new Date("2026-03-08T15:00:00Z"))).toBe("2026-03-02");
  });
  it("late Sunday UTC that is still Sunday in Chicago does not jump the week early", () => {
    // 2026-08-17T02:00Z is Sunday 21:00 in Chicago -- still last week.
    expect(weekKeyChicago(new Date("2026-08-17T02:00:00Z"))).toBe("2026-08-10");
  });
});

describe("budget ledger", () => {
  const week1 = new Date("2026-08-12T12:00:00-05:00"); // Wed of week 2026-08-10
  const week2 = new Date("2026-08-19T12:00:00-05:00"); // Wed of week 2026-08-17

  it("replenish is idempotent per week; the read states its denominator", async () => {
    const clock = { now: () => "2026-08-12 17:00:00" };
    const { env, rows } = makeLedgerEnv(clock);
    await ensureReplenished(env, "cypher", week1);
    await ensureReplenished(env, "cypher", week1);
    expect(rows.filter(r => r.reason === "replenish")).toHaveLength(1);
    const b = await readBudget(env, "cypher", week1);
    expect(b.remaining).toBe(WEEKLY_CREDITS);
    expect(b.total).toBe(WEEKLY_CREDITS);
    expect(b.week).toBe("2026-08-10");
  });

  it("spends to zero, then REFUSES with the reason in-band -- and the spent list carries purposes", async () => {
    let t = 0;
    const clock = { now: () => `2026-08-12 17:00:${String(t++).padStart(2, "0")}` };
    const { env } = makeLedgerEnv(clock);
    for (let i = 0; i < WEEKLY_CREDITS; i++) {
      const r = await spendBudget(env, "cypher", i % 2 === 0 ? "project" : "gift:raziel", `run-${i}`, week1);
      expect(r.ok).toBe(true);
    }
    const refused = await spendBudget(env, "cypher", "self", "run-8", week1);
    expect(refused.ok).toBe(false);
    expect((refused as { reason: string }).reason).toContain("Monday");
    const b = await readBudget(env, "cypher", week1);
    expect(b.remaining).toBe(0);
    expect(b.spent).toContainEqual({ purpose: "project", count: 4 });
    expect(b.spent).toContainEqual({ purpose: "gift:raziel", count: 3 });
  });

  it("NO rollover: an unspent week does not carry -- the new week is exactly 7 again", async () => {
    let now = "2026-08-12 17:00:00";
    const clock = { now: () => now };
    const { env } = makeLedgerEnv(clock);
    await spendBudget(env, "cypher", "self", "run-1", week1);
    expect((await readBudget(env, "cypher", week1)).remaining).toBe(WEEKLY_CREDITS - 1);
    now = "2026-08-19 17:00:00"; // the new week's replenish row lands with a later created_at
    const b2 = await readBudget(env, "cypher", week2);
    expect(b2.week).toBe("2026-08-17");
    expect(b2.remaining).toBe(WEEKLY_CREDITS); // not 7 + 6
  });
});
